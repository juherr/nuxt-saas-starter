// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESOLVED_CLIENT_IP_HEADER } from '~~/server/utils/clientIp'
import { CLIENT_IP_CONTEXT_KEY } from '~~/server/utils/requestClientIp'
import { stubNitroGlobals } from './support/nitroGlobals'

const { requestClientIp }: { requestClientIp: unknown } = await import('~~/server/utils/requestClientIp')
const clientIp = requestClientIp as (event: FakeEvent) => string | undefined

const runtimeConfig = vi.hoisted(() => ({ trustedProxies: '', clientIpHeader: '' }))

const CARRIED = '203.0.113.50'
const FORGED = '6.6.6.6'

interface FakeEvent {
  headers: Record<string, string>
  context: Record<string, unknown>
  node: { req: { socket: { remoteAddress: string }, __unenv__?: Record<string, unknown> } }
}

/** A request from a real socket, as node-server hands it to h3. */
function httpEvent(remoteAddress: string, headers: Record<string, string> = {}): FakeEvent {
  return { headers, context: {}, node: { req: { socket: { remoteAddress } } } }
}

/**
 * An in-process sub-request (`event.$fetch`, `useRequestFetch` in SSR):
 * node-mock-http gives it a socket with an empty `remoteAddress` and sets
 * `req.__unenv__` to the context passed by h3 `fetchWithEvent`, the outer
 * `event.context` (node-mock-http `callNodeRequestHandler`).
 */
function inProcessEvent(outerContext: Record<string, unknown>, headers: Record<string, string> = {}): FakeEvent {
  return { headers, context: {}, node: { req: { socket: { remoteAddress: '' }, __unenv__: outerContext } } }
}

beforeAll(() => {
  stubNitroGlobals()
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
  // h3 1.15 `getRequestIP`: the socket address, `undefined` when empty.
  vi.stubGlobal('getRequestIP', (event: FakeEvent) => event.node.req.socket.remoteAddress || undefined)
})
beforeEach(() => {
  runtimeConfig.trustedProxies = ''
  runtimeConfig.clientIpHeader = ''
})
afterAll(() => {
  vi.unstubAllGlobals()
})

describe('requestClientIp on an HTTP request', () => {
  it('reads the socket address', () => {
    expect(clientIp(httpEvent('198.51.100.20', { 'x-forwarded-for': FORGED }))).toBe('198.51.100.20')
  })

  it('walks X-Forwarded-For past a trusted proxy', () => {
    runtimeConfig.trustedProxies = '10.0.0.1'

    expect(clientIp(httpEvent('10.0.0.1', { 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('ignores a carried IP its own event context holds', () => {
    const event = httpEvent('198.51.100.20')
    event.context[CLIENT_IP_CONTEXT_KEY] = FORGED

    expect(clientIp(event)).toBe('198.51.100.20')
  })

  it('resolves from the edge header when the platform context has no carried IP (cloudflare-module)', () => {
    runtimeConfig.clientIpHeader = 'cf-connecting-ip'
    const event = inProcessEvent({ cf: {}, waitUntil: () => {}, _platform: {} }, { 'cf-connecting-ip': '203.0.113.7' })

    expect(clientIp(event)).toBe('203.0.113.7')
  })
})

describe('requestClientIp on an in-process sub-request', () => {
  it('uses the IP the outer request resolved', () => {
    const event = inProcessEvent({ [CLIENT_IP_CONTEXT_KEY]: CARRIED })

    expect(clientIp(event)).toBe(CARRIED)
  })

  it('ignores forged internal and forwarded headers the outer request passed on', () => {
    runtimeConfig.trustedProxies = '10.0.0.0/8'
    runtimeConfig.clientIpHeader = 'x-real-ip'
    const event = inProcessEvent({ [CLIENT_IP_CONTEXT_KEY]: CARRIED }, {
      [RESOLVED_CLIENT_IP_HEADER]: FORGED,
      'x-forwarded-for': FORGED,
      'x-real-ip': FORGED
    })

    expect(clientIp(event)).toBe(CARRIED)
  })

  it('does not walk forged X-Forwarded-For when the carried IP is a trusted proxy', () => {
    runtimeConfig.trustedProxies = '10.0.0.0/8'
    const event = inProcessEvent({ [CLIENT_IP_CONTEXT_KEY]: '10.1.2.3' }, { 'x-forwarded-for': FORGED })

    expect(clientIp(event)).toBe('10.1.2.3')
  })

  it('stays unresolved when the outer request had no IP, whatever headers it passed on', () => {
    runtimeConfig.clientIpHeader = 'x-real-ip'
    const event = inProcessEvent({ [CLIENT_IP_CONTEXT_KEY]: null }, { 'x-real-ip': FORGED })

    expect(clientIp(event)).toBeUndefined()
  })
})

describe('the client IP middleware', () => {
  async function runMiddleware(event: FakeEvent) {
    const { default: middleware }: { default: unknown } = await import('~~/server/middleware/0.client-ip')
    ;(middleware as (event: FakeEvent) => void)(event)
  }

  it('stores the resolved IP in the event context', async () => {
    const event = httpEvent('198.51.100.20')

    await runMiddleware(event)

    expect(event.context[CLIENT_IP_CONTEXT_KEY]).toBe('198.51.100.20')
  })

  it('stores null when no IP can be trusted', async () => {
    const event = httpEvent('')

    await runMiddleware(event)

    expect(event.context[CLIENT_IP_CONTEXT_KEY]).toBeNull()
  })

  it('hands the outer IP on to a nested sub-request', async () => {
    const event = inProcessEvent({ [CLIENT_IP_CONTEXT_KEY]: CARRIED }, { 'x-forwarded-for': FORGED })

    await runMiddleware(event)

    expect(event.context[CLIENT_IP_CONTEXT_KEY]).toBe(CARRIED)
  })
})
