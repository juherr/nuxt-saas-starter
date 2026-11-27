// SPDX-License-Identifier: MIT
import type { TestDatabase } from './support/postgres'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apiKeyOwnerQueryPath, readSqlFile, splitLikeNuxtHub } from './support/nuxthubSql'
import { applySqlLikeNuxtHub, appSchemaStatements, createTestDatabase, describeWithPostgres } from './support/postgres'

// The upgrade query against a real Postgres: a database of this release
// (link table still declared), populated with rows a previous release
// wrote, and a better-auth 1.4 database migrated as the README says.
const FK_NAME = 'api_key_reference_id_organization_id_fk'
const fixture = (name: string) => readSqlFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

describeWithPostgres('the API key owner upgrade query', () => {
  let database: TestDatabase
  let client: pg.Client
  let schemaStatements: string[]

  beforeAll(async () => {
    database = await createTestDatabase()
    client = database.client
    schemaStatements = await appSchemaStatements()
  })

  beforeEach(async () => {
    await database.reset()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const runUpgrade = () => applySqlLikeNuxtHub(client, readSqlFile(apiKeyOwnerQueryPath))

  const createCurrentSchema = async () => {
    for (const statement of schemaStatements) {
      await client.query(statement)
    }
  }

  const insertUser = (id: string) => client.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $1, $1 || \'@example.test\')',
    [id]
  )

  const insertOrganization = (id: string) => client.query(
    'INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $1, $1, now())',
    [id]
  )

  // Columns shared by the 1.4 "apiKey" (user_id) and the 1.7 api_key.
  const insertKey = (table: '"apiKey"' | 'api_key', owner: 'user_id' | 'reference_id', id: string, ownerId: string, enabled: boolean | null = true) =>
    client.query(
      `INSERT INTO ${table} (id, ${owner}, key, start, prefix, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
      [id, ownerId, `hashed-${id}`, `sk_${id}`, 'sk_', enabled]
    )

  const insertLink = (apiKeyId: string, organizationId: string) => client.query(
    'INSERT INTO api_key_organization (api_key_id, organization_id) VALUES ($1, $2)',
    [apiKeyId, organizationId]
  )

  const keys = async () => (await client.query(
    'SELECT id, reference_id, key, start, prefix, enabled FROM api_key ORDER BY id'
  )).rows

  const ownerForeignKey = async () => (await client.query(
    `SELECT confdeltype FROM pg_constraint
     WHERE conname = $1 AND conrelid = to_regclass('api_key')`,
    [FK_NAME]
  )).rows

  const upgradeError = async () => {
    const error = await runUpgrade().then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    return error as Error
  }

  describe('on a populated database of the previous release', () => {
    // A previous release kept the organization in the link table and the
    // creator in reference_id.
    beforeEach(async () => {
      await createCurrentSchema()
      await insertUser('user-1')
      await insertOrganization('org-1')
      await insertOrganization('org-2')
    })

    it('moves each linked key to its organization, key material unchanged', async () => {
      await insertKey('api_key', 'reference_id', 'key-1', 'user-1')
      await insertKey('api_key', 'reference_id', 'key-2', 'user-1', false)
      await insertLink('key-1', 'org-1')
      await insertLink('key-2', 'org-2')

      await runUpgrade()

      expect(await keys()).toEqual([
        { id: 'key-1', reference_id: 'org-1', key: 'hashed-key-1', start: 'sk_key-1', prefix: 'sk_', enabled: true },
        { id: 'key-2', reference_id: 'org-2', key: 'hashed-key-2', start: 'sk_key-2', prefix: 'sk_', enabled: false }
      ])
    })

    it('deletes the disabled keys that belong to no organization', async () => {
      await insertKey('api_key', 'reference_id', 'key-1', 'user-1')
      await insertLink('key-1', 'org-1')
      await insertKey('api_key', 'reference_id', 'key-disabled', 'user-1', false)

      await runUpgrade()

      expect((await keys()).map(key => key.id)).toEqual(['key-1'])
    })

    it('stops on enabled keys that belong to no organization and changes nothing', async () => {
      await insertKey('api_key', 'reference_id', 'key-linked', 'user-1')
      await insertLink('key-linked', 'org-1')
      await insertKey('api_key', 'reference_id', 'key-disabled', 'user-1', false)
      await insertKey('api_key', 'reference_id', 'key-enabled', 'user-1')
      await insertKey('api_key', 'reference_id', 'key-null', 'user-1', null)
      const before = await keys()

      const error = await upgradeError()

      expect(error.message).toContain('2 enabled API key(s) belong to no organization')
      expect(error.message).toContain('Upgrading to organization-owned API keys')
      expect(await keys()).toEqual(before)
      expect(await ownerForeignKey()).toEqual([])
    })

    // The error rolls the move back too: the listing printed for the
    // operator must still leave out the linked and the disabled keys.
    it('prints a listing of exactly the keys that block it, and completes once they are gone', async () => {
      await insertKey('api_key', 'reference_id', 'key-linked', 'user-1')
      await insertLink('key-linked', 'org-1')
      await insertKey('api_key', 'reference_id', 'key-disabled', 'user-1', false)
      await insertKey('api_key', 'reference_id', 'key-enabled', 'user-1')
      await insertKey('api_key', 'reference_id', 'key-null', 'user-1', null)

      const error = await upgradeError()
      expect(error.message).toContain('2 enabled API key(s) belong to no organization')
      const listing = /List them with: (.+?); then/.exec(error.message)?.[1]
      expect(listing).toBeTruthy()
      const listed = (await client.query(listing ?? '')).rows

      expect(listed.map(row => row.id).sort()).toEqual(['key-enabled', 'key-null'])

      await client.query('DELETE FROM api_key WHERE id = ANY($1)', [listed.map(row => row.id)])
      await runUpgrade()

      expect(await keys()).toEqual([
        { id: 'key-linked', reference_id: 'org-1', key: 'hashed-key-linked', start: 'sk_key-linked', prefix: 'sk_', enabled: true }
      ])
      expect(await ownerForeignKey()).toEqual([{ confdeltype: 'c' }])
    })

    it('completes once the operator has dealt with the remaining keys', async () => {
      await insertKey('api_key', 'reference_id', 'key-enabled', 'user-1')
      await upgradeError()

      await client.query('UPDATE api_key SET reference_id = $1 WHERE id = $2', ['org-1', 'key-enabled'])
      await runUpgrade()

      expect(await keys()).toMatchObject([{ id: 'key-enabled', reference_id: 'org-1' }])
      expect(await ownerForeignKey()).toHaveLength(1)
    })

    it('changes nothing when it runs again', async () => {
      await insertKey('api_key', 'reference_id', 'key-1', 'user-1')
      await insertLink('key-1', 'org-1')
      await runUpgrade()
      const after = await keys()

      await runUpgrade()

      expect(await keys()).toEqual(after)
      expect(await ownerForeignKey()).toHaveLength(1)
    })

    it('lets the foreign key delete the keys of a deleted organization', async () => {
      await insertKey('api_key', 'reference_id', 'key-1', 'org-1')
      await insertKey('api_key', 'reference_id', 'key-2', 'org-2')
      await runUpgrade()

      expect(await ownerForeignKey()).toEqual([{ confdeltype: 'c' }])
      await client.query('DELETE FROM organization WHERE id = $1', ['org-1'])

      expect((await keys()).map(key => key.id)).toEqual(['key-2'])
    })

    it('refuses a key that references a missing organization once it has run', async () => {
      await runUpgrade()

      await expect(insertKey('api_key', 'reference_id', 'key-1', 'org-missing'))
        .rejects
        .toMatchObject({ code: '23503', constraint: FK_NAME })
    })
  })

  describe('while another connection holds a lock on api_key', () => {
    // A long transaction of a running instance, or an operator session.
    const withLockHeld = async (run: () => Promise<void>) => {
      const other = new pg.Client({ connectionString: database.url })
      await other.connect()
      try {
        await other.query('BEGIN')
        await other.query('LOCK TABLE api_key IN ACCESS EXCLUSIVE MODE')
        await run()
      }
      finally {
        await other.query('ROLLBACK').catch(() => {})
        await other.end()
      }
    }

    const lockTimeout = async () => (await client.query('SHOW lock_timeout')).rows[0]?.lock_timeout

    beforeEach(async () => {
      await createCurrentSchema()
    })

    it('does not wait for the lock once the foreign key exists', async () => {
      await runUpgrade()

      await withLockHeld(async () => {
        const settled = await Promise.race([
          runUpgrade().then(() => 'completed'),
          new Promise(resolve => setTimeout(resolve, 1000, 'waiting'))
        ])

        expect(settled).toBe('completed')
      })
    })

    it('gives up on the lock after its lock_timeout instead of waiting', { timeout: 20_000 }, async () => {
      await withLockHeld(async () => {
        const settled = await Promise.race([
          runUpgrade().then(() => 'completed', (error: unknown) => error),
          new Promise(resolve => setTimeout(resolve, 9000, 'still waiting'))
        ])

        expect(settled).toMatchObject({ code: '55P03' })
      })
      expect(await ownerForeignKey()).toEqual([])
      expect(await lockTimeout()).toBe('0')
    })

    it('leaves the lock_timeout of the session unchanged', async () => {
      await runUpgrade()

      expect(await ownerForeignKey()).toHaveLength(1)
      expect(await lockTimeout()).toBe('0')
    })
  })

  it('applies to a fresh install', async () => {
    await createCurrentSchema()

    await runUpgrade()

    expect(await ownerForeignKey()).toEqual([{ confdeltype: 'c' }])
  })

  // The real drizzle-kit output (fixtures/drizzle-kit-*.sql), edited as the
  // README (Upgrading from better-auth 1.4) tells the operator to.
  describe('on a better-auth 1.4 database migrated as the README says', () => {
    // README step 1, before the line it names.
    const copyKeys = `INSERT INTO "api_key" ("id", "name", "start", "reference_id", "prefix", "key", "refill_interval", "refill_amount", "last_refill_at", "enabled", "rate_limit_enabled", "rate_limit_time_window", "rate_limit_max", "request_count", "remaining", "last_request", "expires_at", "created_at", "updated_at", "permissions", "metadata")
SELECT "id", "name", "start", "user_id", "prefix", "key", "refill_interval", "refill_amount", "last_refill_at", "enabled", "rate_limit_enabled", "rate_limit_time_window", "rate_limit_max", "request_count", "remaining", "last_request", "expires_at", "created_at", "updated_at", "permissions", "metadata" FROM "apiKey";--> statement-breakpoint
`
    // README step 2, before the line it names.
    const fillStatus = `UPDATE "subscription" SET "status" = 'incomplete' WHERE "status" IS NULL;--> statement-breakpoint
`
    // README step 3: DROP TABLE "apiKey" CASCADE already dropped it.
    const redundantDropConstraint = 'ALTER TABLE "api_key_organization" DROP CONSTRAINT "api_key_organization_api_key_id_apiKey_id_fk";\n'

    const once = (sql: string, line: string) => {
      expect(sql.split(line)).toHaveLength(2)
      return sql.indexOf(line)
    }
    const insertBefore = (sql: string, line: string, text: string) => {
      const at = once(sql, line)
      return sql.slice(0, at) + text + sql.slice(at)
    }
    const remove = (sql: string, line: string) => {
      once(sql, line)
      return sql.replace(line, '')
    }

    const generated = () => fixture('drizzle-kit-better-auth-1.4-to-1.7-migration.sql')
    // Steps 1 and 2 only: what applies to every 1.4 deployment.
    const withDataSteps = (sql: string) => insertBefore(
      insertBefore(sql, 'ALTER TABLE "apiKey" DISABLE ROW LEVEL SECURITY;', copyKeys),
      'ALTER TABLE "subscription" ALTER COLUMN "status" SET NOT NULL;',
      fillStatus
    )

    beforeEach(async () => {
      await applySqlLikeNuxtHub(client, fixture('drizzle-kit-better-auth-1.4-schema.sql'))
      await insertUser('user-1')
      await insertOrganization('org-1')
    })

    it('ends with the linked keys owned by their organization', async () => {
      // A 1.4 key created before 1.7 defaults: enabled is NULL.
      await insertKey('"apiKey"', 'user_id', 'key-1', 'user-1', null)
      await insertLink('key-1', 'org-1')

      await applySqlLikeNuxtHub(client, remove(withDataSteps(generated()), redundantDropConstraint))
      await runUpgrade()

      expect(await keys()).toEqual([
        { id: 'key-1', reference_id: 'org-1', key: 'hashed-key-1', start: 'sk_key-1', prefix: 'sk_', enabled: null }
      ])
      expect(await ownerForeignKey()).toHaveLength(1)
    })

    it('fails on the generated DROP CONSTRAINT of the link table when it is left in', async () => {
      await insertKey('"apiKey"', 'user_id', 'key-1', 'user-1')
      await insertLink('key-1', 'org-1')

      await expect(applySqlLikeNuxtHub(client, withDataSteps(generated())))
        .rejects
        .toMatchObject({ code: '42704', message: expect.stringContaining('api_key_organization_api_key_id_apiKey_id_fk') })
    })

    // drizzle-kit creates the link table instead on such a deployment: its
    // statements come from a hand-written fixture, as the generated file
    // above was captured from a 1.4 schema that has the table.
    it('stops without deleting enabled keys when it predates the link table', async () => {
      await client.query('DROP TABLE api_key_organization')
      await insertKey('"apiKey"', 'user_id', 'key-1', 'user-1')
      await insertKey('"apiKey"', 'user_id', 'key-2', 'user-1', null)

      const withoutLinkTable = splitLikeNuxtHub(withDataSteps(generated()))
        .filter(statement => !statement.includes('api_key_organization'))
      for (const statement of withoutLinkTable) {
        await client.query(statement)
      }
      await applySqlLikeNuxtHub(client, fixture('better-auth-1.7-api-key-organization-create.sql'))
      const error = await upgradeError()

      expect(error.message).toContain('2 enabled API key(s) belong to no organization')
      expect(await keys()).toMatchObject([
        { id: 'key-1', reference_id: 'user-1' },
        { id: 'key-2', reference_id: 'user-1' }
      ])
      expect(await ownerForeignKey()).toEqual([])
    })
  })
})
