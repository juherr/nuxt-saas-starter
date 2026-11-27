// SPDX-License-Identifier: MIT
import type { TestDatabase } from './support/postgres'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { isSchemaReady, SCHEMA_READINESS_SQL } from '~~/server/utils/schemaReadiness'
import { apiKeyOwnerQueryPath, readSqlFile } from './support/nuxthubSql'
import { applySqlLikeNuxtHub, appSchemaStatements, createTestDatabase, describeWithPostgres } from './support/postgres'

// The query /api/health runs, against a real Postgres: ready only once the
// API key upgrade query has added its foreign key.
describeWithPostgres('the schema readiness query', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  beforeEach(async () => {
    await database.reset()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const ready = async () => isSchemaReady((await database.client.query(SCHEMA_READINESS_SQL)).rows)

  const createAppSchema = async () => {
    for (const statement of await appSchemaStatements()) {
      await database.client.query(statement)
    }
  }

  it('is not ready on an empty database', async () => {
    expect(await ready()).toBe(false)
  })

  it('is not ready while the API key upgrade query has not run', async () => {
    await createAppSchema()

    expect(await ready()).toBe(false)
  })

  it('is ready once the API key upgrade query has run', async () => {
    await createAppSchema()
    await applySqlLikeNuxtHub(database.client, readSqlFile(apiKeyOwnerQueryPath))

    expect(await ready()).toBe(true)
  })

  it('is not ready when the foreign key does not cascade', async () => {
    await createAppSchema()
    await database.client.query(`ALTER TABLE api_key ADD CONSTRAINT api_key_reference_id_organization_id_fk
      FOREIGN KEY (reference_id) REFERENCES organization(id)`)

    expect(await ready()).toBe(false)
  })
})
