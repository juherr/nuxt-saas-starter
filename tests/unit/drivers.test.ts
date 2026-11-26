// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtimeConfig = vi.hoisted(() => ({
  preset: 'node-server',
  databaseUrl: 'postgres://u:p@db:5432/app',
  // A runtime override reaches the config as a number or, if it does not
  // parse, as the raw string.
  databaseConnectTimeoutMs: 10000 as unknown,
  resendApiKey: '' as string | undefined
}))

const poolOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(options: Record<string, unknown>) {
        poolOptions.push(options)
      }
    }
  }
}))

vi.mock('~~/server/utils/runtimeConfig', () => ({ runtimeConfig }))

describe('the PostgreSQL pool', () => {
  beforeEach(() => {
    vi.resetModules()
    poolOptions.length = 0
  })

  it('bounds the connection with the 10 s default', async () => {
    runtimeConfig.databaseConnectTimeoutMs = 10000

    const { getPgPool } = await import('~~/server/utils/drivers')
    getPgPool()

    expect(poolOptions).toEqual([expect.objectContaining({ connectionTimeoutMillis: 10000 })])
  })

  it('uses the configured connect timeout', async () => {
    runtimeConfig.databaseConnectTimeoutMs = 2500

    const { getPgPool } = await import('~~/server/utils/drivers')
    getPgPool()

    expect(poolOptions).toEqual([expect.objectContaining({ connectionTimeoutMillis: 2500 })])
  })

  it.each([['an unparsable value', 'soon'], ['zero, which pg reads as no timeout', 0], ['a negative value', -1]])(
    'falls back to the 10 s default on %s',
    async (_label, value) => {
      runtimeConfig.databaseConnectTimeoutMs = value

      const { getPgPool } = await import('~~/server/utils/drivers')
      getPgPool()

      expect(poolOptions).toEqual([expect.objectContaining({ connectionTimeoutMillis: 10000 })])
    }
  )
})

describe('the Resend client', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('is absent, without failing the import, when no API key is configured', async () => {
    runtimeConfig.resendApiKey = ''

    const { getResendClient } = await import('~~/server/utils/drivers')

    expect(getResendClient()).toBeUndefined()
  })

  it('is created once when an API key is configured', async () => {
    runtimeConfig.resendApiKey = 're_canary_key'

    const { getResendClient } = await import('~~/server/utils/drivers')

    const client = getResendClient()
    expect(client).toBeDefined()
    expect(getResendClient()).toBe(client)
  })
})

describe('isDatabaseConfigured', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.HYPERDRIVE
    delete (globalThis as { HYPERDRIVE?: unknown }).HYPERDRIVE
  })

  it('is true when a database URL is configured', async () => {
    runtimeConfig.databaseUrl = 'postgres://u:p@db:5432/app'

    const { isDatabaseConfigured } = await import('~~/server/utils/drivers')

    expect(isDatabaseConfigured()).toBe(true)
  })

  it('is false when no database URL nor Hyperdrive binding is configured', async () => {
    runtimeConfig.databaseUrl = ''

    const { isDatabaseConfigured } = await import('~~/server/utils/drivers')

    expect(isDatabaseConfigured()).toBe(false)
  })

  it('is true when only a Hyperdrive binding is available', async () => {
    runtimeConfig.databaseUrl = ''
    ;(globalThis as { HYPERDRIVE?: unknown }).HYPERDRIVE = { connectionString: 'postgres://u:p@hyperdrive:5432/app' }

    const { isDatabaseConfigured } = await import('~~/server/utils/drivers')

    expect(isDatabaseConfigured()).toBe(true)
  })
})
