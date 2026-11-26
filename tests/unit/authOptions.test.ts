// SPDX-License-Identifier: MIT
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '~~/server/db/schema'

const db = vi.hoisted(() => {
  const where = vi.fn(async () => [])
  const selectWhere = vi.fn(async (): Promise<{ id: string }[]> => [])
  const from = vi.fn(() => ({ where: selectWhere }))
  return { where, selectWhere, from, delete: vi.fn(() => ({ where })), select: vi.fn(() => ({ from })) }
})
const fileService = vi.hoisted(() => ({ deleteFile: vi.fn(async (_id: string, _actor?: string) => true) }))
const createFileService = vi.hoisted(() => vi.fn(async () => fileService))
vi.mock('~~/server/services/file/fileService', () => ({ createFileService }))
const settledUpgrade = { context: { body: { plan: 'pro', customerType: 'organization', referenceId: 'org-1', seats: 3 } } }
const checkoutSeatsOverride = vi.hoisted(() => vi.fn())

vi.mock('better-auth', async importOriginal => ({
  ...await importOriginal<typeof import('better-auth')>(),
  // Hand back the options instead of building an auth instance.
  betterAuth: (options: unknown) => options
}))
vi.mock('~~/server/utils/runtimeConfig', () => ({
  runtimeConfig: { public: { baseURL: 'https://saas.example.test' } }
}))
vi.mock('~~/server/utils/db', () => ({ getDB: () => db }))
const resend = vi.hoisted(() => ({ emails: { send: vi.fn() } }))
const getResendClient = vi.hoisted(() => vi.fn((): unknown => undefined))
const renderTeamInvite = vi.hoisted(() => vi.fn(async () => '<html></html>'))
vi.mock('~~/server/utils/drivers', () => ({ cacheClient: {}, getResendClient }))
vi.mock('~~/server/utils/email', () => ({
  renderDeleteAccount: vi.fn(),
  renderResetPassword: vi.fn(),
  renderTeamInvite,
  renderVerifyEmail: vi.fn()
}))
vi.mock('~~/server/utils/auditLogger', () => ({ logAuditEvent: vi.fn() }))
vi.mock('~~/server/utils/emails', () => ({}))
vi.mock('~~/server/utils/stripe', () => ({
  checkoutSeatsOverride,
  createStripeClient: vi.fn(),
  isStripeConfigured: () => false,
  resolveUpgradeReferenceId: () => 'org-1',
  setupStripe: vi.fn()
}))
// The before hook resolves the session itself: read it from the context.
vi.mock('better-auth/api', async importOriginal => ({
  ...await importOriginal<typeof import('better-auth/api')>(),
  getSessionFromCtx: vi.fn(async (ctx: any) => ctx.context?.session ?? null)
}))

const { createBetterAuth } = await import('~~/server/utils/auth')
const options = createBetterAuth() as any

// authStorage.test.ts covers the values of authStorageOptions; these check
// that createBetterAuth passes them on, since hub:kv cannot consume or count
// atomically.
describe('the better-auth storage options', () => {
  it('stores verification values in the database', () => {
    expect(options.verification?.storeInDatabase).toBe(true)
  })

  it('stores rate-limit counters in the database', () => {
    expect(options.rateLimit?.storage).toBe('database')
  })
})

describe('the before hook', () => {
  it('hands an upgrade the body the checkout seats override settles', async () => {
    checkoutSeatsOverride.mockResolvedValue(settledUpgrade)
    const session = { user: { id: 'user-1' }, session: { id: 'session-1' } }

    const result = await options.hooks.before({ path: '/subscription/upgrade', body: { plan: 'pro' }, context: { session } })

    expect(result).toEqual(settledUpgrade)
    expect(checkoutSeatsOverride).toHaveBeenCalledWith(expect.objectContaining({ body: { plan: 'pro' } }), session)
  })
})

describe('the invitation email', () => {
  it('links to the accept-invite page', async () => {
    getResendClient.mockReturnValueOnce(resend)
    const organizationPlugin = options.plugins.find((plugin: any) => plugin.id === 'organization')

    await organizationPlugin.options.sendInvitationEmail({
      email: 'invitee@example.test',
      inviter: { user: { name: 'Ada', email: 'ada@example.test' } },
      organization: { name: 'Acme' },
      invitation: { id: 'inv-1' }
    })

    expect(renderTeamInvite).toHaveBeenCalledWith('Ada', 'Acme', 'https://saas.example.test/accept-invite/inv-1')
    expect(resend.emails.send).toHaveBeenCalledTimes(1)
  })
})

describe('the organization create hook', () => {
  const organization = { name: 'Acme', slug: 'acme' }
  const organizationHooks = () => options.plugins.find((plugin: any) => plugin.id === 'organization').options.organizationHooks

  // A database hook cannot see the creator; the plugin hook receives it.
  it('runs in the organization plugin, not as database hooks', () => {
    expect(organizationHooks().beforeCreateOrganization).toBeTypeOf('function')
    expect(Object.keys(options.databaseHooks).sort()).toEqual(['session', 'user'])
  })

  it('copies the creator\'s referral code onto the organization', async () => {
    const user = { id: 'user-1', email: 'ada@example.test', referralCode: 'REF-42' }

    const result = await organizationHooks().beforeCreateOrganization({ organization, user })

    expect(result).toEqual({ data: { ...organization, referralCode: 'REF-42' } })
  })

  it('leaves the organization unchanged for a creator without a referral code', async () => {
    const user = { id: 'user-1', email: 'ada@example.test', referralCode: null }

    const result = await organizationHooks().beforeCreateOrganization({ organization, user })

    expect(result).toBeUndefined()
  })
})

describe('the user create hook', () => {
  // better-auth types the hook context as nullable, and passes no context
  // (`undefined`) when a user is created outside an endpoint
  // (better-auth dist/db/with-hooks.mjs).
  it('leaves the user unchanged when there is no endpoint context', async () => {
    const result = await options.databaseHooks.user.create.before({ id: 'user-1', email: 'a@example.test' }, null)

    expect(result).toBeUndefined()
  })
})

describe('the user delete hook', () => {
  beforeEach(() => {
    db.delete.mockClear()
    db.where.mockClear()
    db.select.mockClear()
    db.from.mockClear()
    db.selectWhere.mockReset()
    db.selectWhere.mockResolvedValue([])
    fileService.deleteFile.mockReset()
    fileService.deleteFile.mockResolvedValue(true)
    createFileService.mockReset()
    createFileService.mockResolvedValue(fileService)
  })

  // file.uploaded_by has no foreign key to user: the hook deletes the
  // stored objects and the rows itself, inactive files included.
  it('deletes every file the deleted user uploaded', async () => {
    db.selectWhere.mockResolvedValue([{ id: 'file-1' }, { id: 'file-2' }])

    const result = await options.databaseHooks.user.delete?.after?.({ id: 'user-1' }, null)

    expect(db.from).toHaveBeenCalledWith(schema.file)
    const [[where]] = db.selectWhere.mock.calls as unknown as [[SQL]]
    // No is_active filter and no limit: inactive files go too.
    expect(new PgDialect().sqlToQuery(where)).toMatchObject({ sql: '"file"."uploaded_by" = $1', params: ['user-1'] })
    expect(fileService.deleteFile.mock.calls).toEqual([['file-1', 'user-1'], ['file-2', 'user-1']])
    expect(result).not.toBe(false)
  })

  it('records the signed-in user as the actor of the file deletions', async () => {
    db.selectWhere.mockResolvedValue([{ id: 'file-1' }])

    await options.databaseHooks.user.delete?.after?.({ id: 'user-1' }, { context: { session: { user: { id: 'admin-1' } } } })

    expect(fileService.deleteFile).toHaveBeenCalledWith('file-1', 'admin-1')
  })

  it('keeps deleting the account when a stored file cannot be deleted', async () => {
    db.selectWhere.mockResolvedValue([{ id: 'file-1' }, { id: 'file-2' }, { id: 'file-3' }])
    fileService.deleteFile.mockImplementation(async (id: string) => {
      if (id === 'file-2') {
        throw new Error('storage unavailable')
      }
      return true
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const result = await options.databaseHooks.user.delete?.after?.({ id: 'user-1' }, null)

      expect(result).not.toBe(false)
      expect(fileService.deleteFile.mock.calls.map(([id]) => id)).toEqual(['file-1', 'file-2', 'file-3'])
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('file-2'), expect.any(Error))
    } finally {
      consoleError.mockRestore()
    }
  })

  it('keeps deleting the account when the file service cannot be built', async () => {
    db.selectWhere.mockResolvedValue([{ id: 'file-1' }])
    createFileService.mockRejectedValue(new Error('S3 storage is missing NUXT_FILE_MANAGER_STORAGE_S3_BUCKET_NAME'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const result = await options.databaseHooks.user.delete?.after?.({ id: 'user-1' }, null)

      expect(result).not.toBe(false)
      expect(consoleError).toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  // A missing storage configuration must not break deleting a user who
  // never uploaded anything.
  it('does not build the file service when the user has no files', async () => {
    await options.databaseHooks.user.delete?.after?.({ id: 'user-1' }, null)

    expect(createFileService).not.toHaveBeenCalled()
  })

  // api_key.reference_id has no foreign key to user since better-auth 1.5,
  // so nothing in the database removes the keys of a deleted user.
  it('deletes the API keys the deleted user owns', async () => {
    const result = await options.databaseHooks.user.delete?.before?.({ id: 'user-1' })

    expect(db.delete).toHaveBeenCalledWith(schema.apiKey)
    expect(db.where).toHaveBeenCalledTimes(1)
    const [[where]] = db.where.mock.calls as unknown as [[SQL]]
    const condition = new PgDialect().sqlToQuery(where)
    expect(condition).toMatchObject({ sql: '"api_key"."reference_id" = $1', params: ['user-1'] })
    // better-auth cancels the deletion when a before hook returns false.
    expect(result).not.toBe(false)
  })

  // Stored objects cannot be restored: deleting them before the user row
  // would lose them when the deletion fails or another hook cancels it.
  it('leaves the files alone until the user row is deleted', async () => {
    db.selectWhere.mockResolvedValue([{ id: 'file-1' }])

    await options.databaseHooks.user.delete?.before?.({ id: 'user-1' }, null)

    expect(db.select).not.toHaveBeenCalled()
    expect(createFileService).not.toHaveBeenCalled()
    expect(fileService.deleteFile).not.toHaveBeenCalled()
  })

  // The user row is already gone when the after hook runs, and better-auth
  // clears the cached sessions only once it returns
  // (db/internal-adapter.mjs deleteUser): it must never throw.
  it('keeps the deletion done when the file lookup fails', async () => {
    db.selectWhere.mockRejectedValue(new Error('connection lost'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(options.databaseHooks.user.delete?.after?.({ id: 'user-1' }, null)).resolves.toBeUndefined()
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error))
    } finally {
      consoleError.mockRestore()
    }
  })
})
