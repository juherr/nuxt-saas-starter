// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import { apiKeyOwnerQueryPath, readSqlFile, splitLikeNuxtHub } from './support/nuxthubSql'

// NuxtHub splits a query file on `;` with its own scanner, which knows
// single-quoted strings but not $$ dollar quoting. The upgrade query is one
// DO block whose body is a single-quoted string: any apostrophe or
// backslash inside it would end the string early and cut the block into
// statements Postgres rejects.
describe('the API key owner upgrade query', () => {
  const statements = splitLikeNuxtHub(readSqlFile(apiKeyOwnerQueryPath))

  it('reaches Postgres as one DO statement', () => {
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^DO '/)
  })

  it('keeps no apostrophe or backslash inside the DO body', () => {
    const statement = statements[0] ?? ''

    expect(statement.split('\'')).toHaveLength(3)
    expect(statement).toMatch(/'\s*;?$/)
    expect(statement).not.toContain('\\')
  })
})
