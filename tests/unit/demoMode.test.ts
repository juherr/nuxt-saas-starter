// SPDX-License-Identifier: MIT
import type { DemoProtection, DemoRequest, DemoSession } from '~~/shared/utils/demoMode'
import { describe, expect, it } from 'vitest'
import { DEMO_GUARDED_PATHS, DEMO_PROTECTION, DEMO_SESSION_UNRESOLVED, demoBlockReason, demoNeedsSession, demoSessionTokenToResolve } from '~~/shared/utils/demoMode'

const PROTECTED_USER = 'protected-user'
const OTHER_USER = 'other-user'
const SEEDED_ORG = 'seeded-org'
const OTHER_ORG = 'other-org'
const PROTECTED_MEMBER = 'protected-member'
const OTHER_MEMBER = 'other-member'

const protection: DemoProtection = {
  userIds: [PROTECTED_USER],
  emails: ['demo@example.com'],
  organizationIds: [SEEDED_ORG],
  memberIds: [PROTECTED_MEMBER]
}

const protectedSession: DemoSession = { userId: PROTECTED_USER, activeOrganizationId: null }
const otherSession: DemoSession = { userId: OTHER_USER, activeOrganizationId: null }

const blocked = (path: string, body: unknown, session: DemoRequest['session'] = null) =>
  demoBlockReason({ path, body, session }, protection)

describe('demoBlockReason', () => {
  it('blocks /sign-up/email for everyone', () => {
    expect(blocked('/sign-up/email', { email: 'new@example.com' })).toBeTruthy()
  })

  it('lets /sign-in/email through', () => {
    expect(blocked('/sign-in/email', { email: 'demo@example.com' })).toBeNull()
  })

  describe('on the protected session user', () => {
    it.each([
      '/change-password',
      '/change-email',
      '/delete-user',
      '/revoke-sessions',
      '/revoke-other-sessions',
      '/revoke-session',
      '/link-social',
      '/unlink-account'
    ])('%s is blocked for a protected user and allowed for another one', (path) => {
      expect(blocked(path, {}, protectedSession)).toBeTruthy()
      expect(blocked(path, {}, otherSession)).toBeNull()
    })

    it.each([
      '/change-password',
      '/change-email',
      '/delete-user',
      '/revoke-sessions',
      '/revoke-other-sessions',
      '/revoke-session',
      '/link-social',
      '/unlink-account'
    ])('%s is left to the endpoint without a session', (path) => {
      expect(blocked(path, {}, null)).toBeNull()
    })

    // A session cookie the hook could not resolve may belong to a protected
    // user, and the endpoint may still resolve it: fail closed.
    it.each([
      '/change-password',
      '/change-email',
      '/delete-user',
      '/revoke-sessions',
      '/revoke-other-sessions',
      '/revoke-session',
      '/link-social',
      '/unlink-account'
    ])('%s is blocked when the session could not be resolved', (path) => {
      expect(blocked(path, {}, DEMO_SESSION_UNRESOLVED)).toBeTruthy()
    })

    it('/update-user is blocked when the session could not be resolved and it changes the email or sets an avatar', () => {
      expect(blocked('/update-user', { email: 'mine@example.com' }, DEMO_SESSION_UNRESOLVED)).toBeTruthy()
      expect(blocked('/update-user', { image: 'https://example.com/a.png' }, DEMO_SESSION_UNRESOLVED)).toBeTruthy()
    })

    it('/update-user lets a rename or an avatar removal through when the session could not be resolved', () => {
      expect(blocked('/update-user', { name: 'Renamed' }, DEMO_SESSION_UNRESOLVED)).toBeNull()
      expect(blocked('/update-user', { image: null }, DEMO_SESSION_UNRESOLVED)).toBeNull()
    })

    it('/update-user is left to the endpoint without a session', () => {
      expect(blocked('/update-user', { email: 'mine@example.com' }, null)).toBeNull()
      expect(blocked('/update-user', { image: 'https://example.com/a.png' }, null)).toBeNull()
    })

    it('/update-user is blocked when a protected user changes the email', () => {
      expect(blocked('/update-user', { email: 'mine@example.com' }, protectedSession)).toBeTruthy()
      expect(blocked('/update-user', { email: 'mine@example.com' }, otherSession)).toBeNull()
    })

    it('/update-user lets a protected user change the name', () => {
      expect(blocked('/update-user', { name: 'Renamed' }, protectedSession)).toBeNull()
    })

    it('/update-user is blocked when a protected user sets an avatar', () => {
      expect(blocked('/update-user', { image: 'https://example.com/a.png' }, protectedSession)).toBeTruthy()
      expect(blocked('/update-user', { name: 'Renamed', image: 'data:image/png;base64,AAAA' }, protectedSession)).toBeTruthy()
    })

    it.each([null, ''])('/update-user lets a protected user remove the avatar (image %j)', (image) => {
      expect(blocked('/update-user', { image }, protectedSession)).toBeNull()
    })

    it('/update-user lets another user set an avatar', () => {
      expect(blocked('/update-user', { image: 'https://example.com/a.png' }, otherSession)).toBeNull()
    })
  })

  describe('/organization/update', () => {
    const LOGO = 'https://example.com/logo.png'

    it('is blocked when it sets the logo of a seeded organization named in the body', () => {
      expect(blocked('/organization/update', { organizationId: SEEDED_ORG, data: { logo: LOGO } }, null)).toBeTruthy()
    })

    it('is blocked when it sets the logo of the seeded active organization', () => {
      const session: DemoSession = { userId: OTHER_USER, activeOrganizationId: SEEDED_ORG }
      expect(blocked('/organization/update', { data: { logo: LOGO } }, session)).toBeTruthy()
      expect(blocked('/organization/update', { organizationId: '', data: { logo: LOGO } }, session)).toBeTruthy()
    })

    // The hook needs the session to find the target here: when it could not
    // resolve it, the policy cannot tell the target is not seeded, so it
    // refuses. Without a session cookie, the endpoint answers 401 itself.
    it('is blocked when it sets a logo without organizationId and the session could not be resolved', () => {
      expect(blocked('/organization/update', { data: { logo: LOGO } }, DEMO_SESSION_UNRESOLVED)).toBeTruthy()
      expect(blocked('/organization/update', { organizationId: '', data: { logo: LOGO } }, DEMO_SESSION_UNRESOLVED)).toBeTruthy()
    })

    it('is left to the endpoint when it sets a logo without organizationId and without a session', () => {
      expect(blocked('/organization/update', { data: { logo: LOGO } }, null)).toBeNull()
      expect(blocked('/organization/update', { organizationId: '', data: { logo: LOGO } }, null)).toBeNull()
    })

    it('lets the logo of another organization named in the body through when the session could not be resolved', () => {
      expect(blocked('/organization/update', { organizationId: OTHER_ORG, data: { logo: LOGO } }, DEMO_SESSION_UNRESOLVED)).toBeNull()
    })

    it('lets a logo through for a resolved session without an active organization', () => {
      expect(blocked('/organization/update', { data: { logo: LOGO } }, otherSession)).toBeNull()
    })

    it('lets a rename or a logo removal through without organizationId and without a session', () => {
      expect(blocked('/organization/update', { data: { name: 'Renamed' } }, null)).toBeNull()
      expect(blocked('/organization/update', { data: { logo: null } }, null)).toBeNull()
    })

    it('lets a seeded organization be renamed', () => {
      expect(blocked('/organization/update', { organizationId: SEEDED_ORG, data: { name: 'Renamed' } }, null)).toBeNull()
    })

    it.each([null, ''])('lets the logo of a seeded organization be removed (logo %j)', (logo) => {
      expect(blocked('/organization/update', { organizationId: SEEDED_ORG, data: { logo } }, null)).toBeNull()
    })

    it('lets the logo of another organization be set', () => {
      const session: DemoSession = { userId: OTHER_USER, activeOrganizationId: SEEDED_ORG }
      expect(blocked('/organization/update', { organizationId: OTHER_ORG, data: { logo: LOGO } }, session)).toBeNull()
      expect(blocked('/organization/update', { data: { logo: LOGO } }, { ...session, activeOrganizationId: OTHER_ORG })).toBeNull()
    })
  })

  describe('/request-password-reset', () => {
    it('is blocked for a protected email', () => {
      expect(blocked('/request-password-reset', { email: 'demo@example.com' })).toBeTruthy()
    })

    it('is blocked for a protected email in another case', () => {
      expect(blocked('/request-password-reset', { email: ' DEMO@Example.com ' })).toBeTruthy()
    })

    it('is allowed for another email', () => {
      expect(blocked('/request-password-reset', { email: 'someone@example.com' })).toBeNull()
    })
  })

  describe('on a protected target user', () => {
    it.each([
      '/admin/ban-user',
      '/admin/remove-user',
      '/admin/set-user-password',
      '/admin/set-role',
      '/admin/impersonate-user',
      '/admin/revoke-user-sessions',
      '/admin/update-user',
      '/admin/list-user-sessions',
      '/admin/unban-user'
    ])('%s is blocked on a protected user and allowed on another one', (path) => {
      expect(blocked(path, { userId: PROTECTED_USER }, otherSession)).toBeTruthy()
      expect(blocked(path, { userId: OTHER_USER }, otherSession)).toBeNull()
    })

    it('blocks a protected user id the endpoint would coerce from an array', () => {
      expect(blocked('/admin/ban-user', { userId: [PROTECTED_USER] })).toBeTruthy()
    })
  })

  describe('/admin/revoke-user-session', () => {
    const revoke = (sessionOwnerId: string | null) =>
      demoBlockReason({ path: '/admin/revoke-user-session', body: { sessionToken: 'token-1' }, session: otherSession, sessionOwnerId }, protection)

    it('is blocked when the session named by the token belongs to a protected user', () => {
      expect(revoke(PROTECTED_USER)).toBeTruthy()
    })

    it('is allowed when the session belongs to another user', () => {
      expect(revoke(OTHER_USER)).toBeNull()
    })

    it('is left to the endpoint when the token names no session', () => {
      expect(revoke(null)).toBeNull()
    })
  })

  describe('demoSessionTokenToResolve', () => {
    it('names the session token of /admin/revoke-user-session', () => {
      expect(demoSessionTokenToResolve('/admin/revoke-user-session', { sessionToken: 'token-1' })).toBe('token-1')
    })

    it('names nothing without a token or on another path', () => {
      expect(demoSessionTokenToResolve('/admin/revoke-user-session', {})).toBeUndefined()
      expect(demoSessionTokenToResolve('/admin/revoke-user-sessions', { sessionToken: 'token-1' })).toBeUndefined()
    })
  })

  describe('/organization/delete', () => {
    it('is blocked on a seeded organization', () => {
      expect(blocked('/organization/delete', { organizationId: SEEDED_ORG }, otherSession)).toBeTruthy()
    })

    it('is allowed on another organization', () => {
      expect(blocked('/organization/delete', { organizationId: OTHER_ORG }, protectedSession)).toBeNull()
    })
  })

  describe('/organization/remove-member', () => {
    it('is blocked on a protected member id, whatever organization the body names', () => {
      expect(blocked('/organization/remove-member', { memberIdOrEmail: PROTECTED_MEMBER, organizationId: OTHER_ORG })).toBeTruthy()
    })

    it('is allowed on another member id', () => {
      expect(blocked('/organization/remove-member', { memberIdOrEmail: OTHER_MEMBER, organizationId: SEEDED_ORG })).toBeNull()
    })

    it('is blocked on a protected email in a seeded organization', () => {
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'Demo@Example.com', organizationId: SEEDED_ORG }, otherSession)).toBeTruthy()
    })

    it('is blocked on a protected email in the seeded active organization', () => {
      const session = { userId: OTHER_USER, activeOrganizationId: SEEDED_ORG }
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'demo@example.com' }, session)).toBeTruthy()
    })

    it('is allowed on a protected email in another organization', () => {
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'demo@example.com', organizationId: OTHER_ORG }, otherSession)).toBeNull()
      const session = { userId: OTHER_USER, activeOrganizationId: OTHER_ORG }
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'demo@example.com' }, session)).toBeNull()
    })

    it('falls back to the seeded active organization when the body names an empty one', () => {
      const session = { userId: OTHER_USER, activeOrganizationId: SEEDED_ORG }
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'demo@example.com', organizationId: '' }, session)).toBeTruthy()
    })

    it('prefers the organization of the body over the active one', () => {
      const session = { userId: OTHER_USER, activeOrganizationId: SEEDED_ORG }
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'demo@example.com', organizationId: OTHER_ORG }, session)).toBeNull()
    })

    it('is left to the endpoint without a target', () => {
      const session = { userId: OTHER_USER, activeOrganizationId: SEEDED_ORG }
      expect(blocked('/organization/remove-member', { organizationId: SEEDED_ORG }, session)).toBeNull()
    })

    it('is allowed on another email in a seeded organization', () => {
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'alice@example.com', organizationId: SEEDED_ORG }, otherSession)).toBeNull()
    })

    it('is blocked on a protected email without organizationId when the session could not be resolved', () => {
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'demo@example.com' }, DEMO_SESSION_UNRESOLVED)).toBeTruthy()
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'demo@example.com', organizationId: '' }, DEMO_SESSION_UNRESOLVED)).toBeTruthy()
    })

    it('lets a protected email through when the session could not be resolved but the body names another organization', () => {
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'demo@example.com', organizationId: OTHER_ORG }, DEMO_SESSION_UNRESOLVED)).toBeNull()
    })

    it('lets another email through when the session could not be resolved', () => {
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'alice@example.com' }, DEMO_SESSION_UNRESOLVED)).toBeNull()
    })

    it('leaves a protected email without organizationId to the endpoint without a session', () => {
      expect(blocked('/organization/remove-member', { memberIdOrEmail: 'demo@example.com' }, null)).toBeNull()
    })
  })

  describe('/organization/leave', () => {
    it('is blocked for a protected user leaving a seeded organization', () => {
      expect(blocked('/organization/leave', { organizationId: SEEDED_ORG }, protectedSession)).toBeTruthy()
    })

    it('is allowed for a protected user leaving another organization', () => {
      expect(blocked('/organization/leave', { organizationId: OTHER_ORG }, protectedSession)).toBeNull()
    })

    it('is allowed for another user leaving a seeded organization', () => {
      expect(blocked('/organization/leave', { organizationId: SEEDED_ORG }, otherSession)).toBeNull()
    })

    it('is blocked when the session could not be resolved and the organization is seeded', () => {
      expect(blocked('/organization/leave', { organizationId: SEEDED_ORG }, DEMO_SESSION_UNRESOLVED)).toBeTruthy()
    })

    it('is allowed when the session could not be resolved and the organization is another one', () => {
      expect(blocked('/organization/leave', { organizationId: OTHER_ORG }, DEMO_SESSION_UNRESOLVED)).toBeNull()
    })

    it('is left to the endpoint without a session', () => {
      expect(blocked('/organization/leave', { organizationId: SEEDED_ORG }, null)).toBeNull()
    })
  })

  describe('/organization/update-member-role', () => {
    it('is blocked on a protected member id, whatever organization the body names', () => {
      expect(blocked('/organization/update-member-role', { memberId: PROTECTED_MEMBER, role: 'member', organizationId: OTHER_ORG })).toBeTruthy()
    })

    it('is allowed on another member id', () => {
      expect(blocked('/organization/update-member-role', { memberId: OTHER_MEMBER, role: 'member', organizationId: SEEDED_ORG })).toBeNull()
    })
  })

  it.each([null, undefined, 'text', 42])('treats a body of %s as empty', (body) => {
    expect(blocked('/admin/ban-user', body)).toBeNull()
    expect(blocked('/sign-up/email', body)).toBeTruthy()
  })
})

describe('demoNeedsSession', () => {
  it.each([
    '/change-password',
    '/change-email',
    '/delete-user',
    '/update-user',
    '/revoke-sessions',
    '/revoke-other-sessions',
    '/revoke-session',
    '/link-social',
    '/unlink-account',
    '/organization/leave'
  ])('needs the session for %s', (path) => {
    expect(demoNeedsSession(path, {})).toBe(true)
  })

  it('needs the session to remove a member named by email without an organization', () => {
    expect(demoNeedsSession('/organization/remove-member', { memberIdOrEmail: 'demo@example.com' })).toBe(true)
  })

  it('does not need the session to remove a member named by id or with an organization', () => {
    expect(demoNeedsSession('/organization/remove-member', { memberIdOrEmail: PROTECTED_MEMBER })).toBe(false)
    expect(demoNeedsSession('/organization/remove-member', { memberIdOrEmail: 'demo@example.com', organizationId: SEEDED_ORG })).toBe(false)
  })

  it('needs the session to update the active organization', () => {
    expect(demoNeedsSession('/organization/update', { data: { logo: 'x' } })).toBe(true)
  })

  it('does not need the session to update an organization named in the body', () => {
    expect(demoNeedsSession('/organization/update', { organizationId: SEEDED_ORG, data: { logo: 'x' } })).toBe(false)
  })

  it.each([
    '/sign-up/email',
    '/request-password-reset',
    '/admin/ban-user',
    '/organization/delete',
    '/organization/update-member-role',
    '/get-session'
  ])('does not need the session for %s', (path) => {
    expect(demoNeedsSession(path, {})).toBe(false)
  })
})

describe('the demo path table', () => {
  // Bodies that reach every rule of the table: each field a rule reads,
  // alone and with the organization that turns the session lookup off.
  const probeBodies: readonly Record<string, unknown>[] = [
    {},
    { email: 'demo@example.com' },
    { image: 'x' },
    { data: { logo: 'x' } },
    { organizationId: SEEDED_ORG },
    { organizationId: SEEDED_ORG, data: { logo: 'x' } },
    { memberIdOrEmail: 'demo@example.com' },
    { memberIdOrEmail: 'demo@example.com', organizationId: SEEDED_ORG },
    { memberIdOrEmail: PROTECTED_MEMBER },
    { memberId: PROTECTED_MEMBER },
    { userId: PROTECTED_USER },
    { sessionToken: 'token-1' }
  ]
  const sessions: readonly DemoRequest['session'][] = [
    { userId: PROTECTED_USER, activeOrganizationId: SEEDED_ORG },
    DEMO_SESSION_UNRESOLVED
  ]
  it('guards every path the policy knows', () => {
    expect(DEMO_GUARDED_PATHS).toContain('/sign-up/email')
    expect(DEMO_GUARDED_PATHS).toContain('/admin/revoke-user-session')
    expect(DEMO_GUARDED_PATHS.length).toBeGreaterThan(20)
  })

  it('reaches every rule that reads the session with its probes', () => {
    const decidedBySession = DEMO_GUARDED_PATHS.filter(path => probeBodies.some(body =>
      sessions.some(session => blocked(path, body, session) !== blocked(path, body, null))))
    expect(decidedBySession).toEqual(expect.arrayContaining([
      '/change-password',
      '/update-user',
      '/organization/update',
      '/organization/leave',
      '/organization/remove-member'
    ]))
  })

  // A rule that reads the session on a path that does not declare it is
  // evaluated with `session: null` and lets the request through.
  it.each(DEMO_GUARDED_PATHS)('declares a session requirement wherever the session decides %s', (path) => {
    const undeclared = probeBodies.filter((body) => {
      const withoutSession = blocked(path, body, null)
      const decidedBySession = sessions.some(session => blocked(path, body, session) !== withoutSession)
      return decidedBySession && !demoNeedsSession(path, body)
    })
    expect(undeclared).toEqual([])
  })

  it.each(DEMO_GUARDED_PATHS)('declares a token reader wherever the session owner decides %s', (path) => {
    const undeclared = probeBodies.filter((body) => {
      const owned = (sessionOwnerId: string | null) =>
        demoBlockReason({ path, body, session: null, sessionOwnerId }, protection)
      return owned(PROTECTED_USER) !== owned(null)
        && demoSessionTokenToResolve(path, { ...body, sessionToken: 'token-1' }) !== 'token-1'
    })
    expect(undeclared).toEqual([])
  })
})

describe('the demo protected set', () => {
  it('protects the seeded demo accounts, organizations and their memberships', () => {
    expect(DEMO_PROTECTION.userIds).toHaveLength(2)
    expect(DEMO_PROTECTION.emails).toEqual(['demo@example.com', 'demo-admin@example.com'])
    expect(DEMO_PROTECTION.organizationIds).toHaveLength(2)
    expect(DEMO_PROTECTION.memberIds.length).toBeGreaterThan(0)
  })
})
