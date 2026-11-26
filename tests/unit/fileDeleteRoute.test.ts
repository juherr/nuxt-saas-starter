// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRoute, stubNitroGlobals, stubRequestContext, TEST_AGENT, TEST_IP } from './support/nitroGlobals'

const getFile = vi.hoisted(() => vi.fn())
const deleteFile = vi.hoisted(() => vi.fn())
const requireAuth = vi.hoisted(() => vi.fn())

vi.mock('~~/server/services/file/fileService', () => ({
  FileService: class {
    getFile = getFile
    deleteFile = deleteFile
  },
  useFileManagerConfig: () => ({ storage: { provider: 'local' } })
}))
vi.mock('~~/server/services/file/storage/factory', () => ({
  createStorageProvider: async () => ({ name: 'test' })
}))

beforeAll(() => {
  stubNitroGlobals()
  vi.stubGlobal('requireAuth', requireAuth)
  stubRequestContext()
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const OWNER = { id: 'owner', role: 'user' }
const remove = (id = 'f1') =>
  callRoute<{ success: boolean }>(() => import('~~/server/api/file/[id].delete'), undefined, undefined, { id })

describe('deleting a file', () => {
  beforeEach(() => {
    getFile.mockReset().mockImplementation(async (id: string) => id === 'f1' ? { id, uploadedBy: OWNER.id } : null)
    deleteFile.mockReset().mockResolvedValue(true)
    requireAuth.mockReset().mockResolvedValue(OWNER)
  })

  it('lets the owner delete the file and records who did it', async () => {
    await expect(remove()).resolves.toMatchObject({ success: true })

    expect(deleteFile).toHaveBeenCalledWith('f1', OWNER.id, TEST_IP, TEST_AGENT)
  })

  it('lets an admin delete another user\'s file and records the admin', async () => {
    requireAuth.mockResolvedValue({ id: 'admin', role: 'admin' })

    await expect(remove()).resolves.toMatchObject({ success: true })

    expect(deleteFile).toHaveBeenCalledWith('f1', 'admin', TEST_IP, TEST_AGENT)
  })

  it.each(['user,admin', 'user, admin'])('lets an admin holding the role list "%s" delete another user\'s file', async (role) => {
    requireAuth.mockResolvedValue({ id: 'admin', role })

    await expect(remove()).resolves.toMatchObject({ success: true })

    expect(deleteFile).toHaveBeenCalledWith('f1', 'admin', TEST_IP, TEST_AGENT)
  })

  it.each([
    ['another user', { id: 'other', role: 'user' }],
    ['another user without a role', { id: 'other' }],
    ['another user with a non-admin role', { id: 'other', role: 'moderator' }],
    ['another user with a role list without admin', { id: 'other', role: 'user,moderator' }],
    ['another user with a differently cased admin role', { id: 'other', role: 'user,Admin' }]
  ])('answers %s with the same 404 as a missing file', async (_label, user) => {
    requireAuth.mockResolvedValue(user)

    const [denied, missing] = await Promise.all([
      remove().catch((e: unknown) => e),
      remove('unknown').catch((e: unknown) => e)
    ])

    expect(denied).toMatchObject({ statusCode: 404, statusMessage: 'File not found' })
    expect(denied).toEqual(missing)
    expect(deleteFile).not.toHaveBeenCalled()
  })

  it('refuses an anonymous request with 401', async () => {
    requireAuth.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))

    await expect(remove()).rejects.toMatchObject({ statusCode: 401 })
    expect(getFile).not.toHaveBeenCalled()
    expect(deleteFile).not.toHaveBeenCalled()
  })

  it('answers a generic 500 when the stored file cannot be deleted', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('EACCES: permission denied, unlink \'/srv/uploads/a.png\'')
    deleteFile.mockRejectedValue(failure)

    const error = await remove().catch((e: unknown) => e)

    expect(error).toMatchObject({ statusCode: 500, statusMessage: 'File deletion failed' })
    expect((error as Error).message).not.toMatch(/EACCES|srv/)
    expect(consoleError).toHaveBeenCalledWith('[file/delete]', failure)
    consoleError.mockRestore()
  })

  it('answers 404 for an unknown file', async () => {
    await expect(remove('unknown')).rejects.toMatchObject({ statusCode: 404 })
    expect(deleteFile).not.toHaveBeenCalled()
  })
})
