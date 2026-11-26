// SPDX-License-Identifier: MIT
import type pg from 'pg'
import type { TestDatabase } from './support/postgres'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apiKeyOwnerQueryPath, readSqlFile } from './support/nuxthubSql'
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
      expect(error.message).toContain('SELECT id, reference_id FROM api_key WHERE NOT EXISTS')
      expect(error.message).toContain('Upgrading to organization-owned API keys')
      expect(await keys()).toEqual(before)
      expect(await ownerForeignKey()).toEqual([])
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

  it('applies to a fresh install', async () => {
    await createCurrentSchema()

    await runUpgrade()

    expect(await ownerForeignKey()).toEqual([{ confdeltype: 'c' }])
  })

  describe('on a better-auth 1.4 database migrated as the README says', () => {
    beforeEach(async () => {
      await applySqlLikeNuxtHub(client, fixture('better-auth-1.4-api-keys.sql'))
      await insertUser('user-1')
      await insertOrganization('org-1')
    })

    it('ends with the linked keys owned by their organization', async () => {
      await applySqlLikeNuxtHub(client, fixture('better-auth-1.4-api-key-organization.sql'))
      // A 1.4 key created before 1.7 defaults: enabled is NULL.
      await insertKey('"apiKey"', 'user_id', 'key-1', 'user-1', null)
      await insertLink('key-1', 'org-1')

      await applySqlLikeNuxtHub(client, fixture('better-auth-1.7-api-keys-migration.sql'))
      await applySqlLikeNuxtHub(client, fixture('better-auth-1.7-api-key-organization-relink.sql'))
      await runUpgrade()

      expect(await keys()).toEqual([
        { id: 'key-1', reference_id: 'org-1', key: 'hashed-key-1', start: 'sk_key-1', prefix: 'sk_', enabled: null }
      ])
      expect(await ownerForeignKey()).toHaveLength(1)
    })

    it('stops without deleting enabled keys when it predates the link table', async () => {
      await insertKey('"apiKey"', 'user_id', 'key-1', 'user-1')
      await insertKey('"apiKey"', 'user_id', 'key-2', 'user-1', null)

      await applySqlLikeNuxtHub(client, fixture('better-auth-1.7-api-keys-migration.sql'))
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
