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

/**
 * Reads the organization id an API key creation request names, decoding
 * the metadata as `parseLegacyOrganizationId` does but without trimming:
 * the key keeps the metadata as sent, so the organization checked and
 * linked must be exactly the one stored. An id that is not a non-empty
 * string equal to its trimmed value yields null.
 */
export function parseRequestedOrganizationId(metadata: unknown): string | null {
  const raw = readOrganizationIdField(metadata)
  if (typeof raw !== 'string' || raw === '' || raw !== raw.trim())
    return null
  return raw
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

/**
 * Organization roles that may create, list and revoke the organization's
 * API keys. A role list such as `member,admin` counts when it holds one
 * of them; another casing (`Admin`) does not.
 */
export const API_KEY_MANAGER_ROLES = ['owner', 'admin'] as const

export function isApiKeyManagerRole(role: string | null | undefined): boolean {
  // Same parse as hasRole in shared/utils/permissions.ts, which this
  // module cannot import (see the top of the file); a test keeps them equal.
  if (typeof role !== 'string')
    return false
  return role.split(',').some(entry => (API_KEY_MANAGER_ROLES as readonly string[]).includes(entry.trim()))
}

/**
 * The id of the key an API key creation returned, or null when it
 * returned an error or anything without a usable id. Reads the id only:
 * the same object carries the plaintext key, which must not be kept.
 */
export function createdApiKeyId(returned: unknown): string | null {
  if (!isRecord(returned) || returned instanceof Error)
    return null
  return typeof returned.id === 'string' && returned.id !== '' ? returned.id : null
}
