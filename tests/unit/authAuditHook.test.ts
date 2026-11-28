// SPDX-License-Identifier: MIT
import { APIError } from 'better-auth/api'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RESOLVED_CLIENT_IP_HEADER } from '~~/server/utils/clientIp'

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
const logAuditEvent = vi.hoisted(() => vi.fn())

vi.mock('~~/server/utils/runtimeConfig', () => ({ runtimeConfig }))
vi.mock('better-auth', () => ({ betterAuth }))
vi.mock('better-auth/adapters/drizzle', () => ({ drizzleAdapter: vi.fn(() => ({})) }))
vi.mock('~~/server/utils/db', () => ({ getDB: vi.fn(() => ({})), useDB: vi.fn(async () => ({})) }))
vi.mock('~~/server/utils/auditLogger', () => ({ logAuditEvent }))
vi.mock('~~/server/utils/email', () => ({}))
vi.mock('~~/server/utils/stripeEmails', () => ({}))
vi.mock('~~/server/utils/subscription-handlers', () => ({ removeExcessMembersOnExpiration: vi.fn() }))

async function afterHook() {
  const { createBetterAuth } = await import('~~/server/utils/auth')
  createBetterAuth()
  return (betterAuth.mock.calls.at(-1)![0] as any).hooks.after
}

// better-auth's adminMiddleware puts the caller's session on ctx.context
// before the handler runs, so hooks.after sees it on success and failure.
function removeUserRequest(sessionUserId: string, returned: unknown, body: unknown = { userId: 'u2' }) {
  return {
    path: '/admin/remove-user',
    body,
    headers: new Headers(),
    getHeader: () => undefined,
    context: {
      session: { user: { id: sessionUserId }, session: { id: 'session-1' } },
      returned
    }
  }
}

describe('auditing an admin user removal', () => {
  beforeEach(() => {
    vi.resetModules()
    betterAuth.mockClear()
    logAuditEvent.mockClear()
  })

  it('logs the acting admin and the removed user on success', async () => {
    const after = await afterHook()

    await after(removeUserRequest('admin-1', { success: true }))

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1',
      category: 'auth',
      action: '/admin/remove-user',
      targetType: 'user',
      targetId: 'u2',
      status: 'success'
    }))
  })

  it('logs the caller and the user they tried to remove on failure', async () => {
    const after = await afterHook()

    await after(removeUserRequest('member-1', new APIError('FORBIDDEN')))

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'member-1',
      category: 'auth',
      action: '/admin/remove-user',
      targetType: 'user',
      targetId: 'u2',
      status: 'failure'
    }))
  })

  it('logs the rejected request when the user id cannot be stringified', async () => {
    const after = await afterHook()
    const body = JSON.parse('{"userId":{"toString":1}}')

    await after(removeUserRequest('admin-1', new APIError('BAD_REQUEST'), body))

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1',
      action: '/admin/remove-user',
      targetType: 'user',
      targetId: undefined,
      status: 'failure'
    }))
  })
})

describe('the IP recorded by the audit hook', () => {
  beforeEach(() => {
    vi.resetModules()
    betterAuth.mockClear()
    logAuditEvent.mockClear()
  })

  // The auth handler resolves the IP and sets the internal header; a
  // client-sent X-Forwarded-For must not reach the audit row (#24).
  it('records the resolved IP, not X-Forwarded-For', async () => {
    const after = await afterHook()
    const headers: Record<string, string> = {
      [RESOLVED_CLIENT_IP_HEADER]: '198.51.100.20',
      'x-forwarded-for': '6.6.6.6',
      'remoteAddress': '6.6.6.7'
    }

    await after({ ...removeUserRequest('admin-1', { success: true }), headers: new Headers(headers), getHeader: (name: string) => headers[name] })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ ipAddress: '198.51.100.20' }))
  })

  it('records no IP when none was resolved', async () => {
    const after = await afterHook()
    const headers: Record<string, string> = { 'x-forwarded-for': '6.6.6.6', 'remoteAddress': '6.6.6.7' }

    await after({ ...removeUserRequest('admin-1', { success: true }), headers: new Headers(headers), getHeader: (name: string) => headers[name] })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ ipAddress: undefined }))
  })
})
