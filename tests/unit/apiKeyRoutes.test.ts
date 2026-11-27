// SPDX-License-Identifier: MIT
import type { SQL } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRoute, stubNitroGlobals } from './support/nitroGlobals'
import { renderSql } from './support/sql'

const getAuthSession = vi.hoisted(() => vi.fn())
const memberships = vi.hoisted(() => ({ current: {} as Record<string, string> }))
const findMember = vi.hoisted(() => vi.fn())
const findKey = vi.hoisted(() => vi.fn())
const selectedRows = vi.hoisted(() => ({ current: [] as unknown[] }))
const select = vi.hoisted(() => vi.fn())
const deleteWhere = vi.hoisted(() => vi.fn(async (_where: unknown) => undefined))
const deleteFrom = vi.hoisted(() => vi.fn((_table: unknown) => ({ where: deleteWhere })))

vi.mock('~~/server/utils/auth', () => ({ getAuthSession }))
vi.mock('~~/server/utils/db', () => ({
  useDB: async () => ({
    query: {
      member: { findFirst: findMember },
      apiKey: { findFirst: findKey }
    },
    select,
    delete: deleteFrom
  })
}))

beforeAll(stubNitroGlobals)

/** Answers a membership lookup from `memberships`, keyed by the exact organization id queried. */
function memberLookup({ where }: { where: SQL }) {
  const [organizationId = '', userId] = renderSql(where).params as string[]
  const role = memberships.current[organizationId]
  return Promise.resolve(role ? { organizationId, userId, role } : undefined)
}

interface SelectQuery { columns: Record<string, unknown>, join?: { kind: string, on: unknown }, where?: unknown }
let selectQueries: SelectQuery[]

function selectChain(columns: Record<string, unknown>) {
  const query: SelectQuery = { columns }
  selectQueries.push(query)
  const chain = {
    from: () => chain,
    innerJoin: (_table: unknown, on: unknown) => {
      query.join = { kind: 'inner', on }
      return chain
    },
    leftJoin: (_table: unknown, on: unknown) => {
      query.join = { kind: 'left', on }
      return chain
    },
    where: async (where: unknown) => {
      query.where = where
      return selectedRows.current
    }
  }
  return chain
}

const listKeys = (organizationId?: string) =>
  callRoute<unknown[]>(() => import('~~/server/api/organization/api-keys.get'), undefined, { organizationId })
const deleteKey = (id: string) =>
  callRoute(() => import('~~/server/api/organization/api-keys/[id].delete'), undefined, undefined, { id })

const errorOf = (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => e)

describe('organization API key routes', () => {
  beforeEach(() => {
    getAuthSession.mockReset().mockResolvedValue({ user: { id: 'u1' } })
    memberships.current = { 'org-1': 'owner' }
    findMember.mockReset().mockImplementation(memberLookup)
    findKey.mockReset().mockResolvedValue(undefined)
    selectedRows.current = []
    selectQueries = []
    select.mockReset().mockImplementation(selectChain)
    deleteFrom.mockClear()
    deleteWhere.mockClear()
  })

  describe('listing', () => {
    it('refuses an anonymous caller with 401 before reading anything', async () => {
      getAuthSession.mockResolvedValue(null)

      await expect(listKeys('org-1')).rejects.toMatchObject({ statusCode: 401 })
      expect(findMember).not.toHaveBeenCalled()
      expect(select).not.toHaveBeenCalled()
    })

    it('answers 400 when no organization is named', async () => {
      await expect(listKeys()).rejects.toMatchObject({ statusCode: 400 })
      expect(select).not.toHaveBeenCalled()
    })

    it('refuses an ordinary member and a non-member with the same 403, without listing', async () => {
      memberships.current = { 'org-1': 'member' }
      const asMember = await errorOf(listKeys('org-1'))
      memberships.current = {}
      const asStranger = await errorOf(listKeys('org-1'))

      expect(asMember).toMatchObject({ statusCode: 403 })
      expect(asStranger).toMatchObject({ statusCode: 403, statusMessage: (asMember as any).statusMessage })
      expect(select).not.toHaveBeenCalled()
    })

    it.each(['owner', 'admin', 'member,admin'])('lets the organization %s list its keys', async (role) => {
      memberships.current = { 'org-1': role }

      await expect(listKeys('org-1')).resolves.toEqual([])
    })

    it.each([
      ['an ordinary member', 'member'],
      ['another casing of admin', 'Admin'],
      ['a custom role absent from the access control', 'sale']
    ])('refuses %s with 403, without listing', async (_label, role) => {
      memberships.current = { 'org-1': role }

      await expect(listKeys('org-1')).rejects.toMatchObject({ statusCode: 403 })
      expect(select).not.toHaveBeenCalled()
    })

    it('lists only keys owned by exactly the requested organization, not by one whose id contains it', async () => {
      memberships.current = { 'org-1': 'owner', 'org-12': 'owner' }

      await listKeys('org-1')

      const [query] = selectQueries
      const where = renderSql(query!.where)
      expect(where.sql).toBe('"api_key"."reference_id" = $1')
      expect(where.params).toEqual(['org-1'])
    })

    it('answers display fields only, never the key hash, owner or metadata', async () => {
      selectedRows.current = [{
        id: 'key-1',
        name: 'ci',
        start: 'abcdef',
        prefix: null,
        enabled: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastRequest: null,
        expiresAt: null,
        key: 'hashed-secret',
        referenceId: 'org-1',
        metadata: '{"note":"ci"}'
      }]
      const displayFields = ['createdAt', 'enabled', 'expiresAt', 'id', 'lastRequest', 'name', 'prefix', 'start']

      const [listed] = await listKeys('org-1')

      expect(Object.keys(selectQueries[0]!.columns).sort()).toEqual(displayFields)
      expect(Object.keys(listed as object).sort()).toEqual(displayFields)
    })

    it('reads the owning organization from reference_id alone, never from the metadata', async () => {
      await listKeys('org-1')

      const [query] = selectQueries
      expect(query!.join).toBeUndefined()
      expect(renderSql(query!.where).sql).not.toMatch(/metadata|like/i)
    })
  })

  describe('revoking', () => {
    it('refuses an anonymous caller with 401 before any lookup', async () => {
      getAuthSession.mockResolvedValue(null)

      await expect(deleteKey('key-1')).rejects.toMatchObject({ statusCode: 401 })
      expect(findKey).not.toHaveBeenCalled()
      expect(deleteFrom).not.toHaveBeenCalled()
    })

    it('finds the key\'s organization by the exact key id, without reading its hash', async () => {
      await errorOf(deleteKey('key-1'))

      const [lookup] = findKey.mock.calls[0]!
      expect(renderSql(lookup.where)).toMatchObject({
        sql: '"api_key"."id" = $1',
        params: ['key-1']
      })
      expect(lookup.columns).toEqual({ id: true, referenceId: true })
    })

    it.each(['owner', 'admin', 'member,admin'])('lets the %s of the key\'s organization revoke it', async (role) => {
      memberships.current = { 'org-1': role }
      findKey.mockResolvedValue({ id: 'key-1', referenceId: 'org-1' })

      await expect(deleteKey('key-1')).resolves.toEqual({ success: true })
      expect(deleteFrom).toHaveBeenCalledTimes(1)
      expect(renderSql(deleteWhere.mock.calls[0]![0])).toMatchObject({ sql: '"api_key"."id" = $1', params: ['key-1'] })
    })

    it.each([
      ['an unknown key', 'key-unknown', undefined],
      ['another organization\'s key', 'key-12', { id: 'key-12', referenceId: 'org-12' }],
      ['a key of an organization the caller is only a member of', 'key-2', { id: 'key-2', referenceId: 'org-2' }],
      ['a legacy key whose reference is the caller\'s user id', 'key-legacy', { id: 'key-legacy', referenceId: 'u1' }]
    ])('answers the same 404 as for an unknown key for %s, deleting nothing', async (_label, keyId, found) => {
      memberships.current = { 'org-1': 'owner', 'org-2': 'member' }
      findKey.mockResolvedValue(undefined)
      const unknownKeyRefusal = await errorOf(deleteKey('key-unknown'))

      findKey.mockResolvedValue(found)
      const refusal = await errorOf(deleteKey(keyId))

      expect(refusal).toMatchObject({ statusCode: 404, statusMessage: (unknownKeyRefusal as any).statusMessage })
      expect(deleteFrom).not.toHaveBeenCalled()
    })

    it.each([
      ['an ordinary member', 'member'],
      ['another casing of admin', 'Admin'],
      ['a custom role absent from the access control', 'sale']
    ])('answers 404 to %s of the key\'s organization, deleting nothing', async (_label, role) => {
      memberships.current = { 'org-1': role }
      findKey.mockResolvedValue({ id: 'key-1', referenceId: 'org-1' })

      await expect(deleteKey('key-1')).rejects.toMatchObject({ statusCode: 404 })
      expect(deleteFrom).not.toHaveBeenCalled()
    })
  })
})
