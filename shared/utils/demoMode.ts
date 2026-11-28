// SPDX-License-Identifier: MIT
import {
  DEMO_PROTECTED_EMAILS,
  DEMO_PROTECTED_MEMBER_IDS,
  DEMO_PROTECTED_ORGANIZATION_IDS,
  DEMO_PROTECTED_USER_IDS
} from '~~/scripts/demo/seedData'

/**
 * What the public demo must keep intact: the seeded accounts (by id and by
 * sign-in email), the seeded organizations and the memberships of the
 * protected accounts in them (by member row id).
 */
export interface DemoProtection {
  userIds: readonly string[]
  emails: readonly string[]
  organizationIds: readonly string[]
  memberIds: readonly string[]
}

/** The caller's session, as far as the demo policy needs it. */
export interface DemoSession {
  userId: string
  activeOrganizationId?: string | null
}

/**
 * The request carries a session cookie, but the hook could not resolve the
 * session (getSessionFromCtx answers null on a failed lookup). The endpoint
 * may still resolve it afterwards, so the user may be a protected one.
 */
export const DEMO_SESSION_UNRESOLVED = 'unresolved'

/**
 * A better-auth request seen from a before hook: the endpoint path
 * (relative to the auth base path) and the raw body, before the endpoint
 * validates it.
 */
export interface DemoRequest {
  path: string
  body: unknown
  /** The resolved session, `DEMO_SESSION_UNRESOLVED`, or null without a session cookie. */
  session: DemoSession | typeof DEMO_SESSION_UNRESOLVED | null
  /**
   * The user owning the session that `demoSessionTokenToResolve` names,
   * as the caller looked it up; null or absent when there is none.
   */
  sessionOwnerId?: string | null
}

/** The error code of every demo refusal, as clients and the smoke test read it. */
export const DEMO_MODE_RESTRICTED = 'DEMO_MODE_RESTRICTED'

export const DEMO_PROTECTION: DemoProtection = Object.freeze({
  userIds: DEMO_PROTECTED_USER_IDS,
  emails: DEMO_PROTECTED_EMAILS,
  organizationIds: DEMO_PROTECTED_ORGANIZATION_IDS,
  memberIds: DEMO_PROTECTED_MEMBER_IDS
})

type Body = Record<string, unknown>

const asBody = (body: unknown): Body =>
  (body !== null && typeof body === 'object' ? body as Body : {})

/**
 * A body field as the endpoint reads it. The admin endpoints coerce ids
 * with `String()`, so an id wrapped in an array still names that user:
 * compare what the endpoint will see, not the raw value.
 */
const text = (value: unknown): string | undefined =>
  (value === undefined || value === null ? undefined : String(value))

// Whether a field sets a value: null and '' clear it (removing an avatar
// or a logo stays allowed), absent leaves it alone.
const setsValue = (value: unknown) => {
  const read = text(value)
  return read !== undefined && read !== ''
}

const normalizeEmail = (value: string) => value.trim().toLowerCase()

const isProtectedEmail = (value: string | undefined, protection: DemoProtection) =>
  value !== undefined && protection.emails.some(email => normalizeEmail(email) === normalizeEmail(value))

// better-auth tells an email from a member id by the `@`.
const isEmail = (value: string) => value.includes('@')

/** What a rule may read about the request, derived once per request. */
interface DemoRuleContext {
  body: Body
  protection: DemoProtection
  /** The session user is protected, or the session is unresolved. Reads the session. */
  sessionMayBeProtected: boolean
  /**
   * Whether the target organization (the one the body names, else the
   * session's active one) may be seeded: it may when only an unresolved
   * session could name it. Reads the session when the body names none.
   */
  mayBeSeededTarget: () => boolean
  isProtectedUser: (userId: string | null | undefined) => boolean
  isSeededOrganization: (organizationId: string | undefined) => boolean
  sessionOwnerId: string | null | undefined
}

/** A refusal reason, or null to let the request through. */
type DemoRule = (context: DemoRuleContext) => string | null

/**
 * What the demo checks on one path. A rule that reads the session (through
 * `sessionMayBeProtected` or `mayBeSeededTarget`) must declare
 * `needsSession`, or the caller passes `session: null` and the rule lets
 * the request through; a rule that reads `sessionOwnerId` must declare
 * `tokenToResolve`. The invariant tests of `tests/unit/demoMode.test.ts`
 * enforce both.
 */
interface DemoPathPolicy {
  /** Checked in order; the first reason wins. */
  readonly rules: readonly DemoRule[]
  /** Whether the rules read the caller's session: always, or for the bodies the predicate accepts. */
  readonly needsSession?: true | ((body: Body) => boolean)
  /** The session token whose owner the rules read, as `sessionOwnerId`. */
  readonly tokenToResolve?: (body: Body) => string | undefined
}

const refuse = (reason: string, when: (context: DemoRuleContext) => boolean): DemoRule =>
  context => (when(context) ? reason : null)

// Endpoints that act on the session user. better-auth 1.7.25 exposes no
// `/set-password`: `setPassword` is a server-only endpoint without a path.
const SELF_PATHS: readonly string[] = [
  '/change-password',
  '/change-email',
  '/delete-user',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/revoke-session',
  '/link-social',
  '/unlink-account'
]

const SELF_POLICY: DemoPathPolicy = {
  needsSession: true,
  rules: [refuse(
    'The demo accounts cannot change their credentials, sessions or linked accounts.',
    context => context.sessionMayBeProtected
  )]
}

// Admin endpoints that act on the user named by `body.userId`.
const ADMIN_TARGET_PATHS: readonly string[] = [
  '/admin/ban-user',
  '/admin/remove-user',
  '/admin/set-user-password',
  '/admin/set-role',
  '/admin/impersonate-user',
  '/admin/revoke-user-sessions',
  '/admin/update-user',
  '/admin/list-user-sessions',
  '/admin/unban-user'
]

const ADMIN_CHANGE_REASON = 'The demo accounts cannot be changed by an administrator.'

const ADMIN_TARGET_POLICY: DemoPathPolicy = {
  rules: [refuse(ADMIN_CHANGE_REASON, context => context.isProtectedUser(text(context.body.userId)))]
}

// `/organization/remove-member` names its target by member id or by email;
// an email is resolved in the organization the body names, else in the
// session's active one.
const removedMemberEmail = (body: Body) => {
  const target = text(body.memberIdOrEmail)
  return target !== undefined && isEmail(target) ? target : undefined
}

/** Every guarded path and what the demo checks on it. */
const DEMO_PATH_POLICIES: ReadonlyMap<string, DemoPathPolicy> = new Map<string, DemoPathPolicy>([
  ['/sign-up/email', { rules: [refuse('Sign-up is disabled in the demo.', () => true)] }],
  ...SELF_PATHS.map(path => [path, SELF_POLICY] as const),
  ['/update-user', {
    needsSession: true,
    rules: [
      refuse('The demo accounts cannot change their email.', ({ sessionMayBeProtected, body }) =>
        sessionMayBeProtected && text(body.email) !== undefined),
      refuse('The demo accounts cannot change their avatar.', ({ sessionMayBeProtected, body }) =>
        sessionMayBeProtected && setsValue(body.image))
    ]
  }],
  // better-auth 1.7.25 reads the logo from `data.logo` and the target from
  // `organizationId`, else the session's active organization.
  ['/organization/update', {
    needsSession: body => !text(body.organizationId),
    rules: [refuse('The demo organizations cannot change their logo.', ({ body, mayBeSeededTarget }) =>
      setsValue(asBody(body.data).logo) && mayBeSeededTarget())]
  }],
  ['/request-password-reset', {
    rules: [refuse('The demo accounts cannot reset their password.', ({ body, protection }) =>
      isProtectedEmail(text(body.email), protection))]
  }],
  ...ADMIN_TARGET_PATHS.map(path => [path, ADMIN_TARGET_POLICY] as const),
  // Names its target by session token only: the caller looks the token up
  // to learn whose session it is. The endpoint reads the token as a
  // string, so only a string names a session.
  ['/admin/revoke-user-session', {
    tokenToResolve: (body) => {
      const token = body.sessionToken
      return typeof token === 'string' && token !== '' ? token : undefined
    },
    rules: [refuse(ADMIN_CHANGE_REASON, context => context.isProtectedUser(context.sessionOwnerId))]
  }],
  ['/organization/delete', {
    rules: [refuse('The demo organizations cannot be deleted.', ({ body, isSeededOrganization }) =>
      isSeededOrganization(text(body.organizationId)))]
  }],
  ['/organization/leave', {
    needsSession: true,
    rules: [refuse('The demo accounts cannot leave the demo organizations.', ({ body, sessionMayBeProtected, isSeededOrganization }) =>
      sessionMayBeProtected && isSeededOrganization(text(body.organizationId)))]
  }],
  ['/organization/remove-member', {
    needsSession: body => removedMemberEmail(body) !== undefined && !text(body.organizationId),
    rules: [refuse('The demo accounts cannot be removed from the demo organizations.', (context) => {
      const target = text(context.body.memberIdOrEmail)
      if (target === undefined) {
        return false
      }
      return isEmail(target)
        ? isProtectedEmail(target, context.protection) && context.mayBeSeededTarget()
        : context.protection.memberIds.includes(target)
    })]
  }],
  ['/organization/update-member-role', {
    rules: [refuse('The roles of the demo accounts cannot be changed.', (context) => {
      const target = text(context.body.memberId)
      return target !== undefined && context.protection.memberIds.includes(target)
    })]
  }]
])

/** The paths the demo policy guards; every other path goes through untouched. */
export const DEMO_GUARDED_PATHS: readonly string[] = Object.freeze([...DEMO_PATH_POLICIES.keys()])

/**
 * Why the demo refuses this request, or null to let it through. Pure: the
 * caller passes the session (null when the path does not need one, see
 * `demoNeedsSession`, or when the request carries no session cookie) and
 * the protected set. An unresolved session fails closed: it is refused
 * wherever a protected session, or a seeded active organization, would be.
 */
export function demoBlockReason(request: DemoRequest, protection: DemoProtection): string | null {
  const policy = DEMO_PATH_POLICIES.get(request.path)
  if (policy === undefined) {
    return null
  }
  const { session: given } = request
  const body = asBody(request.body)
  const unresolved = given === DEMO_SESSION_UNRESOLVED
  const session = unresolved ? null : given
  const isProtectedUser = (userId: string | null | undefined) =>
    userId !== undefined && userId !== null && protection.userIds.includes(userId)
  const isSeededOrganization = (organizationId: string | undefined) =>
    organizationId !== undefined && protection.organizationIds.includes(organizationId)
  const context: DemoRuleContext = {
    body,
    protection,
    sessionMayBeProtected: unresolved || (session !== null && isProtectedUser(session.userId)),
    mayBeSeededTarget: () => {
      const named = text(body.organizationId) || undefined
      if (named === undefined && unresolved) {
        return true
      }
      return isSeededOrganization(named ?? session?.activeOrganizationId ?? undefined)
    },
    isProtectedUser,
    isSeededOrganization,
    sessionOwnerId: request.sessionOwnerId
  }
  for (const rule of policy.rules) {
    const reason = rule(context)
    if (reason !== null) {
      return reason
    }
  }
  return null
}

/**
 * The session token whose owner `demoBlockReason` needs for this request
 * (as `sessionOwnerId`), or undefined when it needs none.
 */
export function demoSessionTokenToResolve(path: string, body: unknown): string | undefined {
  return DEMO_PATH_POLICIES.get(path)?.tokenToResolve?.(asBody(body))
}

/**
 * Whether `demoBlockReason` needs the caller's session for this request.
 * Resolving a session costs a store lookup: skip it everywhere else.
 */
export function demoNeedsSession(path: string, body: unknown): boolean {
  const needsSession = DEMO_PATH_POLICIES.get(path)?.needsSession
  return needsSession === true || (needsSession !== undefined && needsSession(asBody(body)))
}
