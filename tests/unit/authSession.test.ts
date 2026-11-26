// SPDX-License-Identifier: MIT
import type { H3Event } from 'h3'
import { beforeAll, describe, expect, it, vi } from 'vitest'

interface GetSessionOptions {
  headers: Headers
  query?: { disableCookieCache?: boolean }
}

const getSession = vi.hoisted(() => vi.fn(async (_opts: GetSessionOptions): Promise<unknown> => null))

vi.mock('better-auth', async importOriginal => ({
  ...await importOriginal<typeof import('better-auth')>(),
  // Hand back an auth instance whose only API is the session read.
  betterAuth: () => ({ api: { getSession } })
}))
vi.mock('~~/server/utils/runtimeConfig', () => ({
  runtimeConfig: { public: { baseURL: 'https://saas.example.test' } }
}))
vi.mock('~~/server/utils/db', () => ({ getDB: vi.fn() }))
vi.mock('~~/server/utils/drivers', () => ({ cacheClient: {}, getResendClient: vi.fn() }))
vi.mock('~~/server/utils/email', () => ({}))
vi.mock('~~/server/utils/auditLogger', () => ({ logAuditEvent: vi.fn() }))
vi.mock('~~/server/utils/stripe', () => ({
  createStripeClient: vi.fn(),
  isStripeConfigured: () => false,
  setupStripe: vi.fn()
}))

// h3 is not a direct dependency, so the tests cannot build a real event:
// this one carries only the headers the stubbed `getRequestHeaders` reads.
const event = { headers: new Headers({ cookie: 'better-auth.session_token=signed-token' }) } as H3Event

beforeAll(() => {
  vi.stubGlobal('getRequestHeaders', (e: { headers: Headers }) => Object.fromEntries(e.headers))
})

const { getAuthSession } = await import('~~/server/utils/auth')

describe('getAuthSession', () => {
  // The cookie cache would keep a deleted user's session alive for up to its
  // maxAge (#45): API handlers read the session from the database.
  it('asks better-auth for a session that bypasses the cookie cache', async () => {
    await getAuthSession(event)

    expect(getSession).toHaveBeenCalledWith(expect.objectContaining({
      query: { disableCookieCache: true }
    }))
  })

  it('forwards the request cookies', async () => {
    await getAuthSession(event)

    const call = getSession.mock.lastCall
    if (!call)
      throw new Error('getSession was not called')
    expect(call[0].headers.get('cookie')).toBe('better-auth.session_token=signed-token')
  })
})
