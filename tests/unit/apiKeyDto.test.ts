// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import { toApiKeyDto } from '~~/server/utils/apiKeyDto'

const storedRow = {
  id: 'key-1',
  name: 'ci',
  start: 'abcdef',
  prefix: 'sk',
  key: 'hashed-secret',
  configId: 'default',
  referenceId: 'org-1',
  enabled: true,
  rateLimitEnabled: true,
  requestCount: 3,
  permissions: '{"files":["read"]}',
  metadata: '{"client":"ci-runner"}',
  lastRequest: new Date('2026-01-02T00:00:00Z'),
  expiresAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z')
}

describe('toApiKeyDto', () => {
  it('exposes exactly the display fields of a key', () => {
    expect(Object.keys(toApiKeyDto(storedRow)).sort()).toEqual(
      ['createdAt', 'enabled', 'expiresAt', 'id', 'lastRequest', 'name', 'prefix', 'start']
    )
  })

  it('keeps the display values as stored', () => {
    expect(toApiKeyDto(storedRow)).toEqual({
      id: 'key-1',
      name: 'ci',
      start: 'abcdef',
      prefix: 'sk',
      enabled: true,
      createdAt: storedRow.createdAt,
      lastRequest: storedRow.lastRequest,
      expiresAt: null
    })
  })

  it('never carries the key hash, owner, permissions or metadata', () => {
    const serialized = JSON.stringify(toApiKeyDto(storedRow))

    for (const secret of ['hashed-secret', 'org-1', 'default', 'ci-runner', 'files']) {
      expect(serialized).not.toContain(secret)
    }
  })
})
