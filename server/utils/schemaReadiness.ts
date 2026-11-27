// SPDX-License-Identifier: MIT

// The query /api/health runs. One round trip proves the database answers and
// tells whether the API key upgrade query
// (server/db/queries/api-key-organization-owner.postgresql.sql) has run: its
// foreign key deletes the keys of a deleted organization, and nothing else
// does. NuxtHub applies that query only on a build with a database URL,
// `nuxt db migrate` and `pnpm dev`, so a deploy can start without it.
export const SCHEMA_READINESS_SQL = `select exists (
  select 1 from pg_constraint
  where conname = 'api_key_reference_id_organization_id_fk'
    and conrelid = to_regclass('api_key')
    and contype = 'f'
    and confdeltype = 'c'
) as ready`

export const SCHEMA_NOT_READY_MESSAGE
  = 'the foreign key api_key_reference_id_organization_id_fk (ON DELETE CASCADE) is missing: '
    + 'the API key upgrade query has not run. Run `npx nuxt db migrate` with DATABASE_URL set, '
    + 'or build with DATABASE_URL (README, Upgrading to organization-owned API keys).'

/** Reads the rows of SCHEMA_READINESS_SQL. */
export const isSchemaReady = (rows: readonly unknown[]): boolean => {
  const row = rows[0]
  return typeof row === 'object' && row !== null && 'ready' in row && row.ready === true
}
