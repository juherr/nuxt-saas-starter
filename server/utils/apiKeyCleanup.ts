// SPDX-License-Identifier: MIT
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '~~/server/db/schema'
import { eq } from 'drizzle-orm'
import { apiKey } from '~~/server/db/schema'

/**
 * Deletes the API keys of an organization that is about to be deleted.
 * api_key.reference_id has no foreign key to organization
 * (@better-auth/api-key schema), so without this the keys would stay
 * enabled with no organization to list or revoke them. Errors propagate
 * so that the organization deletion stops instead of leaving such keys.
 */
export async function deleteOrganizationApiKeys(
  db: Pick<NodePgDatabase<typeof schema>, 'delete'>,
  organizationId: string
) {
  await db.delete(apiKey).where(eq(apiKey.referenceId, organizationId))
}
