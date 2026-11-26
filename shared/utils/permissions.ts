// SPDX-License-Identifier: MIT
import { createAccessControl } from 'better-auth/plugins/access'

// ============================================
// BETTER AUTH ACCESS CONTROL
// ============================================
const statement = {
  organization: ['update', 'delete', 'view', 'leave'],
  member: ['create', 'update', 'delete', 'view'],
  invitation: ['create', 'cancel', 'resend'],
  billing: ['manage', 'view'],
  settings: ['view', 'update']
} as const

export const ac = createAccessControl(statement)

export const member = ac.newRole({
  organization: ['view', 'leave'],
  member: ['view'],
  settings: ['view']
})

export const admin = ac.newRole({
  organization: ['update', 'view', 'leave'],
  member: ['create', 'update', 'delete', 'view'],
  invitation: ['create', 'cancel', 'resend'],
  settings: ['view', 'update']
})

export const owner = ac.newRole({
  organization: ['update', 'delete', 'view'],
  member: ['create', 'update', 'delete', 'view'],
  invitation: ['create', 'cancel', 'resend'],
  billing: ['manage', 'view'],
  settings: ['view', 'update']
})

// ============================================
// ROLE DEFINITIONS
// ============================================
export type OrgRole = 'owner' | 'admin' | 'member'

// ============================================
// SUBSCRIPTION PLANS & LIMITS
// ============================================
export type SubscriptionStatus = 'active' | 'trialing' | 'canceled' | 'incomplete' | 'past_due' | null

export interface PlanLimits {
  maxOrganizations?: number
  maxMembers?: number
  maxProjects?: number
  maxStorage?: number
  // Add more limits as needed
}

export const PLAN_LIMITS = {
  FREE: {
    maxOrganizations: 1, // Only 1 free org allowed per user
    maxMembers: 1,
    maxProjects: 3,
    maxStorage: 1 // GB
  },
  PRO: {
    // Note: Each additional organization requires its own Pro subscription
    // This is a per-organization limit, not a user-wide limit
    maxMembers: Infinity,
    maxProjects: Infinity,
    maxStorage: 100 // GB
  }
} as const

/**
 * Check if user has an active Pro subscription
 */
export function hasProSubscription(
  status: SubscriptionStatus
): boolean {
  return status === 'active' || status === 'trialing'
}

/**
 * Get plan limits based on subscription status
 * @deprecated Use getPlanLimits from plans.ts for plan ID-based limits
 */
export function getLimitsByStatus(
  status: SubscriptionStatus
): PlanLimits {
  return hasProSubscription(status) ? PLAN_LIMITS.PRO : PLAN_LIMITS.FREE
}

/**
 * Check if feature is available based on subscription status
 * Note: Each organization requires its own Pro subscription.
 * This checks features within a single organization.
 * @deprecated Use canAccessFeature from plans.ts for plan ID-based checks
 */
export function canAccessFeatureByStatus(
  status: SubscriptionStatus,
  feature: 'multipleMembers' | 'unlimitedProjects'
): boolean {
  const isPro = hasProSubscription(status)

  switch (feature) {
    case 'multipleMembers':
      return isPro
    case 'unlimitedProjects':
      return isPro
    default:
      return false
  }
}

// ============================================
// ROUTE PERMISSIONS
// ============================================
// Routes that are always accessible, even for unpaid 2nd+ orgs
export const UNRESTRICTED_ROUTES = [
  '/billing',
  '/settings' // Allow access to settings so users can delete their org
]

// Check if a route path is unrestricted
export function isUnrestrictedRoute(path: string): boolean {
  return UNRESTRICTED_ROUTES.some(route => path.includes(route))
}

// ============================================
// ORGANIZATION PERMISSIONS
// ============================================
export const PERMISSIONS = {
  // Member Management
  INVITE_MEMBERS: ['owner', 'admin'],
  REMOVE_MEMBERS: ['owner', 'admin'],
  CHANGE_MEMBER_ROLE: ['owner', 'admin'],
  VIEW_MEMBERS: ['owner', 'admin', 'member'],

  // Organization Settings
  UPDATE_ORG_SETTINGS: ['owner', 'admin'],
  DELETE_ORGANIZATION: ['owner'],
  VIEW_ORG_SETTINGS: ['owner', 'admin'],

  // Billing
  MANAGE_BILLING: ['owner'],
  VIEW_BILLING: ['owner'],

  // Invitations
  CANCEL_INVITATION: ['owner', 'admin'],
  RESEND_INVITATION: ['owner', 'admin'],

  // Navigation Visibility
  VIEW_BILLING_NAV: ['owner'], // Only owners see billing in nav
  VIEW_SETTINGS_NAV: ['owner', 'admin', 'member'], // Everyone sees settings (members can only leave)
  VIEW_MEMBERS_NAV: ['owner', 'admin', 'member'], // Everyone sees members
  VIEW_DASHBOARD_NAV: ['owner', 'admin', 'member'] // Everyone sees dashboard
} as const

// ============================================
// PERMISSION CHECKER FUNCTIONS
// ============================================

/**
 * Reads a member's stored organization role into its roles. better-auth
 * keeps several roles in one comma-separated value (`owner,admin`):
 * entries are trimmed and empty ones dropped. Casing is kept, so `Owner`
 * matches no role.
 */
export function parseOrgRoles(role: string | null | undefined): string[] {
  if (!role)
    return []
  return role.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
}

/**
 * Whether a stored role, a single role or a comma-separated role list
 * (better-auth keeps several roles that way, `user,admin`), holds `wanted`.
 * Casing must match, so `Admin` is not `admin`.
 */
export function hasRole(role: string | null | undefined, wanted: string): boolean {
  return parseOrgRoles(role).includes(wanted)
}

/**
 * Whether a member's stored role, a single role or a role list, holds at
 * least one of `roles`. Casing must match.
 */
export function hasOrgRole(role: string | null | undefined, roles: readonly OrgRole[]): boolean {
  // Widened for the lookup only: stored entries are unchecked strings.
  const wanted: readonly string[] = roles
  return parseOrgRoles(role).some(entry => wanted.includes(entry))
}

/**
 * Check if a role, or one role of a role list, has a specific permission
 */
export function hasPermission(
  userRole: string | null | undefined,
  permission: keyof typeof PERMISSIONS
): boolean {
  return hasOrgRole(userRole, PERMISSIONS[permission])
}

/**
 * Check if user can manage members (invite, remove, change roles)
 */
export function canManageMembers(role: string | null | undefined): boolean {
  return hasPermission(role, 'INVITE_MEMBERS')
}

/**
 * Check if user can manage billing
 */
export function canManageBilling(role: string | null | undefined): boolean {
  return hasPermission(role, 'MANAGE_BILLING')
}

/**
 * Check if user can update organization settings
 */
export function canUpdateOrgSettings(role: string | null | undefined): boolean {
  return hasPermission(role, 'UPDATE_ORG_SETTINGS')
}

/**
 * Check if user can delete organization
 */
export function canDeleteOrganization(role: string | null | undefined): boolean {
  return hasPermission(role, 'DELETE_ORGANIZATION')
}

/**
 * Check if user is owner
 */
export function isOwner(role: string | null | undefined): boolean {
  return hasOrgRole(role, ['owner'])
}

/**
 * Check if user is admin or owner
 */
export function isAdminOrOwner(role: string | null | undefined): boolean {
  return hasOrgRole(role, ['owner', 'admin'])
}

/**
 * A member's role list with `role` added (`checked`) or removed, in a new
 * array. Roles already held keep their place, an added role goes last, and
 * roles outside the role menu stay. Unchecking the last role returns an
 * empty list: the caller refuses to send it.
 */
export function toggleOrgRole(roles: readonly string[], role: string, checked: boolean): string[] {
  if (!checked)
    return roles.filter(entry => entry !== role)
  return roles.includes(role) ? [...roles] : [...roles, role]
}
