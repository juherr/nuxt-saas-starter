// SPDX-License-Identifier: MIT
import type { Table } from 'drizzle-orm'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nitroCreateError } from './support/nitroGlobals'
import { renderSql } from './support/sql'

const runtimeConfig = vi.hoisted(() => ({
  preset: 'cloudflare-module',
  databaseUrl: 'postgres://u:p@db:5432/app',
  betterAuthSecret: 'secret',
  resendApiKey: '',
  stripeSecretKey: '',
  stripeWebhookSecret: '',
  public: {
    baseURL: 'https://saas.example.test',
    appName: 'Acme',
    appNotifyEmail: 'notify@example.test',
    appEnv: 'production'
  }
}))
const betterAuth = vi.hoisted(() => vi.fn((options: any) => ({ options, api: {} })))
const deleteWhere = vi.hoisted(() => vi.fn(async (_where: unknown) => undefined))
const deleteFrom = vi.hoisted(() => vi.fn((_table: unknown) => ({ where: deleteWhere })))
const logAuditEvent = vi.hoisted(() => vi.fn())

vi.mock('~~/server/utils/runtimeConfig', () => ({ runtimeConfig }))
vi.mock('better-auth', () => ({ betterAuth }))
vi.mock('better-auth/adapters/drizzle', () => ({ drizzleAdapter: vi.fn(() => ({})) }))
vi.mock('~~/server/utils/db', () => ({ getDB: vi.fn(() => ({ delete: deleteFrom })), useDB: vi.fn(async () => ({})) }))
vi.mock('~~/server/utils/auditLogger', () => ({ logAuditEvent }))
vi.mock('~~/server/utils/email', () => ({}))
vi.mock('~~/server/utils/stripeEmails', () => ({}))
vi.mock('~~/server/utils/subscription-handlers', () => ({ removeExcessMembersOnExpiration: vi.fn() }))

vi.stubGlobal('createError', nitroCreateError)

const session = { user: { id: 'user-1' }, session: { id: 'session-1' } }

async function authOptions() {
  const { createBetterAuth } = await import('~~/server/utils/auth')
  createBetterAuth()
  return betterAuth.mock.calls.at(-1)![0] as any
}

describe('the API key auth options', () => {
  beforeEach(() => {
    vi.resetModules()
    betterAuth.mockClear()
  })

  describe('the API key plugin endpoints the app does not use', () => {
    const unused = ['/api-key/get', '/api-key/list', '/api-key/update', '/api-key/delete']

    it('are disabled, while creation and server-side verification stay available', async () => {
      const options = await authOptions()

      expect(options.disabledPaths).toEqual(expect.arrayContaining(unused))
      expect(options.disabledPaths).not.toContain('/api-key/create')
      expect(options.disabledPaths).not.toContain('/api-key/verify')
    })

    it.each(unused)('refuses %s by its resolved path', async (path) => {
      const options = await authOptions()

      await expect(options.hooks.before({ path })).rejects.toMatchObject({ statusCode: 404 })
    })
  })

  describe('deleting an organization', () => {
    it('deletes the organization\'s API keys before the organization goes', async () => {
      deleteFrom.mockClear()
      deleteWhere.mockClear()
      const options = await authOptions()
      const organizationPlugin = options.plugins.find((plugin: { id: string }) => plugin.id === 'organization')

      await organizationPlugin.options.organizationHooks.beforeDeleteOrganization({
        organization: { id: 'org-1' },
        user: session.user
      })

      // Modules are reset between tests, so compare the table by its name.
      expect(deleteFrom).toHaveBeenCalledTimes(1)
      expect(getTableName(deleteFrom.mock.calls[0]![0] as Table)).toBe('api_key')
      expect(renderSql(deleteWhere.mock.calls[0]![0]).params).toEqual(['org-1'])
    })
  })
})
