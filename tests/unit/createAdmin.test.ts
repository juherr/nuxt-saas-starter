// SPDX-License-Identifier: MIT
import type { AdminStore } from '~~/scripts/createAdmin'
import { describe, expect, it, vi } from 'vitest'
import { createAdmin, readCreateAdminConfig, runCreateAdmin } from '~~/scripts/createAdmin'

const env = {
  DATABASE_URL: 'postgres://u:p@db:5432/app',
  NUXT_ADMIN_EMAIL: 'admin@example.com',
  NUXT_ADMIN_PASSWORD: 'canary-password'
}

const fakeStore = (overrides: Partial<AdminStore> = {}): AdminStore => ({
  signUp: vi.fn(async () => ({ id: 'user-1' })),
  findUserIdByEmail: vi.fn(async () => 'user-1'),
  promote: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  ...overrides
})

const silentLogger = () => ({ log: vi.fn(), error: vi.fn() })

describe('readCreateAdminConfig', () => {
  it('reads the database URL, the admin credentials and the default connect timeout', () => {
    expect(readCreateAdminConfig(env)).toEqual({
      databaseUrl: env.DATABASE_URL,
      connectTimeoutMs: 10000,
      email: env.NUXT_ADMIN_EMAIL,
      password: env.NUXT_ADMIN_PASSWORD
    })
  })

  it('falls back to NUXT_DATABASE_URL', () => {
    const { DATABASE_URL: _unset, ...rest } = env

    expect(readCreateAdminConfig({ ...rest, NUXT_DATABASE_URL: 'postgres://u:p@other:5432/app' }).databaseUrl)
      .toBe('postgres://u:p@other:5432/app')
  })

  it('reads NUXT_DATABASE_CONNECT_TIMEOUT_MS', () => {
    expect(readCreateAdminConfig({ ...env, NUXT_DATABASE_CONNECT_TIMEOUT_MS: '2500' }).connectTimeoutMs).toBe(2500)
  })

  it('refuses to run without a database URL', () => {
    const { DATABASE_URL: _unset, ...rest } = env

    expect(() => readCreateAdminConfig(rest)).toThrow(/DATABASE_URL/)
  })

  it.each(['NUXT_ADMIN_EMAIL', 'NUXT_ADMIN_PASSWORD'] as const)('refuses to run without %s', (name) => {
    expect(() => readCreateAdminConfig({ ...env, [name]: '' })).toThrow(name)
  })
})

describe('createAdmin', () => {
  const input = { email: env.NUXT_ADMIN_EMAIL, password: env.NUXT_ADMIN_PASSWORD }

  it('signs the user up and promotes it', async () => {
    const store = fakeStore()

    await expect(createAdmin(input, store, silentLogger())).resolves.toBe('created')

    expect(store.signUp).toHaveBeenCalledWith({ ...input, name: 'Admin User' })
    expect(store.promote).toHaveBeenCalledWith('user-1')
  })

  it('promotes the existing user when the email is taken', async () => {
    const store = fakeStore({
      signUp: vi.fn(async () => {
        throw new Error('User already exists. Use another email.')
      }),
      findUserIdByEmail: vi.fn(async () => 'user-2')
    })

    await expect(createAdmin(input, store, silentLogger())).resolves.toBe('promoted')

    expect(store.findUserIdByEmail).toHaveBeenCalledWith(input.email)
    expect(store.promote).toHaveBeenCalledWith('user-2')
  })

  it('fails when the existing user cannot be found to be promoted', async () => {
    const store = fakeStore({
      signUp: vi.fn(async () => {
        throw new Error('User already exists. Use another email.')
      }),
      findUserIdByEmail: vi.fn(async () => undefined)
    })

    await expect(createAdmin(input, store, silentLogger())).rejects.toThrow(/Could not find user to promote/)
    expect(store.promote).not.toHaveBeenCalled()
  })

  it('fails with the database hint when the sign-up fails', async () => {
    const store = fakeStore({
      signUp: vi.fn(async () => {
        throw Object.assign(new AggregateError([], 'refused'), { message: '', code: 'ECONNREFUSED' })
      })
    })

    const failure = createAdmin(input, store, silentLogger())

    await expect(failure).rejects.toThrow(/ECONNREFUSED/)
    await expect(failure).rejects.toThrow(/DATABASE_URL/)
    expect(store.promote).not.toHaveBeenCalled()
  })

  it('names the cause drizzle wraps under its "Failed query" error', async () => {
    const store = fakeStore({
      signUp: vi.fn(async () => {
        const refused = Object.assign(new AggregateError([], 'refused'), { message: '', code: 'ECONNREFUSED' })
        throw new Error('Failed query: select "id" from "user"', { cause: refused })
      })
    })

    await expect(createAdmin(input, store, silentLogger())).rejects.toThrow(/Failed query.*ECONNREFUSED/s)
  })

  it('fails when the sign-up returns no user', async () => {
    const store = fakeStore({ signUp: vi.fn(async () => undefined) })

    await expect(createAdmin(input, store, silentLogger())).rejects.toThrow(/no user/)
    expect(store.promote).not.toHaveBeenCalled()
  })
})

describe('runCreateAdmin', () => {
  it('exits 0 and closes the connection once the admin is created', async () => {
    const store = fakeStore()
    const connect = vi.fn(() => store)

    await expect(runCreateAdmin(env, { connect, logger: silentLogger() })).resolves.toBe(0)

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ databaseUrl: env.DATABASE_URL, connectTimeoutMs: 10000 }))
    expect(store.close).toHaveBeenCalledOnce()
  })

  it('exits 1 without connecting when the configuration is incomplete', async () => {
    const connect = vi.fn(() => fakeStore())
    const logger = silentLogger()

    await expect(runCreateAdmin({ ...env, DATABASE_URL: '' }, { connect, logger })).resolves.toBe(1)

    expect(connect).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL'))
  })

  it('exits 1, prints the reason and closes the connection when the admin cannot be created', async () => {
    const store = fakeStore({
      signUp: vi.fn(async () => {
        throw new Error('timeout exceeded when trying to connect')
      })
    })
    const logger = silentLogger()

    await expect(runCreateAdmin(env, { connect: () => store, logger })).resolves.toBe(1)

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('timeout exceeded when trying to connect'))
    expect(store.close).toHaveBeenCalledOnce()
  })
})

describe('the create-admin.ts entry point', () => {
  it('connects to nothing when imported', async () => {
    // A complete environment, so that an unguarded entry would reach the pool.
    for (const [name, value] of Object.entries(env))
      vi.stubEnv(name, value)
    const Pool = vi.fn()
    vi.doMock('pg', () => ({ default: { Pool } }))
    const exitCode = process.exitCode

    try {
      await import('~~/create-admin')

      expect(Pool).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(exitCode)
    } finally {
      process.exitCode = exitCode
      vi.doUnmock('pg')
      vi.unstubAllEnvs()
    }
  })
})
