// SPDX-License-Identifier: MIT
import { eq } from 'drizzle-orm'
import { apiKey } from '~~/server/db/schema'
import { toApiKeyDto } from '~~/server/utils/apiKeyDto'
import { requireAuthSession, requireOrganizationPermission } from '~~/server/utils/billing'
import { useDB } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  await requireAuthSession(event)

  const { organizationId } = getQuery(event)
  if (typeof organizationId !== 'string' || !organizationId) {
    throw createError({ statusCode: 400, statusMessage: 'Organization ID is required' })
  }

  await requireOrganizationPermission(event, organizationId, { apiKey: ['read'] })

  // The API key plugin stores the owning organization's id in reference_id.
  // Keys created before organization ownership reference their creator's
  // user id instead, so they are never listed.
  const db = await useDB()
  const rows = await db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      start: apiKey.start,
      prefix: apiKey.prefix,
      enabled: apiKey.enabled,
      createdAt: apiKey.createdAt,
      lastRequest: apiKey.lastRequest,
      expiresAt: apiKey.expiresAt
    })
    .from(apiKey)
    .where(eq(apiKey.referenceId, organizationId))

  return rows.map(toApiKeyDto)
})
