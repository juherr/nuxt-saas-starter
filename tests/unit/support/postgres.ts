// SPDX-License-Identifier: MIT
import { randomBytes } from 'node:crypto'
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api'
import pg from 'pg'
import { describe, expect } from 'vitest'
import * as schema from '~~/server/db/schema'
import { splitLikeNuxtHub } from './nuxthubSql'

// Suites that need a real Postgres run against TEST_DATABASE_URL (an admin
// connection: each test file creates and drops its own database, as Vitest
// runs files in parallel). CI provides one: there a missing URL fails the
// suite instead of skipping it.
const adminUrl = process.env.TEST_DATABASE_URL
const inCi = !!process.env.CI

export const describeWithPostgres = describe.skipIf(!adminUrl && !inCi)

export interface TestDatabase {
  client: pg.Client
  /** Drops every table, leaving an empty public schema. */
  reset: () => Promise<void>
  drop: () => Promise<void>
}

/** Creates a database of its own for one test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  expect(adminUrl, 'TEST_DATABASE_URL must be set when CI is set').toBeTruthy()
  const name = `nss_test_${randomBytes(8).toString('hex')}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  }
  finally {
    await admin.end()
  }

  const url = new URL(adminUrl!)
  url.pathname = `/${name}`
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()

  return {
    client,
    reset: async () => {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    },
    drop: async () => {
      await client.end()
      const admin = new pg.Client({ connectionString: adminUrl })
      await admin.connect()
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      }
      finally {
        await admin.end()
      }
    }
  }
}

/** Runs a SQL file as NuxtHub does: split, then one statement at a time. */
export async function applySqlLikeNuxtHub(client: pg.Client, sql: string) {
  for (const statement of splitLikeNuxtHub(sql)) {
    await client.query(statement)
  }
}

/**
 * The DDL `pnpm db:generate` writes for a fresh install of the app schema
 * (server/db/schema), from drizzle-kit's own generator.
 */
export async function appSchemaStatements(): Promise<string[]> {
  const empty = generateDrizzleJson({})
  const current = generateDrizzleJson(schema, empty.id)
  return generateMigration(empty, current)
}
