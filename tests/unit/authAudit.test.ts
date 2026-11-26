// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import { AUDITED_SUCCESS_PATHS, resolveAuditTarget } from '~~/server/utils/authAudit'

describe('resolveAuditTarget', () => {
  it('targets the session user when the request has a session', () => {
    expect(resolveAuditTarget({ path: '/sign-in/email', hasSession: true, sessionUserId: 'user-1', email: 'a@example.com' }))
      .toEqual({ targetType: 'user', targetId: 'user-1' })
  })

  it.each(['/sign-in/email', '/sign-up/email'])('targets the email of an anonymous %s request', (path) => {
    expect(resolveAuditTarget({ path, hasSession: false, email: 'a@example.com' }))
      .toEqual({ targetType: 'email', targetId: 'a@example.com' })
  })

  it('targets the email of an anonymous password reset request', () => {
    expect(resolveAuditTarget({ path: '/request-password-reset', hasSession: false, email: 'a@example.com' }))
      .toEqual({ targetType: 'email', targetId: 'a@example.com' })
  })

  it('keeps the session user as target of a /reset-password request with a session', () => {
    expect(resolveAuditTarget({ path: '/reset-password', hasSession: true, sessionUserId: 'user-1', bodyUserId: 'user-2' }))
      .toEqual({ targetType: 'user', targetId: 'user-1' })
  })

  it('targets the removed user, not the acting admin, on /admin/remove-user', () => {
    expect(resolveAuditTarget({ path: '/admin/remove-user', hasSession: true, sessionUserId: 'admin-1', bodyUserId: 'user-2' }))
      .toEqual({ targetType: 'user', targetId: 'user-2' })
  })

  it('stringifies a numeric user id on /admin/remove-user', () => {
    expect(resolveAuditTarget({ path: '/admin/remove-user', hasSession: true, sessionUserId: 'admin-1', bodyUserId: 42 }))
      .toEqual({ targetType: 'user', targetId: '42' })
  })

  it('coerces an array user id the way the endpoint does on /admin/remove-user', () => {
    expect(resolveAuditTarget({ path: '/admin/remove-user', hasSession: true, sessionUserId: 'admin-1', bodyUserId: ['user-2'] }))
      .toEqual({ targetType: 'user', targetId: 'user-2' })
  })

  it.each([
    [{ id: 'user-2' }, '[object Object]'],
    [null, 'null']
  ])('coerces a %o user id to %s on /admin/remove-user', (bodyUserId, targetId) => {
    expect(resolveAuditTarget({ path: '/admin/remove-user', hasSession: true, sessionUserId: 'admin-1', bodyUserId }))
      .toEqual({ targetType: 'user', targetId })
  })

  it('has no target id on /admin/remove-user when the user id is missing', () => {
    expect(resolveAuditTarget({ path: '/admin/remove-user', hasSession: true, sessionUserId: 'admin-1', bodyUserId: undefined }))
      .toEqual({ targetType: 'user', targetId: undefined })
  })

  it('has no target for other anonymous requests', () => {
    expect(resolveAuditTarget({ path: '/get-session', hasSession: false }))
      .toEqual({ targetType: undefined, targetId: undefined })
  })
})

describe('the audited success paths', () => {
  it.each(['/sign-in/email', '/sign-up/email', '/request-password-reset', '/reset-password', '/admin/remove-user'])('logs a successful %s', (path) => {
    expect(AUDITED_SUCCESS_PATHS).toContain(path)
  })
})
