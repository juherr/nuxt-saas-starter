// SPDX-License-Identifier: MIT
import type { RateLimitStore } from '~~/server/services/file/rateLimiter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitUnavailableError, UploadRateLimiter } from '~~/server/services/file/rateLimiter'
import { createLockedKvStore, createRedisStore, KeyedLock } from '~~/server/services/file/rateLimitStores'
import { createCacheClient } from '~~/server/utils/cacheBackend'
// Same module as the aliased `hub:kv`, imported by path for its test helpers.
import { kv, kvSetCalls, resetKvStub } from './stubs/hub-kv'

const WINDOW_MINUTES = 10
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000
// Start of a bucket, so tests can place hits at known offsets in the window.
const BUCKET_START = Math.ceil(Date.UTC(2026, 0, 1) / WINDOW_MS) * WINDOW_MS

// cacheClient as drivers.ts builds it without a Redis URL: on hub:kv. The
// real one would pick Redis when REDIS_URL is set, as in the CI unit job.
const cacheClient = createCacheClient({ kv, redis: async () => null })

describe('the upload rate limiter on the in-process path', () => {
  // Passed explicitly: the default store would pick Redis when REDIS_URL is set.
  let store: RateLimitStore
  const limiter = (max: number) => new UploadRateLimiter(WINDOW_MINUTES, max, store)

  beforeEach(() => {
    resetKvStub()
    store = createLockedKvStore(cacheClient)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(BUCKET_START)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('accepts exactly max out of 50 concurrent requests', async () => {
    // One limiter per request, as the upload route builds them.
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter(5).checkAndIncrement('user-concurrent'))
    )

    expect(results.filter(r => r.allowed)).toHaveLength(5)
    expect(await limiter(5).getCurrentCount('user-concurrent')).toBe(5)
  })

  it('accepts up to max and refuses the next request with the count excluding it', async () => {
    const results = []
    for (let i = 0; i < 4; i++) {
      results.push(await limiter(3).checkAndIncrement('user-threshold'))
    }

    expect(results).toEqual([
      { allowed: true, currentCount: 1 },
      { allowed: true, currentCount: 2 },
      { allowed: true, currentCount: 3 },
      { allowed: false, currentCount: 3 }
    ])
  })

  it('reserves a batch whole or refuses it without consuming any of it', async () => {
    await limiter(5).checkAndIncrement('user-batch', 3)

    expect(await limiter(5).checkAndIncrement('user-batch', 3)).toEqual({ allowed: false, currentCount: 3 })
    expect(await limiter(5).checkAndIncrement('user-batch', 2)).toEqual({ allowed: true, currentCount: 5 })
  })

  it('starts a new count in the next window', async () => {
    await limiter(1).checkAndIncrement('user-window')
    vi.setSystemTime(BUCKET_START + WINDOW_MS)

    expect(await limiter(1).checkAndIncrement('user-window')).toEqual({ allowed: true, currentCount: 1 })
  })

  it('pins the expiry to the end of the bucket instead of extending it on later hits', async () => {
    vi.setSystemTime(BUCKET_START + 2 * 60 * 1000)
    await limiter(5).checkAndIncrement('user-ttl')
    vi.setSystemTime(BUCKET_START + 5 * 60 * 1000)
    await limiter(5).checkAndIncrement('user-ttl')

    expect(kvSetCalls.map(c => c.options)).toEqual([{ ttl: 8 * 60 }, { ttl: 5 * 60 }])
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s as incrementBy without consuming', async (amount) => {
    await expect(limiter(5).checkAndIncrement('user-invalid', amount)).rejects.toThrow(RangeError)
    expect(kvSetCalls).toEqual([])
  })

  it('fails closed with a distinct error when the store errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(cacheClient, 'get').mockRejectedValueOnce(new Error('kv down'))

    await expect(limiter(5).checkAndIncrement('user-error')).rejects.toThrow(RateLimitUnavailableError)
  })

  it('fails closed on a corrupt counter', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await cacheClient.set(`upload_rate_limit:user-corrupt:${BUCKET_START / WINDOW_MS}`, 'garbage', 60)

    await expect(limiter(5).checkAndIncrement('user-corrupt')).rejects.toThrow(RateLimitUnavailableError)
  })

  it('lets the next request for a key through after a store error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(cacheClient, 'get').mockRejectedValueOnce(new Error('kv down'))

    const [failed, next] = await Promise.allSettled([
      limiter(5).checkAndIncrement('user-recover'),
      limiter(5).checkAndIncrement('user-recover')
    ])

    expect(failed).toMatchObject({ status: 'rejected', reason: expect.any(RateLimitUnavailableError) })
    expect(next).toEqual({ status: 'fulfilled', value: { allowed: true, currentCount: 1 } })
  })

  it('propagates store errors from getCurrentCount instead of reading 0', async () => {
    vi.spyOn(cacheClient, 'get').mockRejectedValueOnce(new Error('kv down'))

    await expect(limiter(5).getCurrentCount('user-count')).rejects.toThrow('kv down')
  })
})

describe('the per-key lock', () => {
  it('runs sections for one key one at a time and forgets the key once idle', async () => {
    const lock = new KeyedLock()
    const order: string[] = []
    const section = (name: string, fail = false) => lock.run('k', async () => {
      order.push(`${name}:start`)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(`${name}:end`)
      if (fail) {
        throw new Error(name)
      }
    })

    const results = await Promise.allSettled([section('a', true), section('b'), section('c')])

    expect(results.map(r => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
    expect(lock.size).toBe(0)
  })
})

describe('the upload rate limiter on the Redis path', () => {
  it('fails closed with a distinct error when Redis errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const redis = {
      eval: vi.fn().mockRejectedValue(new Error('Command timed out')),
      get: vi.fn()
    }
    const limiter = new UploadRateLimiter(WINDOW_MINUTES, 5, createRedisStore(redis))

    await expect(limiter.checkAndIncrement('user-redis-down')).rejects.toThrow(RateLimitUnavailableError)
    vi.restoreAllMocks()
  })

  it('passes the time left in the bucket as the expiry in milliseconds', async () => {
    const redis = { eval: vi.fn().mockResolvedValue([1, 1, 1000]), get: vi.fn() }
    const limiter = new UploadRateLimiter(WINDOW_MINUTES, 5, createRedisStore(redis), () => BUCKET_START + 1000)

    await limiter.checkAndIncrement('user-redis-ttl', 2)

    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, `upload_rate_limit:user-redis-ttl:${BUCKET_START / WINDOW_MS}`, 2, 5, WINDOW_MS - 1000)
  })

  it.each(['garbage', '-1', '1.5'])('rejects a corrupt counter %s on read instead of returning it', async (raw) => {
    const redis = { eval: vi.fn(), get: vi.fn().mockResolvedValue(raw) }
    const limiter = new UploadRateLimiter(WINDOW_MINUTES, 5, createRedisStore(redis), () => BUCKET_START)

    await expect(limiter.getCurrentCount('user-redis-corrupt')).rejects.toThrow('Invalid rate limit counter')
  })
})

describe('the upload rate limiter configuration', () => {
  const store: RateLimitStore = { reserve: vi.fn(), read: vi.fn() }

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a window of %s minutes', (minutes) => {
    expect(() => new UploadRateLimiter(minutes, 5, store)).toThrow(RangeError)
  })

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects a limit of %s uploads', (max) => {
    expect(() => new UploadRateLimiter(WINDOW_MINUTES, max, store)).toThrow(RangeError)
  })

  it('accepts a fractional window, which runtime config can supply', () => {
    expect(() => new UploadRateLimiter(0.5, 5, store)).not.toThrow()
  })
})
