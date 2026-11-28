// SPDX-License-Identifier: MIT
import type { Hyperdrive } from '@cloudflare/workers-types'
import { kv } from 'hub:kv'
import pg from 'pg'
import { Resend } from 'resend'
import { createCacheClient } from './cacheBackend'
import { databaseConnectTimeoutMs } from './databaseConnectTimeout'
import { getRedisClient } from './redis'
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
// better-auth secondary storage (sessions). On node-server it uses Redis
// when the run environment carries a Redis URL (resolveRedisUrl), whatever
// hub:kv was built with; otherwise hub:kv (fs-lite, or the KV binding on
// Cloudflare, where ioredis is never loaded). See cacheBackend.ts.
export const cacheClient = createCacheClient({
  kv,
  redis: async () => runtimeConfig.preset === 'node-server' ? getRedisClient() : null
})

let resendClient: Resend | undefined

// Email is optional: the Resend SDK throws without an API key, so the client
// is only created, on first use, when a key is configured.
export const getResendClient = () => {
  if (!resendClient && runtimeConfig.resendApiKey) {
    resendClient = new Resend(runtimeConfig.resendApiKey)
  }
  return resendClient
}
