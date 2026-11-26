// SPDX-License-Identifier: MIT
import type { OrgRole } from '~~/shared/utils/permissions'
import { describe, expect, it } from 'vitest'
import {
  admin,
  API_KEY_MANAGER_ROLES,
  hasPermission,
  hasRole,
  isAdminOrOwner,
  isOwner,
  isSystemAdmin,
  member,
  owner,
  parseRoles,
  toggleOrgRole
} from '~~/shared/utils/permissions'

describe('parseRoles', () => {
  it.each([
    ['a single role', 'owner', ['owner']],
    ['a role list', 'owner,admin', ['owner', 'admin']],
    ['a role list with spaces', 'admin, owner', ['admin', 'owner']],
    ['a differently cased role, kept as is', 'Owner', ['Owner']],
    ['an empty string', '', []],
    ['separators only', ',,', []],
    ['empty entries between roles', 'admin,,member,', ['admin', 'member']]
  ])('reads %s', (_label, role, expected) => {
    expect(parseRoles(role)).toEqual(expected)
  })

  it.each([null, undefined])('reads no role from %s', (role) => {
    expect(parseRoles(role)).toEqual([])
  })
})

describe('hasRole with a list of wanted roles', () => {
  it.each([
    ['owner', ['owner']],
    ['owner,admin', ['owner']],
    ['admin, owner', ['owner']],
    ['admin,member', ['owner', 'admin']]
  ] satisfies [string, OrgRole[]][])('accepts "%s" for %j', (role, roles) => {
    expect(hasRole(role, roles)).toBe(true)
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
    expect(hasRole(role, roles)).toBe(false)
  })
})

describe('hasRole with one wanted role', () => {
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

describe('isSystemAdmin', () => {
  it.each([
    ['a single role', 'admin'],
    ['a role list', 'user,admin'],
    ['a role list with spaces', 'user, admin']
  ])('recognises %s', (_label, role) => {
    expect(isSystemAdmin(role)).toBe(true)
  })

  it.each([
    ['a differently cased role', 'Admin'],
    ['another role', 'user'],
    ['null', null],
    ['undefined', undefined],
    ['an empty string', '']
  ])('does not recognise %s', (_label, role) => {
    expect(isSystemAdmin(role)).toBe(false)
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

// The project routes check API_KEY_MANAGER_ROLES, the API key plugin
// checks the `apiKey` grants of `ac`: both must name the same roles.
describe('the API key manager roles match the apiKey grants', () => {
  const roles = { owner, admin, member }
  const actions = ['create', 'read', 'update', 'delete'] as const

  it.each(Object.keys(roles) as (keyof typeof roles)[])('agrees on %s for every action', (role) => {
    for (const action of actions) {
      expect(roles[role].authorize({ apiKey: [action] }).success, action)
        .toBe(hasRole(role, API_KEY_MANAGER_ROLES))
    }
  })
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
