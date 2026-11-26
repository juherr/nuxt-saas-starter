// SPDX-License-Identifier: MIT
// Logic of create-admin.ts, with its database and better-auth access injected
// so that it can be unit-tested. It runs under plain Node (type stripping):
// relative imports keep their `.ts` extension.
import { databaseConnectTimeoutMs } from '../server/utils/databaseConnectTimeout.ts'

export interface CreateAdminEnv {
  readonly DATABASE_URL?: string
  readonly NUXT_DATABASE_URL?: string
  readonly NUXT_DATABASE_CONNECT_TIMEOUT_MS?: string
  readonly NUXT_ADMIN_EMAIL?: string
  readonly NUXT_ADMIN_PASSWORD?: string
  // Accepts process.env as it is.
  readonly [name: string]: string | undefined
}

export interface CreateAdminConfig {
  readonly databaseUrl: string
  readonly connectTimeoutMs: number
  readonly email: string
  readonly password: string
}

export interface AdminStore {
  /** Signs the user up with better-auth; resolves to the new user, if any. */
  signUp: (input: { email: string, password: string, name: string }) => Promise<{ id: string } | undefined>
  findUserIdByEmail: (email: string) => Promise<string | undefined>
  /** Gives the user the admin role and marks its email as verified. */
  promote: (userId: string) => Promise<void>
  close: () => Promise<void>
}

export interface CreateAdminLogger {
  log: (message: string) => void
  error: (message: string) => void
}

const DATABASE_HINT = 'Check that DATABASE_URL (or NUXT_DATABASE_URL) points to a reachable PostgreSQL '
  + 'database whose migrations are applied (npx nuxt db migrate).'

/** Reads the script's settings; throws an actionable error when one is missing. */
export function readCreateAdminConfig(env: CreateAdminEnv): CreateAdminConfig {
  const databaseUrl = env.DATABASE_URL || env.NUXT_DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set: set it (or NUXT_DATABASE_URL) to the PostgreSQL URL, '
      + 'in the environment or in .env.')
  }
  const missing = (['NUXT_ADMIN_EMAIL', 'NUXT_ADMIN_PASSWORD'] as const).filter(name => !env[name])
  if (missing.length > 0) {
    throw new Error(`${missing.join(' and ')} not set: set the admin's email and password, `
      + 'in the environment or in .env.')
  }
  return {
    databaseUrl,
    connectTimeoutMs: databaseConnectTimeoutMs(env.NUXT_DATABASE_CONNECT_TIMEOUT_MS),
    email: env.NUXT_ADMIN_EMAIL ?? '',
    password: env.NUXT_ADMIN_PASSWORD ?? ''
  }
}

// pg reports a refused connection to a host with several addresses as an
// AggregateError with an empty message: fall back to its code. drizzle wraps
// the pg error in a "Failed query" error: name its cause too.
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  const body = 'body' in error && typeof error.body === 'object' && error.body !== null ? JSON.stringify(error.body) : undefined
  const cause = error.cause === undefined ? undefined : `(cause: ${describeError(error.cause)})`
  return [error.message || code || error.name, body, cause].filter(Boolean).join(' ')
}

const isUserAlreadyExists = (error: unknown) =>
  error instanceof Error && error.message.includes('User already exists')

/**
 * Signs the admin up, or finds it when the email is taken, then promotes it.
 * Resolves to what was done; throws an actionable error otherwise.
 */
export async function createAdmin(
  input: { email: string, password: string },
  store: AdminStore,
  logger: CreateAdminLogger
): Promise<'created' | 'promoted'> {
  const { email, password } = input
  logger.log(`Creating admin user: ${email}`)

  let created: { id: string } | undefined
  try {
    created = await store.signUp({ email, password, name: 'Admin User' })
  } catch (error) {
    if (!isUserAlreadyExists(error)) {
      // The message already names the cause: no `cause`, or it prints twice.
      throw new Error(`Error creating admin user: ${describeError(error)}. ${DATABASE_HINT}`)
    }
    logger.log('User already exists. Updating role to admin...')
    const userId = await store.findUserIdByEmail(email)
    if (!userId) {
      throw new Error(`Could not find user to promote: better-auth reports ${email} as taken, `
        + 'but no user has that email. Check that DATABASE_URL points to the database the app uses.')
    }
    await store.promote(userId)
    logger.log(`User ${email} promoted to admin successfully.`)
    return 'promoted'
  }

  if (!created) {
    throw new Error(`Error creating admin user: the sign-up of ${email} returned no user.`)
  }
  logger.log(`User created successfully: ${created.id}`)
  await store.promote(created.id)
  logger.log('User promoted to admin successfully')
  return 'created'
}

/** Runs the whole script and resolves to its exit code. */
export async function runCreateAdmin(
  env: CreateAdminEnv,
  deps: { connect: (config: CreateAdminConfig) => AdminStore, logger: CreateAdminLogger }
): Promise<number> {
  const { logger } = deps
  let config: CreateAdminConfig
  try {
    config = readCreateAdminConfig(env)
  } catch (error) {
    logger.error(describeError(error))
    return 1
  }

  const store = deps.connect(config)
  try {
    await createAdmin(config, store, logger)
    return 0
  } catch (error) {
    logger.error(describeError(error))
    return 1
  } finally {
    await store.close()
  }
}
