// SPDX-License-Identifier: MIT
import type { H3Event } from 'h3'
import { API_KEY_MANAGER_ROLES } from '~~/shared/utils/permissions'
import { requireOrganizationRole } from './billing'

/**
 * Requires a caller who may manage the organization's API keys: exact
 * stored role `owner` or `admin`. Anonymous callers get 401; an ordinary
 * member and a non-member get the same 403.
 */
export function requireApiKeyManager(event: H3Event, organizationId: string) {
  return requireOrganizationRole(event, organizationId, API_KEY_MANAGER_ROLES)
}
