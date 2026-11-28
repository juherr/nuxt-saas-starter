// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESOLVED_CLIENT_IP_HEADER } from '~~/server/utils/clientIp'
import { CLIENT_IP_CONTEXT_KEY } from '~~/server/utils/requestClientIp'
import { stubNitroGlobals } from './support/nitroGlobals'

const handler = vi.hoisted(() => vi.fn(async (_request: Request) => new Response('ok')))
const runtimeConfig = vi.hoisted(() => ({ trustedProxies: '', clientIpHeader: '' }))

vi.mock('~~/server/utils/auth', () => ({ useServerAuth: () => ({ handler }) }))

const SOCKET = '198.51.100.20'

interface FakeEvent {
  headers: Record<string, string>
  request: Request
  node?: { req: { __unenv__: Record<string, unknown> } }
}

beforeAll(() => {
  stubNitroGlobals()
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
  vi.stubGlobal('getRequestIP', () => SOCKET)
  vi.stubGlobal('toWebRequest', (event: FakeEvent) => event.request)
})
afterAll(() => {
  vi.unstubAllGlobals()
})

async function signIn(headers: Record<string, string>, outerContext?: Record<string, unknown>) {
  const { default: route }: { default: unknown } = await import('~~/server/api/auth/[...all]')
  const request = new Request('https://saas.example.test/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'a@example.test' })
  })
  await (route as (event: FakeEvent) => Promise<Response>)({ headers, request, node: outerContext ? { req: { __unenv__: outerContext } } : undefined })
  const call = handler.mock.lastCall
  if (!call)
    throw new Error('better-auth was not called')
  return call[0]
}

// better-auth keys its rate limit and session IP on the internal header
// (`advanced.ipAddress.ipAddressHeaders`), and the audit hook reads it too.
describe('the request handed to better-auth', () => {
  beforeEach(() => {
    handler.mockClear()
    runtimeConfig.trustedProxies = ''
  })

  it('carries the socket address when no proxy is trusted', async () => {
    const request = await signIn({ 'x-forwarded-for': '6.6.6.6' })

    expect(request.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe(SOCKET)
  })

  it('replaces a forged internal header', async () => {
    const request = await signIn({ [RESOLVED_CLIENT_IP_HEADER]: '6.6.6.6' })

    expect(request.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe(SOCKET)
  })

  it('carries the client behind a trusted proxy', async () => {
    runtimeConfig.trustedProxies = SOCKET

    const request = await signIn({ 'x-forwarded-for': '203.0.113.9' })

    expect(request.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe('203.0.113.9')
  })

  // SSR `useFetch('/api/auth/get-session')` runs in process: node-mock-http
  // exposes the outer `event.context` as `req.__unenv__` and forwards the
  // outer request's headers, forged ones included.
  it('carries the IP the outer request resolved on an in-process sub-request', async () => {
    const request = await signIn(
      { [RESOLVED_CLIENT_IP_HEADER]: '6.6.6.6', 'x-forwarded-for': '6.6.6.6' },
      { [CLIENT_IP_CONTEXT_KEY]: '203.0.113.50' }
    )

    expect(request.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe('203.0.113.50')
  })

  it('keeps the request body', async () => {
    const request = await signIn({})

    await expect(request.json()).resolves.toEqual({ email: 'a@example.test' })
  })
})
