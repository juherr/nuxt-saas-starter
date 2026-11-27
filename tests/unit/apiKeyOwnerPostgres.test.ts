// SPDX-License-Identifier: MIT
import type { ApiKeyConfigurationOptions, ApiKeyOptions } from '@better-auth/api-key'
import type { TestDatabase } from './support/postgres'
import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization } from 'better-auth/plugins'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '~~/server/db/schema'
import { apiKeyPluginOptions } from '~~/server/utils/apiKeyOptions'
import { ac, admin, member, owner } from '~~/shared/utils/permissions'
import { apiKeyOwnerQueryPath, readSqlFile } from './support/nuxthubSql'
import { applySqlLikeNuxtHub, appSchemaStatements, createTestDatabase, describeWithPostgres } from './support/postgres'

// The real better-auth plugins over the drizzle adapter, as the app wires
// them (server/utils/auth.ts), on a real Postgres with the app schema and
// the API key owner upgrade query.
const BASE_URL = 'http://localhost:3000'
const PASSWORD = 'password-1234'

// The API key options of the release before organization-owned keys
// (origin/main server/utils/auth.ts): keys referenced their creator.
const previousReleaseApiKeyOptions = {
  enableMetadata: true,
  schema: { apikey: { modelName: 'apiKey' } }
} satisfies ApiKeyConfigurationOptions & ApiKeyOptions

type Db = ReturnType<typeof drizzle<typeof schema>>

function createAuth<O extends ApiKeyConfigurationOptions & ApiKeyOptions>(db: Db, apiKeyOptions: O) {
  return betterAuth({
    baseURL: BASE_URL,
    secret: 'test-secret-that-is-long-enough-for-better-auth',
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    user: { deleteUser: { enabled: true } },
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    plugins: [
      organization({ ac, roles: { owner, admin, member } }),
      apiKey(apiKeyOptions)
    ]
  })
}

async function signUp(handler: (request: Request) => Promise<Response>, name: string) {
  const response = await handler(new Request(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': BASE_URL },
    body: JSON.stringify({ email: `${name}@example.test`, password: PASSWORD, name })
  }))
  const sessionCookie = response.headers.get('set-cookie')?.split(';')[0]
  const body = await response.json() as { user?: { id: string } }
  if (!response.ok || !sessionCookie || !body.user) {
    throw new Error(`Sign-up of ${name} failed with ${response.status}`)
  }
  return { userId: body.user.id, headers: new Headers({ cookie: sessionCookie }) }
}

describeWithPostgres('organization API keys on Postgres through better-auth', () => {
  let database: TestDatabase
  let client: pg.Client
  let pool: pg.Pool
  let db: Db
  let schemaStatements: string[]

  beforeAll(async () => {
    database = await createTestDatabase()
    client = database.client
    pool = new pg.Pool({ connectionString: database.url })
    db = drizzle({ client: pool, schema })
    schemaStatements = await appSchemaStatements()
  })

  afterAll(async () => {
    await pool?.end()
    await database?.drop()
  })

  const createCurrentSchema = async () => {
    await database.reset()
    for (const statement of schemaStatements) {
      await client.query(statement)
    }
  }

  const runUpgrade = () => applySqlLikeNuxtHub(client, readSqlFile(apiKeyOwnerQueryPath))

  const keyRow = async (id: string) => (await client.query(
    'SELECT id, reference_id FROM api_key WHERE id = $1',
    [id]
  )).rows[0]

  const orphanKeyCount = async () => (await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM api_key k
     WHERE NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = k.reference_id)`
  )).rows[0]!.count

  const createOrganization = async (auth: ReturnType<typeof createAuth>, headers: Headers, slug: string) => {
    const created = await auth.api.createOrganization({ body: { name: slug, slug }, headers })
    if (!created) {
      throw new Error(`Organization ${slug} not created`)
    }
    return created.id
  }

  describe('a key created by the previous release', () => {
    let organizationId: string
    let linkedKey: { id: string, key: string }
    let unlinkedDisabledKeyId: string

    beforeAll(async () => {
      await createCurrentSchema()
      const previousAuth = createAuth(db, previousReleaseApiKeyOptions)
      const ownerUser = await signUp(previousAuth.handler, 'previous-owner')
      const created = await previousAuth.api.createOrganization({
        body: { name: 'Previous', slug: 'previous' },
        headers: ownerUser.headers
      })
      if (!created) {
        throw new Error('Organization not created')
      }
      organizationId = created.id

      // The previous release named the organization in the metadata and
      // recorded it in the link table from an after hook.
      const linked = await previousAuth.api.createApiKey({
        body: { name: 'linked', metadata: { organizationId } },
        headers: ownerUser.headers
      })
      expect(linked.referenceId).toBe(ownerUser.userId)
      linkedKey = { id: linked.id, key: linked.key }
      await db.insert(schema.apiKeyOrganization).values({ apiKeyId: linked.id, organizationId })

      const unlinked = await previousAuth.api.createApiKey({
        body: { name: 'unlinked' },
        headers: ownerUser.headers
      })
      await previousAuth.api.updateApiKey({
        body: { keyId: unlinked.id, enabled: false },
        headers: ownerUser.headers
      })
      unlinkedDisabledKeyId = unlinked.id

      await runUpgrade()
    })

    it('still authenticates after the upgrade, its plaintext unchanged', async () => {
      const auth = createAuth(db, apiKeyPluginOptions)

      const verified = await auth.api.verifyApiKey({ body: { key: linkedKey.key } })

      expect(verified).toMatchObject({ valid: true, key: { id: linkedKey.id, referenceId: organizationId } })
    })

    it('is owned by its organization, as the organization key listing selects it', async () => {
      expect(await keyRow(linkedKey.id)).toEqual({ id: linkedKey.id, reference_id: organizationId })
      // The where clause of server/api/organization/api-keys.get.ts.
      const listed = await db.select({ id: schema.apiKey.id })
        .from(schema.apiKey)
        .where(eq(schema.apiKey.referenceId, organizationId))
      expect(listed).toEqual([{ id: linkedKey.id }])
    })

    it('is deleted when it was never linked and is disabled', async () => {
      expect(await keyRow(unlinkedDisabledKeyId)).toBeUndefined()
    })
  })

  describe('once the upgrade has run', () => {
    beforeAll(async () => {
      await createCurrentSchema()
      await runUpgrade()
    })

    // Deleted through better-auth deleteUser with the creator's session and
    // password (user.deleteUser enabled, no verification email configured).
    it('keeps a key valid after its creator deletes their account', async () => {
      const auth = createAuth(db, apiKeyPluginOptions)
      const creator = await signUp(auth.handler, 'creator')
      const organizationId = await createOrganization(auth, creator.headers, 'creator-org')
      const created = await auth.api.createApiKey({
        body: { name: 'survivor', organizationId },
        headers: creator.headers
      })

      await auth.api.deleteUser({ body: { password: PASSWORD }, headers: creator.headers })

      expect((await client.query('SELECT id FROM "user" WHERE id = $1', [creator.userId])).rows).toEqual([])
      expect(await keyRow(created.id)).toEqual({ id: created.id, reference_id: organizationId })
      expect(await auth.api.verifyApiKey({ body: { key: created.key } }))
        .toMatchObject({ valid: true, key: { id: created.id } })
    })

    describe('when a key is created while its organization is deleted', () => {
      let deleter: pg.Client
      let creator: pg.Client
      let deleterPid: number
      let creatorPid: number
      let sequence = 0

      beforeAll(async () => {
        deleter = new pg.Client({ connectionString: database.url })
        creator = new pg.Client({ connectionString: database.url })
        await deleter.connect()
        await creator.connect()
        deleterPid = (await deleter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
        creatorPid = (await creator.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      })

      afterAll(async () => {
        await deleter?.end()
        await creator?.end()
      })

      const insertOrganization = async () => {
        const id = `race-org-${++sequence}`
        await client.query(
          'INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $1, $1, now())',
          [id]
        )
        return id
      }

      const insertKey = (connection: pg.Client, id: string, organizationId: string) => connection.query(
        `INSERT INTO api_key (id, reference_id, key, created_at, updated_at)
         VALUES ($1, $2, $3, now(), now())`,
        [id, organizationId, `hashed-${id}`]
      )

      // Resolves once `pid` waits on a lock; fails if `pending` settles first,
      // which means the statement did not block.
      const waitUntilBlocked = async (pid: number, pending: Promise<unknown>) => {
        let settled = false
        const markSettled = () => {
          settled = true
        }
        pending.then(markSettled, markSettled)
        for (;;) {
          const { rows } = await client.query<{ wait_event_type: string | null }>(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
            [pid]
          )
          if (rows[0]?.wait_event_type === 'Lock') {
            return
          }
          if (settled) {
            throw new Error(`Backend ${pid} completed without waiting on a lock`)
          }
        }
      }

      it('refuses the key when the deletion commits first', async () => {
        const organizationId = await insertOrganization()
        await deleter.query('BEGIN')
        await deleter.query('DELETE FROM organization WHERE id = $1', [organizationId])

        const insert = insertKey(creator, `key-after-delete-${sequence}`, organizationId)
          .then(() => null, (error: unknown) => error)
        await waitUntilBlocked(creatorPid, insert)
        await deleter.query('COMMIT')

        expect(await insert).toMatchObject({ code: '23503' })
        expect(await orphanKeyCount()).toBe(0)
      })

      it('deletes the key with its organization when the creation commits first', async () => {
        const organizationId = await insertOrganization()
        const keyId = `key-before-delete-${sequence}`
        await creator.query('BEGIN')
        await insertKey(creator, keyId, organizationId)

        const deletion = deleter.query('DELETE FROM organization WHERE id = $1', [organizationId])
        await waitUntilBlocked(deleterPid, deletion)
        await creator.query('COMMIT')

        expect((await deletion).rowCount).toBe(1)
        expect(await keyRow(keyId)).toBeUndefined()
        expect(await orphanKeyCount()).toBe(0)
      })

      // Not deterministic: whichever interleaving the calls take, no key may
      // be left referencing the deleted organization.
      it('smoke: leaves no orphan key when key creations race the deletion through better-auth', async () => {
        const auth = createAuth(db, apiKeyPluginOptions)
        const racer = await signUp(auth.handler, 'racer')
        const organizationId = await createOrganization(auth, racer.headers, 'race-org')

        const results = await Promise.allSettled([
          ...Array.from({ length: 5 }, (_, i) => auth.api.createApiKey({
            body: { name: `race-${i}`, organizationId },
            headers: racer.headers
          })),
          auth.api.deleteOrganization({ body: { organizationId }, headers: racer.headers }),
          ...Array.from({ length: 5 }, (_, i) => auth.api.createApiKey({
            body: { name: `race-late-${i}`, organizationId },
            headers: racer.headers
          }))
        ])

        expect(results[5]!.status).toBe('fulfilled')
        expect((await client.query('SELECT id FROM organization WHERE id = $1', [organizationId])).rows).toEqual([])
        expect(await orphanKeyCount()).toBe(0)
      })
    })
  })
})
