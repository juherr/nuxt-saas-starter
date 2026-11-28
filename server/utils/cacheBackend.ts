// SPDX-License-Identifier: MIT
import { hasDotSegment, normalizeKey } from 'unstorage'

/** The part of NuxtHub's `hub:kv` storage that cacheClient uses. */
export interface KvStorage {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: string, options?: { ttl: number }) => Promise<unknown>
  del: (key: string) => Promise<unknown>
}

/** The ioredis commands cacheClient sends. */
export interface RedisCommands {
  get: (key: string) => Promise<string | null>
  set: {
    (key: string, value: string): Promise<unknown>
    (key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>
  }
  unlink: (key: string) => Promise<number>
}

/**
 * Redis key under which `hub:kv` on Redis stores `key`. NuxtHub builds that
 * driver as unstorage's `redis` driver without a `base` (nuxt.config.ts sets
 * `hub.kv: true`): unstorage normalizes the key (drops a `?` suffix, turns
 * `/` and `\` into `:`, collapses and trims `:`, refuses `.`/`..` segments)
 * and the driver joins it to an empty base, which leaves it as is. Writing
 * the same key keeps the sessions of a deployment built with REDIS_URL.
 */
const redisKey = (key: string): string => {
  const normalized = normalizeKey(key)
  if (!normalized || hasDotSegment(normalized)) {
    throw new Error(`[unstorage] Invalid key: ${JSON.stringify(key)}`)
  }
  return normalized
}

const unsupported = (method: string) => new Error(
  `cacheClient.${method} is not supported: hub:kv cannot run it atomically `
  + 'on every driver. Keep its caller on the database (see authStorage.ts).'
)

interface Backend {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, ttl: number | undefined) => Promise<void>
  delete: (key: string) => Promise<void>
}

const kvBackend = (kv: KvStorage): Backend => ({
  get: async (key) => {
    const value = await kv.get(key)
    if (value == null) {
      return null
    }
    // unstorage parses JSON text on read (destr): give better-auth text back.
    return typeof value === 'string' ? value : JSON.stringify(value)
  },
  set: async (key, value, ttl) => {
    await kv.set(key, value, ttl ? { ttl } : undefined)
  },
  delete: async (key) => {
    await kv.del(key)
  }
})

// Same commands as unstorage's redis driver: GET, SET with EX for a TTL,
// UNLINK.
const redisBackend = (redis: RedisCommands): Backend => ({
  get: async key => redis.get(redisKey(key)),
  set: async (key, value, ttl) => {
    if (ttl) {
      await redis.set(redisKey(key), value, 'EX', ttl)
    } else {
      await redis.set(redisKey(key), value)
    }
  },
  delete: async (key) => {
    await redis.unlink(redisKey(key))
  }
})

/**
 * better-auth secondary storage over Redis when `redis()` gives a client,
 * else over `hub:kv`. The backend is chosen once, on first use, so a
 * deployment picks Redis from its run environment rather than its build.
 *
 * better-auth 1.7 types getAndDelete and increment as required, but hub:kv
 * only offers them atomically on Redis and Upstash, not on Cloudflare KV or
 * fs-lite. A read-then-write version would let a single-use token be
 * consumed twice and a rate limit be undercounted, so both throw and
 * authStorageOptions keeps their callers (verification consume, rate limit)
 * on the database, whatever the backend.
 */
export const createCacheClient = ({ kv, redis }: {
  kv: KvStorage
  redis: () => Promise<RedisCommands | null>
}) => {
  let backend: Promise<Backend> | undefined
  const pick = () => {
    backend ??= redis().then((client) => {
      // Once per client: says which store holds the sessions of this run.
      if (client) {
        console.info('sessions: Redis (REDIS_URL at run time)')
        return redisBackend(client)
      }
      console.info('sessions: hub:kv')
      return kvBackend(kv)
    })
    return backend
  }
  return {
    get: async (key: string) => (await pick()).get(key),
    set: async (key: string, value: string, ttl: number | undefined) => (await pick()).set(key, value, ttl),
    delete: async (key: string) => (await pick()).delete(key),
    getAndDelete: async (_key: string): Promise<string | null> => {
      throw unsupported('getAndDelete')
    },
    increment: async (_key: string, _ttl: number): Promise<number> => {
      throw unsupported('increment')
    }
  }
}
