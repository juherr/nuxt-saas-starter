// SPDX-License-Identifier: MIT
// No imports on purpose: scripts/backfill-api-key-organization.ts runs this
// module, directly and through apiKeyBackfill.ts, under plain Node (type
// stripping), outside Nuxt and its aliases.

const MAX_JSON_DECODES = 2

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the organization id that legacy API keys carried in their metadata.
 *
 * Accepts an already parsed object, a JSON string, or a JSON string of a
 * JSON string (the double encoding older clients produced). Anything else,
 * including a missing, non-string or blank `organizationId`, yields null:
 * there is no fuzzy fallback.
 */
export function parseLegacyOrganizationId(metadata: unknown): string | null {
  const raw = readOrganizationIdField(metadata)
  if (typeof raw !== 'string')
    return null
  const organizationId = raw.trim()
  return organizationId === '' ? null : organizationId
}

function readOrganizationIdField(metadata: unknown): unknown {
  let value = metadata
  for (let decodes = 0; typeof value === 'string' && decodes < MAX_JSON_DECODES; decodes++) {
    try {
      value = JSON.parse(value)
    }
    catch {
      return undefined
    }
  }
  return isRecord(value) ? value.organizationId : undefined
}

// Copy of API_KEY_MANAGER_ROLES in shared/utils/permissions.ts, which this
// module cannot import (see the top of the file).
const API_KEY_MANAGER_ROLES = ['owner', 'admin'] as const

/**
 * Whether a stored organization role, or one role of a role list, may
 * manage the organization's API keys. Another casing does not count.
 */
export function isApiKeyManagerRole(role: string | null | undefined): boolean {
  if (typeof role !== 'string')
    return false
  return role.split(',').some(entry => (API_KEY_MANAGER_ROLES as readonly string[]).includes(entry.trim()))
}
