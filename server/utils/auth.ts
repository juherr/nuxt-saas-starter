// SPDX-License-Identifier: MIT
import type { H3Event } from 'h3'
import type { DemoRequest } from '~~/shared/utils/demoMode'
import type { User } from '~~/shared/utils/types'
import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware, getOAuthState, getSessionFromCtx } from 'better-auth/api'
import { admin as adminPlugin, openAPI, organization } from 'better-auth/plugins'
import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import * as schema from '~~/server/db/schema'
import { createFileService } from '~~/server/services/file/fileService'
import { DEMO_MODE_RESTRICTED, DEMO_PROTECTION, DEMO_SESSION_UNRESOLVED, demoBlockReason, demoNeedsSession, demoSessionTokenToResolve } from '~~/shared/utils/demoMode'
import { buildInvitationUrl } from '~~/shared/utils/invitationUrl'
import { ac, orgRoles } from '~~/shared/utils/permissions'
import { userDisplayName } from '~~/shared/utils/userDisplayName'
import { apiKeyPluginOptions } from './apiKeyOptions'
import { logAuditEvent } from './auditLogger'
import { AUDITED_SUCCESS_PATHS, resolveAuditTarget } from './authAudit'
import { organizationAdditionalFields } from './authSchemaFields'
import { authStorageOptions } from './authStorage'
import { RESOLVED_CLIENT_IP_HEADER, withResolvedClientIp } from './clientIp'
import { getDB } from './db'
import { getResendClient } from './drivers'
import { renderDeleteAccount, renderResetPassword, renderTeamInvite, renderVerifyEmail } from './email'
import { memberHasRoleSql } from './memberRoleSql'
import { requestClientIp } from './requestClientIp'
import { runtimeConfig } from './runtimeConfig'
import { checkoutSeatsOverride, createStripeClient, isStripeConfigured, resolveUpgradeReferenceId, setupStripe } from './stripe'

console.log(`Base URL is ${runtimeConfig.public.baseURL}`)
console.log('Schema keys:', Object.keys(schema))

// Used by npm run auth:schema only.
const isAuthSchemaCommand = process.argv.some(arg => arg.includes('server/db/schema/auth.ts'))

const emailSender = () => `${runtimeConfig.public.appName} <${runtimeConfig.public.appNotifyEmail}>`

/**
 * Deletes each file as `actorId`. A failure to delete one file is logged,
 * with `describe(id)` naming it, and the others are still deleted;
 * deleteFile keeps the row and audits the failure, so the stored object can
 * be cleaned up later. The file service is built only when there is
 * something to delete, so a missing storage configuration does not get in
 * the way when the list is empty; a failure to build it is thrown.
 */
async function deleteFilesQuietly(fileIds: string[], actorId: string, describe: (id: string) => string) {
  if (!fileIds.length) {
    return
  }
  const fileService = await createFileService()
  for (const id of fileIds) {
    try {
      await fileService.deleteFile(id, actorId)
    } catch (error) {
      console.error(`[Auth] Failed to delete ${describe(id)}:`, error)
    }
  }
}

/**
 * Deletes every file `userId` uploaded, active or not: file.uploaded_by has
 * no foreign key to user.
 */
async function deleteUploadedFiles(userId: string, actorId: string) {
  const files = await getDB()
    .select({ id: schema.file.id })
    .from(schema.file)
    .where(eq(schema.file.uploadedBy, userId))
  await deleteFilesQuietly(files.map(({ id }) => id), actorId, id => `file ${id} of user ${userId}`)
}

/**
 * The avatar a user had before changing it on /update-user, keyed by the
 * endpoint context: better-auth hands the same context object to the
 * update.before and update.after hooks of one update, and the after hook
 * only sees the updated user (db/with-hooks.mjs updateWithHooks).
 */
const previousAvatars = new WeakMap<object, { userId: string, previousImage: string }>()

/**
 * Remembers the signed-in user's current avatar when they change it
 * themselves. An admin updating another user goes through
 * /admin/update-user and is left out. A failed read is logged and lets the
 * update through: the previous file then stays.
 */
async function rememberPreviousAvatar(data: { image?: string | null }, context: { path?: string, context?: { session?: { user: { id: string } } | null } } | null | undefined) {
  const userId = context?.context?.session?.user.id
  if (!context || context.path !== '/update-user' || data.image === undefined || !userId) {
    return
  }
  try {
    const [current] = await getDB()
      .select({ image: schema.user.image })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
    if (current?.image) {
      previousAvatars.set(context, { userId, previousImage: current.image })
    }
  } catch (error) {
    console.error(`[Auth] Cannot read the current avatar of user ${userId}:`, error)
  }
}

/**
 * Deletes the files behind the avatar a user replaced or removed. The only
 * link from an avatar to its file is `file.url`; a file another user
 * uploaded at the same URL is never touched. Never throws: the user row is
 * already updated.
 */
async function deleteReplacedAvatar(updated: { id: string, image?: string | null } | null, context: object | null | undefined) {
  if (!context) {
    return
  }
  const entry = previousAvatars.get(context)
  if (!entry) {
    return
  }
  previousAvatars.delete(context)
  const { userId, previousImage } = entry
  if (!updated || updated.id !== userId || updated.image === previousImage) {
    return
  }
  try {
    const files = await getDB()
      .select({ id: schema.file.id })
      .from(schema.file)
      .where(and(eq(schema.file.url, previousImage), eq(schema.file.uploadedBy, userId)))
    await deleteFilesQuietly(files.map(({ id }) => id), userId, id => `the previous avatar file ${id} of user ${userId}`)
  } catch (error) {
    console.error(`[Auth] Cannot delete the previous avatar files of user ${userId}:`, error)
  }
}

/**
 * Auth endpoints the app does not serve. Subscriptions are cancelled and
 * resumed through /api/stripe/cancel and /api/stripe/resume, which check
 * that the subscription belongs to the caller's organization; the billing
 * plugin's own endpoints for the same actions do not, so they are off.
 * Organization API keys are listed and revoked through
 * /api/organization/api-keys, which check the caller's role in the key's
 * organization and answer display fields only. The API key plugin's get,
 * list, update and delete endpoints are not used, so they stay off: the
 * app serves one path per action on a key, and creation (permission-checked
 * by the plugin in the key's organization) is the only native one.
 * Paths are relative to the /api/auth base path.
 */
export const DISABLED_AUTH_PATHS: readonly string[] = [
  '/subscription/cancel',
  '/subscription/restore',
  '/api-key/get',
  '/api-key/list',
  '/api-key/update',
  '/api-key/delete'
]

/**
 * Answers 404 for a disabled endpoint. `disabledPaths` compares the raw
 * request path; this check runs as a before hook on the endpoint the
 * router resolved, so it holds whatever form the request path took.
 */
export function refuseDisabledEndpoint(endpointPath: string) {
  if (DISABLED_AUTH_PATHS.includes(endpointPath)) {
    throw new APIError('NOT_FOUND')
  }
}

type AuthMiddlewareContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

/**
 * In the public demo, answers 403 `DEMO_MODE_RESTRICTED` to the requests
 * `demoBlockReason` refuses. The session is resolved only for the paths
 * whose decision depends on it, to keep the other requests cheap.
 */
async function refuseDemoRestrictedRequest(ctx: AuthMiddlewareContext) {
  let session: DemoRequest['session'] = null
  if (demoNeedsSession(ctx.path, ctx.body)) {
    const resolved = await getSessionFromCtx(ctx)
    if (resolved) {
      const activeOrganizationId = 'activeOrganizationId' in resolved.session
        && typeof resolved.session.activeOrganizationId === 'string'
        ? resolved.session.activeOrganizationId
        : null
      session = { userId: resolved.user.id, activeOrganizationId }
    } else if (ctx.getCookie(ctx.context.authCookies.sessionToken.name) !== null) {
      // getSessionFromCtx answers null on a failed lookup too, and the
      // endpoint looks the session up again: a session cookie the hook
      // cannot resolve fails closed. Presence only: an expired or forged
      // cookie gets the demo 403 instead of the endpoint's 401.
      session = DEMO_SESSION_UNRESOLVED
    }
  }
  // `/admin/revoke-user-session` names its target by session token only:
  // look the token up (secondary storage first, then the database) to
  // learn whose session it is.
  let sessionOwnerId: string | null = null
  const sessionToken = demoSessionTokenToResolve(ctx.path, ctx.body)
  if (sessionToken !== undefined) {
    const found = await ctx.context.internalAdapter.findSession(sessionToken)
    sessionOwnerId = found?.session.userId ?? null
  }
  const reason = demoBlockReason({ path: ctx.path, body: ctx.body, session, sessionOwnerId }, DEMO_PROTECTION)
  if (reason) {
    throw new APIError('FORBIDDEN', { message: reason, code: DEMO_MODE_RESTRICTED })
  }
}

/**
 * Whether the subscription rows found for a subscription id all belong to
 * the reference (user or organization) the request acts for. No row means
 * no subscription to act on.
 */
export function isSubscriptionOwnedByReference(rows: readonly { referenceId: string }[], referenceId: string) {
  return rows.length > 0 && rows.every(row => row.referenceId === referenceId)
}

/**
 * The billing plugin's upgrade endpoint authorizes the reference it acts
 * for, but loads a subscription named in the body by its id alone. Before
 * the endpoint runs, check that the subscription it will load belongs to
 * `referenceId`, the reference the upgrade settles on, matching rows
 * exactly as the plugin does, and answer the same generic 404 otherwise.
 * Requests that name no subscription are left to the endpoint.
 */
async function refuseForeignSubscriptionUpgrade(ctx: AuthMiddlewareContext, referenceId: string) {
  const subscriptionId = ctx.body?.subscriptionId
  if (!subscriptionId) {
    return
  }
  if (typeof subscriptionId !== 'string') {
    throw new APIError('NOT_FOUND')
  }
  const rows = await ctx.context.adapter.findMany<{ referenceId: string }>({
    model: 'subscription',
    where: [
      { field: 'id', value: subscriptionId, connector: 'OR' },
      { field: 'stripeSubscriptionId', value: subscriptionId, connector: 'OR' }
    ]
  })
  if (!isSubscriptionOwnedByReference(rows, referenceId)) {
    throw new APIError('NOT_FOUND')
  }
}

export const createBetterAuth = () => betterAuth({
  baseURL: runtimeConfig.public.baseURL,
  trustedOrigins: [
    'http://localhost:8787',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'http://localhost:4000',
    'http://127.0.0.1:8787',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:4000',
    runtimeConfig.public.baseURL
  ],
  secret: runtimeConfig.betterAuthSecret,
  disabledPaths: [...DISABLED_AUTH_PATHS],
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60 // Cache for 5 minutes
    }
  },
  database: drizzleAdapter(
    getDB(),
    {
      provider: 'pg',
      schema
    }
  ),
  advanced: {
    // The auth handler resolves the client IP (server/utils/clientIp.ts) and
    // sets this header alone: better-auth's rate limit and session rows read
    // it, so they start from the IP the audit log records (#24). better-auth
    // normalises it: an IPv6 address is expanded and masked to its /64
    // (`ipv6Subnet` default), where the audit log keeps the full address.
    ipAddress: {
      ipAddressHeaders: [RESOLVED_CLIENT_IP_HEADER]
    },
    database: {
      generateId: () => {
        return uuidv7()
      }
    }
  },
  user: {
    changeEmail: {
      enabled: true
    },
    deleteUser: {
      enabled: true,
      async sendDeleteAccountVerification({ user, url }) {
        const resend = getResendClient()
        if (!resend) {
          console.warn('Resend is not configured: account deletion email not sent')
          return
        }
        const name = userDisplayName(user)
        const html = await renderDeleteAccount(name, url)
        const response = await resend.emails.send({
          from: emailSender(),
          to: user.email,
          subject: 'Confirm account deletion',
          html
        })
        if (response.error) {
          console.error(`Failed to send account deletion email: ${response.error.message}`)
          throw createError({
            statusCode: 500,
            statusMessage: 'Internal Server Error'
          })
        }
      }
    },
    additionalFields: {
      lastActiveOrganizationId: {
        type: 'string',
        required: false,
        defaultValue: null
      },
      referralCode: {
        type: 'string',
        required: false
      }
    }
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, ctx) => {
          // The public demo creates no account, whatever the route:
          // sign-up, /admin/create-user or an OAuth implicit sign-up. The
          // demo seed writes to the database directly and is unaffected.
          // A throw propagates as is (db/with-hooks.mjs), where returning
          // false would leave each caller to report a null user.
          if (runtimeConfig.public.demoMode) {
            throw new APIError('FORBIDDEN', {
              message: 'Account creation is disabled in the demo.',
              code: DEMO_MODE_RESTRICTED
            })
          }
          if (ctx?.path.startsWith('/callback')) {
            try {
              const additionalData = await getOAuthState<{ referralCode?: string }>()
              if (additionalData?.referralCode) {
                return {
                  data: {
                    ...user,
                    referralCode: additionalData.referralCode
                  }
                }
              }
            } catch {
              // ignore
            }
          }
        }
      },
      update: {
        // Returns nothing: returning false would cancel the update.
        before: async (data, context) => {
          await rememberPreviousAvatar(data, context)
        },
        after: async (user, context) => {
          await deleteReplacedAvatar(user, context)
          // When user email changes, update Stripe customer email for orgs they own
          console.log('[Auth] User update hook triggered:', { userId: user.id, email: user.email, emailVerified: user.emailVerified })

          // Always sync email to Stripe when user is updated (email is verified by the change-email flow)
          if (user.email) {
            try {
              const db = getDB()
              // Find all orgs where this user is owner and has a Stripe customer
              const ownedOrgs = await db
                .select()
                .from(schema.member)
                .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
                .where(and(
                  eq(schema.member.userId, user.id),
                  memberHasRoleSql(schema.member.role, 'owner')
                ))

              console.log('[Auth] Found owned orgs:', ownedOrgs.length)

              if (ownedOrgs.length > 0 && isStripeConfigured()) {
                const stripe = createStripeClient()
                for (const row of ownedOrgs) {
                  const org = row.organization
                  if (org.stripeCustomerId) {
                    // Update customer email (used for receipts and communications)
                    // Also ensure customer name stays as org name (not cardholder name)
                    await stripe.customers.update(org.stripeCustomerId, {
                      email: user.email,
                      name: org.name
                    })
                    console.log(`[Auth] Updated Stripe customer ${org.stripeCustomerId} email to ${user.email}, name to "${org.name}"`)
                  } else {
                    console.log(`[Auth] Org ${org.id} has no stripeCustomerId`)
                  }
                }
              }
            } catch (e) {
              console.error('[Auth] Failed to update Stripe customer email:', e)
            }
          }
        }
      },
      delete: {
        // Stored objects cannot be restored, so they go only once the user
        // row is gone: a failed or cancelled deletion keeps them. This hook
        // never throws: internalAdapter.deleteUser runs outside a
        // transaction, so a throwing after hook would leave the user deleted
        // and its cached sessions alive (db/with-hooks.mjs,
        // db/internal-adapter.mjs). The signed-in user (the account owner,
        // or an admin) is the actor.
        after: async (user, context) => {
          try {
            await deleteUploadedFiles(user.id, context?.context.session?.user.id ?? user.id)
          } catch (error) {
            console.error(`[Auth] Cannot delete the files of deleted user ${user.id}:`, error)
          }
        }
      }
    },
    session: {
      create: {
        before: async (session) => {
          const db = getDB()

          // 1. Try to get user's last active org
          const users = await db
            .select()
            .from(schema.user)
            .where(eq(schema.user.id, session.userId))
            .limit(1)

          let activeOrgId = users[0]?.lastActiveOrganizationId

          // 2. Verify user is still a member of that org
          if (activeOrgId) {
            const member = await db
              .select()
              .from(schema.member)
              .where(and(
                eq(schema.member.userId, session.userId),
                eq(schema.member.organizationId, activeOrgId)
              ))
              .limit(1)

            if (member.length === 0)
              activeOrgId = null
          }

          // 3. Fallback to first organization
          if (!activeOrgId) {
            const [firstMember] = await db
              .select()
              .from(schema.member)
              .where(eq(schema.member.userId, session.userId))
              .limit(1)

            if (firstMember)
              activeOrgId = firstMember.organizationId
          }

          if (activeOrgId) {
            return {
              data: {
                ...session,
                activeOrganizationId: activeOrgId
              }
            }
          }
        }
      },
      update: {
        after: async (session) => {
          const activeOrgId = (session as any).activeOrganizationId
          if (activeOrgId) {
            await getDB()
              .update(schema.user)
              .set({ lastActiveOrganizationId: activeOrgId })
              .where(eq(schema.user.id, session.userId))
          }
        }
      }
    }
  },
  ...authStorageOptions,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      const name = userDisplayName(user)
      const html = await renderResetPassword(name, url)
      const resend = getResendClient()
      if (!resend) {
        console.error('Resend is not configured: reset password email not sent')
        throw createError({
          statusCode: 500,
          statusMessage: 'Internal Server Error'
        })
      }
      const response = await resend.emails.send({
        from: emailSender(),
        to: user.email,
        subject: 'Reset your password',
        html
      })
      await logAuditEvent({
        userId: user.id,
        category: 'email',
        action: 'reset_password',
        targetType: 'email',
        targetId: user.email,
        status: response.error ? 'failure' : 'success',
        details: response.error?.message
      })
      if (response.error) {
        console.error(`Failed to send reset password email: ${response.error.message}`)
        throw createError({
          statusCode: 500,
          statusMessage: 'Internal Server Error'
        })
      }
    }
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      // The URL carries the verification token: only print it in development,
      // where it lets sign-up work without an email provider.
      const isDevelopment = runtimeConfig.public.appEnv === 'development'
      if (isDevelopment) {
        console.log('>>> EMAIL VERIFICATION LINK <<<')
        console.log(`To: ${user.email}`)
        console.log(url)
        console.log('>>> ------------------------ <<<')
      }
      try {
        const resend = getResendClient()
        if (!resend) {
          throw new Error('Resend is not configured')
        }
        const name = userDisplayName(user)
        const html = await renderVerifyEmail(name, url)
        const response = await resend.emails.send({
          from: emailSender(),
          to: user.email,
          subject: 'Verify your email address',
          html
        })
        await logAuditEvent({
          userId: user.id,
          category: 'email',
          action: 'verification',
          targetType: 'email',
          targetId: user.email,
          status: response.error ? 'failure' : 'success',
          details: response.error?.message
        })
        if (response.error) {
          throw new Error(response.error.message)
        }
      } catch (e) {
        // Swallowed on purpose: better-auth only calls this hook for an
        // unverified address and rethrows what it throws, so throwing would
        // reveal that the account exists. The client copy stays neutral.
        const message = e instanceof Error ? e.message : String(e)
        console.error(`Failed to send verification email: ${message}`)
      }
    }
  },
  socialProviders: {
    github: {
      clientId: runtimeConfig.githubClientId!,
      clientSecret: runtimeConfig.githubClientSecret!
    },
    google: {
      clientId: runtimeConfig.googleClientId!,
      clientSecret: runtimeConfig.googleClientSecret!
    }
  },
  account: {
    accountLinking: {
      enabled: true
    }
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (runtimeConfig.public.demoMode) {
        await refuseDemoRestrictedRequest(ctx)
      }
      refuseDisabledEndpoint(ctx.path)
      if (ctx.path === '/subscription/upgrade') {
        // Anonymous requests are left to the endpoint's own 401.
        const session = await getSessionFromCtx(ctx)
        if (!session) {
          return undefined
        }
        await refuseForeignSubscriptionUpgrade(ctx, resolveUpgradeReferenceId(ctx, session))
        return checkoutSeatsOverride(ctx, session)
      }
      return undefined
    }),
    after: createAuthMiddleware(async (ctx) => {
      const ipAddress = ctx.getHeader(RESOLVED_CLIENT_IP_HEADER) || undefined
      const userAgent = ctx.getHeader('user-agent') || undefined

      const { targetType, targetId } = resolveAuditTarget({
        path: ctx.path,
        hasSession: !!(ctx.context.session || ctx.context.newSession),
        sessionUserId: ctx.context.session?.user.id || ctx.context.newSession?.user.id,
        email: ctx.body?.email,
        bodyUserId: ctx.body?.userId
      })
      const returned = ctx.context.returned
      if (returned && returned instanceof APIError) {
        const userId = ctx.context.newSession?.user.id
        if (ctx.path == '/callback/:id' && returned.status == 'FOUND' && userId) {
          const provider = ctx.params?.id ?? ':id'
          await logAuditEvent({
            userId,
            category: 'auth',
            action: ctx.path.replace(':id', provider),
            targetType,
            targetId,
            ipAddress,
            userAgent,
            status: 'success'
          })
        } else {
          await logAuditEvent({
            userId: ctx.context.session?.user.id,
            category: 'auth',
            action: ctx.path,
            targetType,
            targetId,
            ipAddress,
            userAgent,
            status: 'failure',
            details: returned.body?.message
          })
        }
      } else {
        if (AUDITED_SUCCESS_PATHS.includes(ctx.path)) {
          let userId: string | undefined
          if (['/sign-in/email', '/sign-up/email'].includes(ctx.path)) {
            userId = ctx.context.newSession?.user.id
          } else {
            userId = ctx.context.session?.user.id
          }
          await logAuditEvent({
            userId,
            category: 'auth',
            action: ctx.path,
            targetType,
            targetId,
            ipAddress,
            userAgent,
            status: 'success'
          })
        }
      }
    })
  },
  plugins: [
    ...(runtimeConfig.public.appEnv === 'development' ? [openAPI()] : []),
    adminPlugin(),
    organization({
      ac,
      roles: orgRoles,
      enableMetadata: true,
      organizationHooks: {
        // The plugin hands over the creator as read from the session, which
        // keeps referralCode (an additional user field returned by default),
        // so no lookup is needed.
        beforeCreateOrganization: async ({ organization, user }) => {
          if (user.referralCode) {
            return { data: { ...organization, referralCode: user.referralCode } }
          }
        }
        // No beforeDeleteOrganization: the foreign key api_key.reference_id
        // -> organization.id (ON DELETE CASCADE, added by
        // server/db/queries/api-key-organization-owner.postgresql.sql)
        // deletes an organization's keys with it.
      },
      schema: {
        organization: {
          additionalFields: organizationAdditionalFields
        }
      },
      async sendInvitationEmail({ email, inviter, organization, invitation }) {
        const resend = getResendClient()
        if (resend) {
          const inviterName = userDisplayName(inviter.user)
          const inviteUrl = buildInvitationUrl(runtimeConfig.public.baseURL, invitation.id)
          const html = await renderTeamInvite(inviterName, organization.name, inviteUrl)
          await resend.emails.send({
            from: emailSender(),
            to: email,
            subject: `You're invited to join ${organization.name}`,
            html
          })
        }
      }
    }),
    apiKey(apiKeyPluginOptions),
    // Billing is optional: without a Stripe secret key the app runs without it.
    // auth:schema keeps the plugin so the generated schema stays complete.
    ...(isStripeConfigured() || isAuthSchemaCommand ? [setupStripe()] : [])
  ]
})

let _auth: ReturnType<typeof createBetterAuth>

if (isAuthSchemaCommand) {
  _auth = createBetterAuth()
}
export const auth = _auth!

export const useServerAuth = () => {
  if (runtimeConfig.preset == 'node-server') {
    if (!_auth) {
      _auth = createBetterAuth()
    }
    return _auth
  } else {
    return createBetterAuth()
  }
}

export const getAuthSession = async (event: H3Event) => {
  const reqHeaders = getRequestHeaders(event)
  const headers = new Headers()
  for (const [key, value] of Object.entries(reqHeaders)) {
    if (value)
      headers.append(key, value)
  }
  withResolvedClientIp(headers, requestClientIp(event))

  const serverAuth = useServerAuth()
  // Bypass the session cookie cache: a removed user or a revoked session
  // must lose API access at once, not when the cache expires (#45).
  const session = await serverAuth.api.getSession({
    headers,
    query: { disableCookieCache: true }
  })
  return session
}

export const requireAuth = async (event: H3Event) => {
  const session = await getAuthSession(event)
  if (!session || !session.user) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized'
    })
  }
  // Save the session to the event context for later use
  event.context.user = session.user
  return session.user as User
}
