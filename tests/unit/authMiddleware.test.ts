// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubNitroGlobals } from './support/nitroGlobals'

const requireAuth = vi.hoisted(() => vi.fn())

vi.mock('~~/server/utils/auth', () => ({ requireAuth }))

beforeAll(stubNitroGlobals)
afterAll(() => {
  vi.unstubAllGlobals()
})

async function runMiddleware(path: string) {
  const { default: handler } = await import('~~/server/middleware/1.auth')
  return (handler as (event: unknown) => Promise<unknown>)({ path })
}

describe('the /api/admin guard', () => {
  beforeEach(() => {
    requireAuth.mockReset()
  })

  it.each(['admin', 'admin,user', 'user,admin', 'user, admin'])('lets a user holding "%s" through', async (role) => {
    requireAuth.mockResolvedValue({ id: 'u1', role })

    await expect(runMiddleware('/api/admin/users')).resolves.toBeUndefined()
  })

  it.each([
    ['user', 'user'],
    ['a role list without admin', 'user,moderator'],
    ['a role only containing admin', 'superadmin'],
    ['a differently cased admin role', 'user,Admin'],
    ['no role', undefined]
  ])('refuses a user with %s with 403', async (_label, role) => {
    requireAuth.mockResolvedValue({ id: 'u1', role })

    await expect(runMiddleware('/api/admin/users')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('lets an anonymous request\'s 401 through', async () => {
    requireAuth.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))

    await expect(runMiddleware('/api/admin/users')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('leaves other paths alone', async () => {
    await expect(runMiddleware('/api/organization/list')).resolves.toBeUndefined()
    expect(requireAuth).not.toHaveBeenCalled()
  })
})
