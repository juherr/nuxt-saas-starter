// SPDX-License-Identifier: MIT
import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { organization } from 'better-auth/plugins'
import { beforeAll, describe, expect, it } from 'vitest'
import { apiKeyPluginOptions } from '~~/server/utils/apiKeyOptions'
import { ac, admin, member, owner } from '~~/shared/utils/permissions'

// Wires the real better-auth endpoints with the app's access control and
// API key options, over an in-memory database: the plugin itself decides
// who may create an organization's keys.
function createAuth() {
  return betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'test-secret-that-is-long-enough-for-better-auth',
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      organization: [],
      member: [],
      invitation: [],
      apiKey: []
    }),
    plugins: [
      organization({ ac, roles: { owner, admin, member } }),
      apiKey(apiKeyPluginOptions)
    ]
  })
}

type Auth = ReturnType<typeof createAuth>

async function signUp(auth: Auth, name: string) {
  const { headers, response } = await auth.api.signUpEmail({
    body: { email: `${name}@example.test`, password: 'password-1234', name },
    returnHeaders: true
  })
  const sessionCookie = headers.get('set-cookie')?.split(';')[0]
  if (!sessionCookie) {
    throw new Error(`No session cookie for ${name}`)
  }
  return { userId: response.user.id, headers: new Headers({ cookie: sessionCookie }) }
}

const statusOf = (promise: Promise<unknown>) =>
  promise.then(() => 'created', (error: { statusCode?: number }) => error.statusCode)

describe('creating an organization API key through the plugin', () => {
  let auth: Auth
  let organizationId: string
  let callers: Record<'owner' | 'admin' | 'member' | 'outsider', Headers>

  beforeAll(async () => {
    auth = createAuth()
    const ownerUser = await signUp(auth, 'owner')
    const adminUser = await signUp(auth, 'admin')
    const memberUser = await signUp(auth, 'member')
    const outsider = await signUp(auth, 'outsider')
    const created = await auth.api.createOrganization({
      body: { name: 'Acme', slug: 'acme' },
      headers: ownerUser.headers
    })
    if (!created) {
      throw new Error('Organization not created')
    }
    organizationId = created.id
    await auth.api.addMember({ body: { userId: adminUser.userId, organizationId, role: 'admin' } })
    await auth.api.addMember({ body: { userId: memberUser.userId, organizationId, role: 'member' } })
    callers = {
      owner: ownerUser.headers,
      admin: adminUser.headers,
      member: memberUser.headers,
      outsider: outsider.headers
    }
  })

  it.each(['owner', 'admin'] as const)('lets the organization %s create a key owned by the organization', async (role) => {
    const created = await auth.api.createApiKey({
      body: { name: `${role}-key`, organizationId },
      headers: callers[role]
    })

    expect(created.referenceId).toBe(organizationId)
  })

  // The plugin answers distinct messages for a non-member and a member
  // without the permission; both are 403.
  it('refuses a plain member with 403', async () => {
    expect(await statusOf(auth.api.createApiKey({
      body: { name: 'member-key', organizationId },
      headers: callers.member
    }))).toBe(403)
  })

  it('refuses a user outside the organization with 403', async () => {
    expect(await statusOf(auth.api.createApiKey({
      body: { name: 'outsider-key', organizationId },
      headers: callers.outsider
    }))).toBe(403)
  })

  it('refuses a key that names no organization with 400', async () => {
    expect(await statusOf(auth.api.createApiKey({
      body: { name: 'orphan-key' },
      headers: callers.owner
    }))).toBe(400)
  })
})
