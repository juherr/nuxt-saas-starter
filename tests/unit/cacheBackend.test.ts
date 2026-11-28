// SPDX-License-Identifier: MIT
import type { Redis } from 'ioredis'
import { randomUUID } from 'node:crypto'
import { createStorage } from 'unstorage'
import redisDriver from 'unstorage/drivers/redis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCacheClient } from '~~/server/utils/cacheBackend'
import { createRedisClient } from '~~/server/utils/redis'

// Records the commands cacheClient sends, over an in-memory map.
const recordingRedis = () => {
  const data = new Map<string, string>()
  const commands: unknown[][] = []
  return {
    commands,
    get: vi.fn(async (key: string) => {
      commands.push(['get', key])
      return data.get(key) ?? null
    }),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      commands.push(['set', key, value, ...args])
      data.set(key, value)
      return 'OK' as const
    }),
    unlink: vi.fn(async (key: string) => {
      commands.push(['unlink', key])
      return data.delete(key) ? 1 : 0
    })
  }
}

const hubKvStub = () => {
  const entries = new Map<string, unknown>()
  return {
    entries,
    get: vi.fn(async (key: string) => entries.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown, _options?: { ttl?: number }) => {
      entries.set(key, value)
    }),
    del: vi.fn(async (key: string) => {
      entries.delete(key)
    })
  }
}

describe('createCacheClient without Redis', () => {
  it('keeps hub:kv when no Redis client is available', async () => {
    const kv = hubKvStub()
    const client = createCacheClient({ kv, redis: async () => null })

    await client.set('session-token', '{"id":"s1"}', 60)
    await client.set('no-ttl', 'v', undefined)

    expect(kv.set).toHaveBeenNthCalledWith(1, 'session-token', '{"id":"s1"}', { ttl: 60 })
    expect(kv.set).toHaveBeenNthCalledWith(2, 'no-ttl', 'v', undefined)
    expect(await client.get('session-token')).toBe('{"id":"s1"}')
    await client.delete('session-token')
    expect(kv.del).toHaveBeenCalledWith('session-token')
    expect(await client.get('session-token')).toBeNull()
  })

  it('returns hub:kv values parsed by unstorage as JSON text', async () => {
    const kv = hubKvStub()
    kv.entries.set('parsed', { id: 's1' })
    const client = createCacheClient({ kv, redis: async () => null })

    expect(await client.get('parsed')).toBe('{"id":"s1"}')
  })
})

describe('createCacheClient with Redis', () => {
  it('sends GET, SET with EX and UNLINK to Redis and never touches hub:kv', async () => {
    const kv = hubKvStub()
    const redis = recordingRedis()
    const client = createCacheClient({ kv, redis: async () => redis })

    await client.set('session-token', '{"id":"s1"}', 60)
    await client.set('no-ttl', 'v', undefined)
    expect(await client.get('session-token')).toBe('{"id":"s1"}')
    await client.delete('session-token')
    expect(await client.get('session-token')).toBeNull()

    expect(redis.commands).toEqual([
      ['set', 'session-token', '{"id":"s1"}', 'EX', 60],
      ['set', 'no-ttl', 'v'],
      ['get', 'session-token'],
      ['unlink', 'session-token'],
      ['get', 'session-token']
    ])
    expect(kv.get).not.toHaveBeenCalled()
    expect(kv.set).not.toHaveBeenCalled()
    expect(kv.del).not.toHaveBeenCalled()
  })

  it('normalizes keys as unstorage does', async () => {
    const redis = recordingRedis()
    const client = createCacheClient({ kv: hubKvStub(), redis: async () => redis })

    await client.get('slash/and\\backslash')
    await client.get(':edges:')
    await client.get('double::colon')
    await client.get('with?query')

    expect(redis.commands).toEqual([
      ['get', 'slash:and:backslash'],
      ['get', 'edges'],
      ['get', 'double:colon'],
      ['get', 'with']
    ])
  })

  it('refuses the keys unstorage refuses', async () => {
    const client = createCacheClient({ kv: hubKvStub(), redis: async () => recordingRedis() })

    await expect(client.set(':', 'v', 1)).rejects.toThrow(/Invalid key/)
    await expect(client.get('a:..:b')).rejects.toThrow(/Invalid key/)
  })

  it('picks its backend once, on first use', async () => {
    const redis = recordingRedis()
    const resolve = vi.fn(async () => redis)
    const client = createCacheClient({ kv: hubKvStub(), redis: resolve })

    expect(resolve).not.toHaveBeenCalled()
    await Promise.all([client.get('a'), client.set('b', 'v', 1), client.delete('c')])
    await client.get('d')

    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('still refuses getAndDelete and increment', async () => {
    const redis = recordingRedis()
    const client = createCacheClient({ kv: hubKvStub(), redis: async () => redis })

    await expect(client.getAndDelete('k')).rejects.toThrow(/not supported/)
    await expect(client.increment('k', 60)).rejects.toThrow(/not supported/)
    expect(redis.commands).toEqual([])
  })
})

describe('createCacheClient backend log', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['Redis', recordingRedis, 'sessions: Redis (REDIS_URL at run time)'],
    ['hub:kv', () => null, 'sessions: hub:kv']
  ])('logs %s once per client, on first use', async (_name, redis, line) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const first = createCacheClient({ kv: hubKvStub(), redis: async () => redis() })

    expect(info).not.toHaveBeenCalled()
    await Promise.all([first.get('a'), first.set('b', 'v', 1), first.delete('c')])
    await first.get('d')
    expect(info.mock.calls).toEqual([[line]])

    const second = createCacheClient({ kv: hubKvStub(), redis: async () => redis() })
    await second.get('a')
    expect(info.mock.calls).toEqual([[line], [line]])
  })
})

// A deployment built with REDIS_URL stores its sessions through hub:kv,
// that is unstorage's redis driver with no `base` (nuxt.config.ts sets
// `hub.kv: true`, NuxtHub 0.10 passes only `url`). The run-time client must
// read and write the same keys, values and TTLs, or those sessions are lost
// on upgrade. Runs against the real Redis of REDIS_URL, compared with the
// real driver; CI provides one, so there the suite fails instead of skipping.
const redisUrl = process.env.REDIS_URL
const inCi = !!process.env.CI

describe.skipIf(!redisUrl && !inCi)('the Redis key format, against hub:kv on Redis', () => {
  const prefix = `kv-format-${randomUUID()}`
  let redis: Redis | null = null
  let hubKv: ReturnType<typeof createStorage> | null = null

  beforeAll(async () => {
    expect(redisUrl, 'REDIS_URL must be set when CI is set').toBeTruthy()
    redis = redisUrl ? await createRedisClient(redisUrl) : null
    hubKv = createStorage({ driver: redisDriver({ url: redisUrl }) })
  })

  afterAll(async () => {
    const keys = await redis?.keys(`${prefix}*`) ?? []
    if (keys.length > 0) {
      await redis?.del(...keys)
    }
    await redis?.quit()
    await hubKv?.dispose()
  })

  const connected = () => {
    if (!redis || !hubKv) {
      throw new Error('REDIS_URL must be set when CI is set')
    }
    return { redis, hubKv, client: createCacheClient({ kv: hubKvStub(), redis: async () => redis }) }
  }

  // [key given by better-auth, key stored in Redis]
  const keys = [
    ['session', 'session'],
    ['active-sessions-user_42', 'active-sessions-user_42'],
    ['nested:key', 'nested:key'],
    ['slash/and\\back', 'slash:and:back'],
    ['double::colon', 'double:colon']
  ]

  it.each(keys)('reads %j where hub:kv wrote it, as %j, with the same TTL', async (suffix, stored) => {
    const { redis, hubKv, client } = connected()
    const hubKey = `${prefix}-hub-${suffix}`
    const ownKey = `${prefix}-own-${suffix}`

    await hubKv.setItem(hubKey, '{"id":"s1"}', { ttl: 60 })
    await client.set(ownKey, '{"id":"s1"}', 60)

    expect(await client.get(hubKey)).toBe('{"id":"s1"}')
    expect(await hubKv.getItem(ownKey)).toEqual({ id: 's1' })
    const rawKeys = (await redis.keys(`${prefix}-*-${stored}`)).sort()
    expect(rawKeys).toEqual([`${prefix}-hub-${stored}`, `${prefix}-own-${stored}`])
    for (const key of rawKeys) {
      const ttl = await redis.ttl(key)
      expect(ttl).toBeGreaterThan(50)
      expect(ttl).toBeLessThanOrEqual(60)
    }
  })

  it('deletes a key hub:kv wrote, and keeps one written without a TTL', async () => {
    const { redis, hubKv, client } = connected()

    await hubKv.setItem(`${prefix}-del`, 'v')
    await client.delete(`${prefix}-del`)
    await client.set(`${prefix}-forever`, 'v', undefined)

    expect(await hubKv.hasItem(`${prefix}-del`)).toBe(false)
    expect(await redis.ttl(`${prefix}-forever`)).toBe(-1)
  })
})
