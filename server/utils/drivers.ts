// SPDX-License-Identifier: MIT
import type { Hyperdrive } from '@cloudflare/workers-types'
import { kv } from 'hub:kv'
import pg from 'pg'
import { Resend } from 'resend'
import { databaseConnectTimeoutMs } from './databaseConnectTimeout'
import { runtimeConfig } from './runtimeConfig'

const getDatabaseUrl = () => {
  // @ts-expect-error globalThis.__env__ is not defined
  const hyperdrive = (process.env.HYPERDRIVE || globalThis.__env__?.HYPERDRIVE || globalThis.HYPERDRIVE) as Hyperdrive | undefined
  // Use Hyperdrive if available (prod Cloudflare), otherwise DATABASE_URL
  return hyperdrive?.connectionString || runtimeConfig.databaseUrl
}

// True when a PostgreSQL connection is configured (Hyperdrive or a URL).
// Without one, pg would silently fall back to localhost defaults.
export const isDatabaseConfigured = () => !!getDatabaseUrl()

const createPgPool = () => new pg.Pool({
  connectionString: getDatabaseUrl(),
  // A node-server process shares one pool. 90 connections from a single
  // process nearly exhausts PostgreSQL's default max_connections (100).
  max: 10,
  idleTimeoutMillis: 30000,
  // Without it, pg waits forever on an unreachable database. A runtime
  // override that does not parse arrives as a string: re-check it here.
  connectionTimeoutMillis: databaseConnectTimeoutMs(runtimeConfig.databaseConnectTimeoutMs)
})

let pgPool: pg.Pool

// PG Pool
export const getPgPool = () => {
  if (runtimeConfig.preset == 'node-server') {
    if (!pgPool) {
      pgPool = createPgPool()
    }
    return pgPool
  } else {
    return createPgPool()
  }
}

// Cache Client
const unsupported = (method: string) => new Error(
  `cacheClient.${method} is not supported: hub:kv cannot run it atomically `
  + 'on every driver. Keep its caller on the database (see authStorage.ts).'
)

// better-auth secondary storage. better-auth 1.7 types getAndDelete and
// increment as required, but hub:kv only offers them atomically on Redis
// and Upstash, not on Cloudflare KV or fs-lite. A read-then-write version
// would let a single-use token be consumed twice and a rate limit be
// undercounted, so both throw and authStorageOptions keeps their callers
// (verification consume, rate limit) on the database.
export const cacheClient = {
  get: async (key: string) => {
    const value = await kv.get(key)
    if (value == null) {
      return null
    }
    return typeof value === 'string' ? value : JSON.stringify(value)
  },
  set: async (key: string, value: string, ttl: number | undefined) => {
    await kv.set(key, value, ttl ? { ttl } : undefined)
  },
  delete: async (key: string) => {
    await kv.del(key)
  },
  getAndDelete: async (_key: string): Promise<string | null> => {
    throw unsupported('getAndDelete')
  },
  increment: async (_key: string, _ttl: number): Promise<number> => {
    throw unsupported('increment')
  }
}

let resendClient: Resend | undefined

// Email is optional: the Resend SDK throws without an API key, so the client
// is only created, on first use, when a key is configured.
export const getResendClient = () => {
  if (!resendClient && runtimeConfig.resendApiKey) {
    resendClient = new Resend(runtimeConfig.resendApiKey)
  }
  return resendClient
}
