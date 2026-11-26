// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nitroCreateError } from './support/nitroGlobals'

const runtimeConfig = vi.hoisted(() => ({
  preset: 'cloudflare-module',
  databaseUrl: 'postgres://u:p@db:5432/app',
  betterAuthSecret: 'secret',
  resendApiKey: '' as string | undefined,
  stripeSecretKey: '' as string | undefined,
  stripeWebhookSecret: '',
  public: {
    baseURL: 'https://saas.example.test',
    appName: 'Acme',
    appNotifyEmail: 'notify@example.test',
    appEnv: 'production'
  }
}))
const betterAuth = vi.hoisted(() => vi.fn((options: any) => ({ options, api: {} })))

vi.mock('~~/server/utils/runtimeConfig', () => ({ runtimeConfig }))
vi.mock('better-auth', () => ({ betterAuth }))
vi.mock('better-auth/adapters/drizzle', () => ({ drizzleAdapter: vi.fn(() => ({})) }))
// An organization upgrade counts the organization's seats; none is found.
vi.mock('~~/server/utils/db', () => ({
  getDB: vi.fn(() => ({})),
  useDB: vi.fn(async () => ({ query: { organization: { findFirst: vi.fn(async () => undefined) } } }))
}))
vi.mock('~~/server/utils/auditLogger', () => ({ logAuditEvent: vi.fn() }))
vi.mock('~~/server/utils/email', () => ({
  renderDeleteAccount: vi.fn(async () => '<p>delete</p>'),
  renderResetPassword: vi.fn(async () => '<p>reset</p>'),
  renderTeamInvite: vi.fn(async () => '<p>invite</p>'),
  renderVerifyEmail: vi.fn(async () => '<p>verify</p>')
}))
vi.mock('~~/server/utils/stripeEmails', () => ({}))
vi.mock('~~/server/utils/subscription-handlers', () => ({ removeExcessMembersOnExpiration: vi.fn() }))
// Real requests reach the before hook without a session; the hook resolves it
// itself. Keep the real behaviour when a test provides one, and answer
// "anonymous" otherwise instead of calling the real session endpoint.
vi.mock('better-auth/api', async importOriginal => ({
  ...await importOriginal<typeof import('better-auth/api')>(),
  getSessionFromCtx: vi.fn(async (ctx: any) => ctx.context?.session ?? null)
}))

vi.stubGlobal('createError', nitroCreateError)

const user = { id: 'u1', name: 'Ada', email: 'ada@example.test' }

async function authOptions() {
  const { createBetterAuth } = await import('~~/server/utils/auth')
  createBetterAuth()
  return betterAuth.mock.calls.at(-1)![0] as any
}

async function stubResendSend(result: { data?: unknown, error?: { message: string } | null }) {
  const { getResendClient } = await import('~~/server/utils/drivers')
  const client = getResendClient()!
  return vi.spyOn(client.emails, 'send').mockResolvedValue(result as any)
}

describe('optional services', () => {
  let spies: ReturnType<typeof vi.spyOn>[]

  beforeEach(() => {
    vi.resetModules()
    betterAuth.mockClear()
    runtimeConfig.resendApiKey = ''
    runtimeConfig.stripeSecretKey = ''
    runtimeConfig.public.appEnv = 'production'
    spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map(level => vi.spyOn(console, level).mockImplementation(() => {}))
  })

  afterEach(() => {
    spies.forEach(spy => spy.mockRestore())
  })

  const loggedText = () => spies
    .flatMap(spy => spy.mock.calls.flat())
    .map(arg => (arg instanceof Error ? arg.stack : typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join('\n')

  describe('stripe', () => {
    it('sets up auth without the billing plugin when no secret key is configured', async () => {
      const options = await authOptions()

      expect(options.plugins.map((plugin: any) => plugin.id)).not.toContain('stripe')
    })

    it('keeps the billing plugin when a secret key is configured', async () => {
      runtimeConfig.stripeSecretKey = 'sk_test_canary'

      const options = await authOptions()

      expect(options.plugins.map((plugin: any) => plugin.id)).toContain('stripe')
    })

    it('disables the billing plugin\'s cancel and restore endpoints in favour of the app routes', async () => {
      runtimeConfig.stripeSecretKey = 'sk_test_canary'

      const options = await authOptions()

      expect(options.disabledPaths).toEqual(expect.arrayContaining(['/subscription/cancel', '/subscription/restore']))
      expect(options.disabledPaths).not.toContain('/subscription/upgrade')
    })

    it('refuses the disabled endpoints by their resolved path, whatever the request path looked like', async () => {
      const { refuseDisabledEndpoint } = await import('~~/server/utils/auth')

      for (const path of ['/subscription/cancel', '/subscription/restore']) {
        expect(() => refuseDisabledEndpoint(path)).toThrow(expect.objectContaining({ statusCode: 404 }))
      }
      for (const path of ['/subscription/upgrade', '/subscription/list', '/sign-in/email']) {
        expect(() => refuseDisabledEndpoint(path)).not.toThrow()
      }
    })

    it('runs the disabled-endpoint check before every auth endpoint', async () => {
      const options = await authOptions()

      await expect(options.hooks.before({ path: '/subscription/cancel' })).rejects.toMatchObject({ statusCode: 404 })
      await expect(options.hooks.before({ path: '/subscription/upgrade' })).resolves.toBeUndefined()
    })

    describe('upgrading a named subscription', () => {
      const session = { user: { id: 'user-1' }, session: { id: 'session-1' } }
      // What the before hook hands the endpoint once the upgrade is settled.
      const settledFor = (referenceId: string, customerType: 'organization' | 'user') => ({
        context: { body: customerType === 'user' ? { customerType, seats: 1 } : { customerType, referenceId, seats: 1 } }
      })

      function upgradeRequest(
        body: Record<string, unknown> | undefined,
        rows: Array<{ referenceId: string }>,
        withSession = true,
        activeOrganizationId?: string
      ) {
        const findMany = vi.fn(async () => rows)
        const requestSession = { ...session, session: { ...session.session, activeOrganizationId } }
        return {
          findMany,
          ctx: {
            path: '/subscription/upgrade',
            body,
            context: { session: withSession ? requestSession : null, adapter: { findMany } }
          }
        }
      }

      it('decides ownership only when every matching row belongs to the reference', async () => {
        const { isSubscriptionOwnedByReference } = await import('~~/server/utils/auth')

        expect(isSubscriptionOwnedByReference([{ referenceId: 'org-1' }], 'org-1')).toBe(true)
        expect(isSubscriptionOwnedByReference([{ referenceId: 'org-1' }, { referenceId: 'org-1' }], 'org-1')).toBe(true)
        expect(isSubscriptionOwnedByReference([], 'org-1')).toBe(false)
        expect(isSubscriptionOwnedByReference([{ referenceId: 'org-2' }], 'org-1')).toBe(false)
        expect(isSubscriptionOwnedByReference([{ referenceId: 'org-1' }, { referenceId: 'org-2' }], 'org-1')).toBe(false)
      })

      it('answers 404 and stops before the endpoint when the subscription belongs to another reference', async () => {
        const options = await authOptions()
        const { ctx } = upgradeRequest({ plan: 'pro', referenceId: 'org-1', subscriptionId: 'sub-a' }, [{ referenceId: 'org-2' }])

        await expect(options.hooks.before(ctx)).rejects.toMatchObject({ statusCode: 404 })
      })

      it('answers 404 when no subscription matches the id', async () => {
        const options = await authOptions()
        const { ctx } = upgradeRequest({ plan: 'pro', referenceId: 'org-1', subscriptionId: 'sub-unknown' }, [])

        await expect(options.hooks.before(ctx)).rejects.toMatchObject({ statusCode: 404 })
      })

      it('looks the subscription up the way the billing plugin does', async () => {
        const options = await authOptions()
        const { ctx, findMany } = upgradeRequest({ plan: 'pro', referenceId: 'org-1', subscriptionId: 'sub-a' }, [{ referenceId: 'org-1' }])

        await expect(options.hooks.before(ctx)).resolves.toMatchObject(settledFor('org-1', 'organization'))
        expect(findMany).toHaveBeenCalledWith({
          model: 'subscription',
          where: [
            { field: 'id', value: 'sub-a', connector: 'OR' },
            { field: 'stripeSubscriptionId', value: 'sub-a', connector: 'OR' }
          ]
        })
      })

      it('lets the upgrade through when the subscription belongs to the user, the default reference', async () => {
        const options = await authOptions()
        const { ctx } = upgradeRequest({ plan: 'pro', subscriptionId: 'sub-a' }, [{ referenceId: 'user-1' }])

        await expect(options.hooks.before(ctx)).resolves.toMatchObject(settledFor('user-1', 'user'))
      })

      it('checks the subscription against the active organization the upgrade bills when no reference is sent', async () => {
        const options = await authOptions()
        const owned = upgradeRequest({ plan: 'pro', subscriptionId: 'sub-a' }, [{ referenceId: 'org-1' }], true, 'org-1')
        const foreign = upgradeRequest({ plan: 'pro', subscriptionId: 'sub-a' }, [{ referenceId: 'user-1' }], true, 'org-1')

        await expect(options.hooks.before(owned.ctx)).resolves.toMatchObject(settledFor('org-1', 'organization'))
        await expect(options.hooks.before(foreign.ctx)).rejects.toMatchObject({ statusCode: 404 })
      })

      it('lets an upgrade without a subscription id through without any lookup', async () => {
        const options = await authOptions()
        const { ctx, findMany } = upgradeRequest({ plan: 'pro', referenceId: 'org-1' }, [{ referenceId: 'org-2' }])

        await expect(options.hooks.before(ctx)).resolves.toMatchObject(settledFor('org-1', 'organization'))
        expect(findMany).not.toHaveBeenCalled()
      })

      it('leaves an anonymous request to the endpoint\'s own session check', async () => {
        const options = await authOptions()
        const { ctx, findMany } = upgradeRequest({ plan: 'pro', subscriptionId: 'sub-a' }, [{ referenceId: 'org-2' }], false)

        await expect(options.hooks.before(ctx)).resolves.toBeUndefined()
        expect(findMany).not.toHaveBeenCalled()
      })

      it('does not check subscriptions on other endpoints', async () => {
        const options = await authOptions()
        const { ctx, findMany } = upgradeRequest({ subscriptionId: 'sub-a' }, [{ referenceId: 'org-2' }])

        await expect(options.hooks.before({ ...ctx, path: '/subscription/list' })).resolves.toBeUndefined()
        expect(findMany).not.toHaveBeenCalled()
      })
    })

    it('answers 503 instead of crashing when a client is requested without a key', async () => {
      const { createStripeClient } = await import('~~/server/utils/stripe')

      expect(() => createStripeClient()).toThrow(expect.objectContaining({ statusCode: 503 }))
    })
  })

  describe('the delete-account email', () => {
    const sendDeleteAccountVerification = async () => {
      const options = await authOptions()
      return options.user.deleteUser.sendDeleteAccountVerification({ user, url: 'https://saas.example.test/delete?token=t' })
    }

    it('is sent from the app notification address', async () => {
      runtimeConfig.resendApiKey = 're_canary_key'
      const send = await stubResendSend({ data: { id: 'm1' }, error: null })

      await sendDeleteAccountVerification()

      expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: 'Acme <notify@example.test>', to: user.email }))
    })

    it('fails when the provider rejects the message', async () => {
      runtimeConfig.resendApiKey = 're_canary_key'
      await stubResendSend({ error: { message: 'invalid from' } })

      await expect(sendDeleteAccountVerification()).rejects.toMatchObject({ statusCode: 500 })
      expect(loggedText()).toContain('invalid from')
    })
  })

  describe('the email verification hook', () => {
    const token = 'canary-verification-token'
    const url = `https://saas.example.test/api/auth/verify-email?token=${token}`

    const sendVerificationEmail = async () => {
      const options = await authOptions()
      await options.emailVerification.sendVerificationEmail({ user, url, token })
    }

    it('does not log the link in production when the mail is sent', async () => {
      runtimeConfig.resendApiKey = 're_canary_key'
      const send = await stubResendSend({ data: { id: 'm1' }, error: null })

      await sendVerificationEmail()

      expect(send).toHaveBeenCalled()
      expect(loggedText()).not.toContain(token)
    })

    it('does not log the link in production when the mail fails', async () => {
      runtimeConfig.resendApiKey = 're_canary_key'
      await stubResendSend({ error: { message: 'provider down' } })

      await sendVerificationEmail()

      const logged = loggedText()
      expect(logged).toContain('provider down')
      expect(logged).not.toContain(token)
    })

    it('does not log the link in production when Resend is not configured', async () => {
      await sendVerificationEmail()

      expect(loggedText()).not.toContain(token)
    })

    // better-auth's unauthenticated resend only calls this hook for an
    // unverified address and rethrows what it throws: resolving keeps the
    // endpoint's answer identical for unknown, verified and unverified
    // addresses, so the failure is only logged as an error.
    describe('resolves without revealing the account, and logs an error, when', () => {
      it('resend is not configured', async () => {
        await expect(sendVerificationEmail()).resolves.toBeUndefined()

        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to send verification email: Resend is not configured'))
      })

      it('the provider answers with an error', async () => {
        runtimeConfig.resendApiKey = 're_canary_key'
        await stubResendSend({ error: { message: 'provider down' } })

        await expect(sendVerificationEmail()).resolves.toBeUndefined()

        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to send verification email: provider down'))
      })

      it('the provider request rejects', async () => {
        runtimeConfig.resendApiKey = 're_canary_key'
        const { getResendClient } = await import('~~/server/utils/drivers')
        vi.spyOn(getResendClient()!.emails, 'send').mockRejectedValue(new Error('socket hang up'))

        await expect(sendVerificationEmail()).resolves.toBeUndefined()

        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to send verification email: socket hang up'))
      })
    })

    it('logs the link in development so sign-up works without Resend', async () => {
      runtimeConfig.public.appEnv = 'development'

      await sendVerificationEmail()

      expect(loggedText()).toContain(token)
    })
  })
})
