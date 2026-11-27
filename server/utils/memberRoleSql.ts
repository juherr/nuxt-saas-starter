// SPDX-License-Identifier: MIT
import type { SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { OrgRole } from '~~/shared/utils/permissions'
import { sql } from 'drizzle-orm'

// Only plain lowercase names, so the role can never act as a LIKE wildcard (`%`, `_`).
const ROLE_NAME = /^[a-z]+$/

/**
 * SQL counterpart of `hasOrgRole(column, [role])`: true when `role` is one of the
 * entries of the comma-separated role list stored in `column` (better-auth stores
 * `owner,admin`; spaces are stripped for rows written by hand or older versions).
 *
 * Built with `||`, not `concat()`: on a NULL column the predicate is NULL, so neither
 * it nor its `not(...)` selects the row. A delete under `not(...)` keeps a NULL-role
 * row, as `ne(column, role)` did before; `concat()` would make it delete that row.
 * The pattern is a bound parameter; no regex, so no backslash has to survive.
 */
export function memberHasRoleSql(column: PgColumn, role: OrgRole): SQL {
  if (!ROLE_NAME.test(role))
    throw new Error(`Invalid organization role name: ${role}`)
  return sql`(',' || replace(${column}, ' ', '') || ',' like ${`%,${role},%`})`
}
