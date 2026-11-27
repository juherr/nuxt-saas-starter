// SPDX-License-Identifier: MIT
import { index, pgTable, text } from 'drizzle-orm/pg-core'
import { apiKey, organization } from './auth'

// Deprecated: the organization of an API key before keys became
// organization-owned (api_key.reference_id). The application no longer reads
// or writes it; only the upgrade query
// server/db/queries/api-key-organization-owner.postgresql.sql reads it, to
// move each linked key to its organization. It stays declared so that
// `pnpm db:generate` emits no DROP TABLE before that query has run on every
// deployment. Removed by #162 (contract phase).
export const apiKeyOrganization = pgTable(
  'api_key_organization',
  {
    apiKeyId: text('api_key_id')
      .primaryKey()
      .references(() => apiKey.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' })
  },
  table => [
    index('api_key_organization_organizationId_idx').on(table.organizationId)
  ]
)
