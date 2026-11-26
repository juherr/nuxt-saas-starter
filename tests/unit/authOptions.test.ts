// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '~~/server/db/schema'
import { renderSql } from './support/sql'

const db = vi.hoisted(() => {
  const where = vi.fn(async (_condition: unknown) => [])
  const selectWhere = vi.fn(async (_condition: unknown): Promise<({ id: string } | { image: string | null })[]> => [])
  const from = vi.fn(() => ({ where: selectWhere }))
  return { where, selectWhere, from, delete: vi.fn((_table: unknown) => ({ where })), select: vi.fn(() => ({ from })) }
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

describe('the API key plugin endpoints the app does not use', () => {
  const unused = ['/api-key/get', '/api-key/list', '/api-key/update', '/api-key/delete']

  it('are disabled, while creation and server-side verification stay available', () => {
    expect(options.disabledPaths).toEqual(expect.arrayContaining(unused))
    expect(options.disabledPaths).not.toContain('/api-key/create')
    expect(options.disabledPaths).not.toContain('/api-key/verify')
  })

  it.each(unused)('refuses %s by its resolved path', async (path) => {
    await expect(options.hooks.before({ path })).rejects.toMatchObject({ statusCode: 404 })
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

describe('the organization delete hook', () => {
  // The foreign key api_key.reference_id -> organization.id (ON DELETE
  // CASCADE, server/db/queries) deletes the keys with their organization.
  it('leaves the organization\'s API keys to the database foreign key', () => {
    const organizationPlugin = options.plugins.find((plugin: any) => plugin.id === 'organization')

    expect(organizationPlugin.options.organizationHooks.beforeDeleteOrganization).toBeUndefined()
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
    // No is_active filter and no limit: inactive files go too.
    expect(renderSql(db.selectWhere.mock.calls[0]?.[0])).toMatchObject({ sql: '"file"."uploaded_by" = $1', params: ['user-1'] })
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

  // API keys belong to organizations (reference_id is an organization id),
  // so deleting a user deletes none: a user id there would only match a
  // key created before organization ownership, which no route lists.
  it('deletes no API key with the user', async () => {
    const result = await options.databaseHooks.user.delete?.before?.({ id: 'user-1' }, null)

    expect(db.delete).not.toHaveBeenCalled()
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

describe('the user update hook', () => {
  const previousImage = 'https://files.example.test/avatar-old.png'
  const newImage = 'https://files.example.test/avatar-new.png'
  // better-auth passes the same endpoint context object to the before and
  // the after hook of one update (db/with-hooks.mjs updateWithHooks).
  const selfUpdate = () => ({ path: '/update-user', context: { session: { user: { id: 'user-1' } } } })

  // Runs the before hook, then the after hook with the updated user, as
  // updateWithHooks does.
  async function updateUser(data: Record<string, unknown>, updated: Record<string, unknown>, context: unknown = selfUpdate()) {
    const before = await options.databaseHooks.user.update.before(data, context)
    const after = await options.databaseHooks.user.update.after(updated, context)
    return { before, after }
  }

  beforeEach(() => {
    db.select.mockClear()
    db.from.mockClear()
    db.selectWhere.mockReset()
    db.selectWhere.mockResolvedValue([])
    fileService.deleteFile.mockReset()
    fileService.deleteFile.mockResolvedValue(true)
    createFileService.mockReset()
    createFileService.mockResolvedValue(fileService)
  })

  it('deletes the previous avatar file when the avatar is replaced', async () => {
    db.selectWhere
      .mockResolvedValueOnce([{ image: previousImage }])
      .mockResolvedValueOnce([{ id: 'file-old' }])

    const { before, after } = await updateUser({ image: newImage }, { id: 'user-1', image: newImage })

    expect(before).toBeUndefined()
    expect(after).toBeUndefined()
    expect(db.from.mock.calls).toEqual([[schema.user], [schema.file]])
    expect(renderSql(db.selectWhere.mock.calls[0]?.[0])).toMatchObject({ sql: '"user"."id" = $1', params: ['user-1'] })
    // Only a file the user uploaded: another user's file at the same URL
    // is never touched.
    expect(renderSql(db.selectWhere.mock.calls[1]?.[0])).toMatchObject({
      sql: '("file"."url" = $1 and "file"."uploaded_by" = $2)',
      params: [previousImage, 'user-1']
    })
    expect(fileService.deleteFile.mock.calls).toEqual([['file-old', 'user-1']])
  })

  it('deletes the previous avatar file when the avatar is removed', async () => {
    db.selectWhere
      .mockResolvedValueOnce([{ image: previousImage }])
      .mockResolvedValueOnce([{ id: 'file-old' }])

    await updateUser({ image: '' }, { id: 'user-1', image: '' })

    expect(fileService.deleteFile.mock.calls).toEqual([['file-old', 'user-1']])
  })

  it('keeps the file when the avatar is unchanged', async () => {
    db.selectWhere.mockResolvedValueOnce([{ image: previousImage }])

    await updateUser({ image: previousImage }, { id: 'user-1', image: previousImage })

    expect(db.selectWhere).toHaveBeenCalledTimes(1)
    expect(createFileService).not.toHaveBeenCalled()
    expect(fileService.deleteFile).not.toHaveBeenCalled()
  })

  it('deletes nothing when the previous avatar is not a file the user uploaded', async () => {
    db.selectWhere
      .mockResolvedValueOnce([{ image: 'https://avatars.example.test/oauth.png' }])
      .mockResolvedValueOnce([])

    await updateUser({ image: newImage }, { id: 'user-1', image: newImage })

    expect(createFileService).not.toHaveBeenCalled()
    expect(fileService.deleteFile).not.toHaveBeenCalled()
  })

  it('does not read the user when the update carries no image', async () => {
    // update-user passes `image: undefined` when the body has none.
    await updateUser({ name: 'Ada', image: undefined }, { id: 'user-1', image: previousImage })

    expect(db.select).not.toHaveBeenCalled()
    expect(fileService.deleteFile).not.toHaveBeenCalled()
  })

  // An admin updates another user through /admin/update-user with the
  // admin's session: the session user is not the updated user.
  it('leaves the avatar file alone on updates other than the user\'s own', async () => {
    const adminUpdate = { path: '/admin/update-user', context: { session: { user: { id: 'admin-1' } } } }

    await updateUser({ image: newImage }, { id: 'user-1', image: newImage }, adminUpdate)

    expect(db.select).not.toHaveBeenCalled()
    expect(fileService.deleteFile).not.toHaveBeenCalled()
  })

  // The user row is already updated when the after hook runs: a cleanup
  // failure must not turn it into an error.
  it('keeps the update done when the previous file cannot be deleted', async () => {
    db.selectWhere
      .mockResolvedValueOnce([{ image: previousImage }])
      .mockResolvedValueOnce([{ id: 'file-old' }])
    fileService.deleteFile.mockRejectedValue(new Error('storage unavailable'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const { after } = await updateUser({ image: newImage }, { id: 'user-1', image: newImage })

      expect(after).toBeUndefined()
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('file-old'), expect.any(Error))
    } finally {
      consoleError.mockRestore()
    }
  })

  it('keeps the update done when the file lookup fails', async () => {
    db.selectWhere
      .mockResolvedValueOnce([{ image: previousImage }])
      .mockRejectedValueOnce(new Error('connection lost'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const { after } = await updateUser({ image: newImage }, { id: 'user-1', image: newImage })

      expect(after).toBeUndefined()
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error))
    } finally {
      consoleError.mockRestore()
    }
  })

  // A failed read must not block the update itself.
  it('lets the update through when the current avatar cannot be read', async () => {
    db.selectWhere.mockRejectedValueOnce(new Error('connection lost'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const { before, after } = await updateUser({ image: newImage }, { id: 'user-1', image: newImage })

      expect(before).toBeUndefined()
      expect(after).toBeUndefined()
      expect(fileService.deleteFile).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })
})
