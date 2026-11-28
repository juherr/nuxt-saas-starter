// SPDX-License-Identifier: MIT
import type { BetterAuthOptions } from 'better-auth'
import { cacheClient } from './drivers'

// Sessions go to cacheClient (Redis or hub:kv), but whatever needs an atomic
// consume or counter stays in PostgreSQL, since cacheClient refuses
// getAndDelete and increment:
// - verification.storeInDatabase: single-use tokens are consumed with a
//   DELETE ... RETURNING instead of secondaryStorage.getAndDelete;
// - rateLimit.storage 'database': a conditional UPDATE on the rateLimit
//   table instead of secondaryStorage.increment (the default whenever a
//   secondaryStorage is set). The auth schema generator adds that table
//   only when it sees this option.
// https://better-auth.com/docs/reference/options
// https://better-auth.com/docs/concepts/rate-limit
export const authStorageOptions = {
  secondaryStorage: cacheClient,
  verification: {
    storeInDatabase: true
  },
  rateLimit: {
    storage: 'database'
  }
} as const satisfies Pick<BetterAuthOptions, 'secondaryStorage' | 'verification' | 'rateLimit'>
