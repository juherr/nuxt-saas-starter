// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubNitroGlobals } from './support/nitroGlobals'

const drivers = vi.hoisted(() => ({ isDatabaseConfigured: vi.fn(() => true) }))
const db = vi.hoisted(() => ({ execute: vi.fn(async () => ({ rows: [{ ready: true }] })) }))
const getDB = vi.hoisted(() => vi.fn(() => db))

vi.mock('~~/server/utils/drivers', () => drivers)
vi.mock('~~/server/utils/db', () => ({ getDB }))

const CANARY = 'connect ECONNREFUSED postgres://canary-user:canary-password@db-canary:5432/app'

const callHealth = async () => {
  const handler = (await import('~~/server/api/health.get')).default as unknown as
    (event: { status?: number }) => Promise<unknown>
  const event: { status?: number } = {}
  const body = await handler(event)
  return { status: event.status ?? 200, body }
}

describe('the health endpoint (GET /api/health)', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeAll(stubNitroGlobals)

  beforeEach(() => {
    drivers.isDatabaseConfigured.mockReturnValue(true)
    db.execute.mockClear()
    db.execute.mockResolvedValue({ rows: [{ ready: true }] })
    getDB.mockClear()
    consoleError.mockClear()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
    consoleError.mockRestore()
  })

  it('answers ok after querying the database when one is configured', async () => {
    const { status, body } = await callHealth()

    expect(status).toBe(200)
    expect(body).toEqual({ status: 'ok' })
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('answers 503 and logs the fix when the API key upgrade has not run', async () => {
    db.execute.mockResolvedValue({ rows: [{ ready: false }] })

    const { status, body } = await callHealth()

    expect(status).toBe(503)
    expect(body).toEqual({ status: 'error' })
    expect(db.execute).toHaveBeenCalledTimes(1)
    const logged = consoleError.mock.calls.flat().join(' ')
    expect(logged).toContain('api_key_reference_id_organization_id_fk')
    expect(logged).toContain('npx nuxt db migrate')
    expect(logged).toContain('Upgrading to organization-owned API keys')
  })

  it('answers 503 when the readiness query returns no row', async () => {
    db.execute.mockResolvedValue({ rows: [] })

    const { status, body } = await callHealth()

    expect(status).toBe(503)
    expect(body).toEqual({ status: 'error' })
  })

  it('answers 503 without touching the database when none is configured', async () => {
    drivers.isDatabaseConfigured.mockReturnValue(false)

    const { status, body } = await callHealth()

    expect(status).toBe(503)
    expect(body).toEqual({ status: 'error' })
    expect(getDB).not.toHaveBeenCalled()
    expect(db.execute).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('no database configured'))
  })

  it('answers 503 when the database check does not settle in time', async () => {
    vi.useFakeTimers()
    try {
      db.execute.mockReturnValue(new Promise(() => {}))

      const pending = callHealth()
      await vi.advanceTimersByTimeAsync(2000)
      const { status, body } = await pending

      expect(status).toBe(503)
      expect(body).toEqual({ status: 'error' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers 503 with a generic body and logs the error when the database check fails', async () => {
    db.execute.mockRejectedValue(new Error(CANARY))

    const { status, body } = await callHealth()

    expect(status).toBe(503)
    expect(body).toEqual({ status: 'error' })
    expect(JSON.stringify(body)).not.toContain('canary')
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: CANARY }))
  })

  it('answers 503 when the database client cannot be created', async () => {
    getDB.mockImplementationOnce(() => {
      throw new Error(CANARY)
    })

    const { status, body } = await callHealth()

    expect(status).toBe(503)
    expect(body).toEqual({ status: 'error' })
  })
})
