// SPDX-License-Identifier: MIT
import { eq } from 'drizzle-orm'
import { apiKey } from '~~/server/db/schema'
import { requireApiKeyManager } from '~~/server/utils/apiKeyAccess'
import { requireAuthSession } from '~~/server/utils/billing'
import { useDB } from '~~/server/utils/db'

const keyNotFound = () => createError({ statusCode: 404, statusMessage: 'API key not found' })

/**
 * Revokes a key of an organization the caller manages. The key's
 * organization is its reference_id. An unknown key, another
 * organization's key, a key whose reference_id is not an organization the
 * caller manages (such as a key referencing a user) and a caller who does
 * not manage the key's organization all get the same 404, checked before
 * anything is deleted.
 */
export default defineEventHandler(async (event) => {
  await requireAuthSession(event)

  const keyId = getRouterParam(event, 'id')
  if (!keyId) {
    throw createError({ statusCode: 400, statusMessage: 'Key ID is required' })
  }

  const db = await useDB()
  const key = await db.query.apiKey.findFirst({
    columns: { id: true, referenceId: true },
    where: eq(apiKey.id, keyId)
  })
  if (!key) {
    throw keyNotFound()
  }

  try {
    await requireApiKeyManager(event, key.referenceId)
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 403) {
      throw keyNotFound()
    }
    throw error
  }

  await db.delete(apiKey).where(eq(apiKey.id, keyId))

  return { success: true }
})
