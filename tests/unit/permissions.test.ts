// SPDX-License-Identifier: MIT
import type { OrgRole } from '~~/shared/utils/permissions'
import { describe, expect, it } from 'vitest'
import { isApiKeyManagerRole } from '~~/server/utils/apiKeyMetadata'
import {
  hasOrgRole,
  hasPermission,
  hasRole,
  isAdminOrOwner,
  isOwner,
  parseOrgRoles,
  toggleOrgRole
} from '~~/shared/utils/permissions'

describe('parseOrgRoles', () => {
  it.each([
    ['a single role', 'owner', ['owner']],
    ['a role list', 'owner,admin', ['owner', 'admin']],
    ['a role list with spaces', 'admin, owner', ['admin', 'owner']],
    ['a differently cased role, kept as is', 'Owner', ['Owner']],
    ['an empty string', '', []],
    ['separators only', ',,', []],
    ['empty entries between roles', 'admin,,member,', ['admin', 'member']]
  ])('reads %s', (_label, role, expected) => {
    expect(parseOrgRoles(role)).toEqual(expected)
  })

  it.each([null, undefined])('reads no role from %s', (role) => {
    expect(parseOrgRoles(role)).toEqual([])
  })
})

describe('hasOrgRole', () => {
  it.each([
    ['owner', ['owner']],
    ['owner,admin', ['owner']],
    ['admin, owner', ['owner']],
    ['admin,member', ['owner', 'admin']]
  ] satisfies [string, OrgRole[]][])('accepts "%s" for %j', (role, roles) => {
    expect(hasOrgRole(role, roles)).toBe(true)
  })

  it.each([
    ['admin,member', ['owner']],
    ['Owner', ['owner']],
    ['Owner,Admin', ['owner', 'admin']],
    ['', ['owner']],
    [',,', ['owner']],
    [null, ['owner']],
    [undefined, ['owner']],
    ['owner', []]
  ] satisfies [string | null | undefined, OrgRole[]][])('refuses %j for %j', (role, roles) => {
    expect(hasOrgRole(role, roles)).toBe(false)
  })
})

describe('hasRole', () => {
  it.each([
    ['a single role', 'admin'],
    ['a role list', 'admin,user'],
    ['a role list with the role last', 'user,admin'],
    ['a role list with spaces', 'user, admin']
  ])('finds admin in %s', (_label, role) => {
    expect(hasRole(role, 'admin')).toBe(true)
  })

  it.each([
    ['another role', 'user'],
    ['a role list without it', 'user,moderator'],
    ['a role that only contains it', 'superadmin'],
    ['a differently cased role', 'Admin'],
    ['a differently cased role list', 'user,ADMIN'],
    ['an empty string', ''],
    ['separators only', ',,'],
    ['null', null],
    ['undefined', undefined]
  ])('does not find admin in %s', (_label, role) => {
    expect(hasRole(role, 'admin')).toBe(false)
  })
})

describe('hasPermission', () => {
  it.each(['owner', 'owner,admin', 'admin, owner'])('grants MANAGE_BILLING to "%s"', (role) => {
    expect(hasPermission(role, 'MANAGE_BILLING')).toBe(true)
  })

  it.each(['admin', 'admin,member', 'Owner', '', ',,', null, undefined])('denies MANAGE_BILLING to %j', (role) => {
    expect(hasPermission(role, 'MANAGE_BILLING')).toBe(false)
  })

  it.each(['admin,member', 'member, admin'])('grants INVITE_MEMBERS to "%s"', (role) => {
    expect(hasPermission(role, 'INVITE_MEMBERS')).toBe(true)
  })
})

describe('isOwner', () => {
  it.each(['owner', 'owner,admin', 'admin, owner'])('recognises "%s" as owner', (role) => {
    expect(isOwner(role)).toBe(true)
  })

  it.each(['admin', 'admin,member', 'Owner', '', ',,', null, undefined])('does not take %j for an owner', (role) => {
    expect(isOwner(role)).toBe(false)
  })
})

describe('isAdminOrOwner', () => {
  it.each(['owner', 'admin', 'owner,admin', 'admin, owner', 'admin,member'])('recognises "%s"', (role) => {
    expect(isAdminOrOwner(role)).toBe(true)
  })

  it.each(['member', 'Admin', 'Owner,Admin', '', ',,', null, undefined])('does not recognise %j', (role) => {
    expect(isAdminOrOwner(role)).toBe(false)
  })
})

// apiKeyMetadata.ts stays import-free for the plain-Node backfill script,
// so it carries its own copy of the role-list parse: keep both in step.
describe('isApiKeyManagerRole matches hasOrgRole', () => {
  it.each(['owner', 'admin', 'member', 'owner,admin', 'admin, owner', 'admin,member', 'Owner', 'Admin', '', ',,', null, undefined])(
    'agrees on %j',
    (role) => {
      expect(isApiKeyManagerRole(role)).toBe(hasOrgRole(role, ['owner', 'admin']))
    }
  )
})

describe('toggleOrgRole', () => {
  it.each([
    ['adds an unchecked role at the end', ['admin'], 'member', true, ['admin', 'member']],
    ['keeps a role already held when checked', ['admin', 'member'], 'member', true, ['admin', 'member']],
    ['removes an unchecked role', ['admin', 'member'], 'member', false, ['admin']],
    ['keeps the list when unchecking a role not held', ['admin'], 'member', false, ['admin']],
    ['keeps roles outside the menu', ['sale', 'member'], 'admin', true, ['sale', 'member', 'admin']],
    ['returns an empty list when unchecking the last role', ['member'], 'member', false, []]
  ])('%s', (_label, roles, role, checked, expected) => {
    expect(toggleOrgRole(roles, role, checked)).toEqual(expected)
  })

  it('leaves the given list untouched', () => {
    const roles = ['admin', 'member']
    toggleOrgRole(roles, 'member', false)
    expect(roles).toEqual(['admin', 'member'])
  })
})
