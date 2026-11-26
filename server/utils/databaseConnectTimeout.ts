// SPDX-License-Identifier: MIT
// No imports on purpose: create-admin.ts runs this module under plain Node
// (type stripping), outside Nuxt and its aliases.

export const DEFAULT_DATABASE_CONNECT_TIMEOUT_MS = 10000

/**
 * Time a PostgreSQL connection may take before pg gives up
 * (`connectionTimeoutMillis`), from `NUXT_DATABASE_CONNECT_TIMEOUT_MS`.
 *
 * pg waits forever when the option is unset or 0, so an unreachable database
 * hangs the request or the script. Anything that is not a positive number of
 * milliseconds falls back to the default rather than lifting the bound.
 */
export function databaseConnectTimeoutMs(value: unknown): number {
  const ms = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0
    ? ms
    : DEFAULT_DATABASE_CONNECT_TIMEOUT_MS
}
