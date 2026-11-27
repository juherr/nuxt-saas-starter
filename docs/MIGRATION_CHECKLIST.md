# NuxtHub v0.10 Migration Checklist

Use this checklist when syncing this branch with your own app or migrating from NuxtHub Admin to self-hosted Cloudflare Workers.

---

## Environment Variables

- [ ] Rename `NUXT_DATABASE_URL` → `DATABASE_URL` in your `.env` file
- [ ] Ensure `NUXT_NITRO_PRESET=cloudflare-module` is set
- [ ] Add all secrets to Cloudflare via `npx wrangler secret put <NAME>`

---

## Code Changes

### Database Path Rename

- [ ] Rename `server/database/` → `server/db/`
- [ ] Update all imports from `server/database/` to `server/db/`

**Files typically affected:**
- [ ] `server/utils/auth.ts`
- [ ] `server/api/**/*.ts` (all API routes)
- [ ] `server/services/**/*.ts`
- [ ] `shared/utils/types.ts`

### KV API Migration

- [ ] Replace `hubKV()` calls with `kv` from `hub:kv`

```diff
- const value = await hubKV().get(key)
+ import { kv } from 'hub:kv'
+ const value = await kv.get(key)
```

**Methods changed:**
| Old | New |
|-----|-----|
| `hubKV().get(key)` | `kv.get(key)` |
| `hubKV().set(key, value, { ttl })` | `kv.set(key, value, { ttl })` |
| `hubKV().del(key)` | `kv.del(key)` |

### Blob API Migration (if used)

- [ ] Replace `hubBlob()` calls with `blob` from `hub:blob`

```diff
- const file = await hubBlob().get(path)
+ import { blob } from 'hub:blob'
+ const file = await blob.get(path)
```

### Database API Migration (if used)

- [ ] Replace `hubDatabase()` calls with `db` from `hub:db`

```diff
- const result = await hubDatabase().query(sql)
+ import { db } from 'hub:db'
+ const result = await db.query(sql)
```

---

## Configuration Files

### nuxt.config.ts

- [ ] Update `hub` config to v0.10 syntax:

```diff
  hub: {
-   database: true,
+   db: 'postgresql',
    kv: true,
    blob: true,
-   workers: true,
-   bindings: {
-     hyperdrive: {
-       HYPERDRIVE: process.env.NUXT_CF_HYPERDRIVE_ID
-     }
-   }
  }
```

- [ ] Add Cloudflare config to nitro (optional but recommended):

```ts
nitro: {
  preset: process.env.NUXT_NITRO_PRESET,
  ...(process.env.NUXT_NITRO_PRESET === 'cloudflare-module' ? {
    cloudflare: {
      deployConfig: true,
      nodeCompat: true
    }
  } : {}),
}
```

### package.json Scripts

- [ ] Update paths from `server/database/` to `server/db/`:

```diff
- "auth:schema": "npx @better-auth/cli generate --config server/utils/auth.ts --output server/database/schema/auth.ts -y",
+ "auth:schema": "npx @better-auth/cli generate --config server/utils/auth.ts --output server/db/schema/auth.ts -y",

- "db:generate": "drizzle-kit generate --config ./server/database/drizzle.config.ts",
+ "db:generate": "drizzle-kit generate --config ./server/db/drizzle.config.ts",

- "db:migrate": "drizzle-kit migrate --config ./server/database/drizzle.config.ts",
+ "db:migrate": "drizzle-kit migrate --config ./server/db/drizzle.config.ts",
```

### drizzle.config.ts

- [ ] Update database URL reference:

```diff
  dbCredentials: {
-   url: process.env.NUXT_DATABASE_URL!
+   url: process.env.DATABASE_URL!
  }
```

- [ ] Update paths:

```diff
- schema: './server/database/schema/index.ts',
- out: './server/database/migrations',
+ schema: './server/db/schema/index.ts',
+ out: './server/db/migrations',
```

### runtimeConfig.ts

- [ ] Update database URL reference:

```diff
- databaseUrl: process.env.NUXT_DATABASE_URL,
+ databaseUrl: process.env.DATABASE_URL,
```

### .gitignore

- [ ] Update migrations path:

```diff
- server/database/migrations
+ server/db/migrations
```

- [ ] Add wrangler config:

```
wrangler.jsonc
```

### .env.example

- [ ] Rename database URL:

```diff
- NUXT_DATABASE_URL=postgres://postgres:@localhost:5432/yourdb
+ DATABASE_URL=postgres://postgres:@localhost:5432/yourdb
```

---

## New Files to Create

- [ ] Create `wrangler.jsonc` from `wrangler.example.jsonc`
- [ ] Fill in your Cloudflare resource IDs (KV, R2, Hyperdrive)

---

## Type Declarations

- [ ] Delete old `server/types/hub.d.ts` (if it has `hubKV` types)
- [ ] Create new `server/types/hub.d.ts` with v0.10 types:

```ts
import type { Storage } from 'unstorage'

declare module 'hub:kv' {
  interface KVStorage extends Storage {
    keys: Storage['getKeys']
    get: Storage['getItem']
    set: Storage['setItem']
    has: Storage['hasItem']
    del: Storage['removeItem']
    clear: Storage['clear']
  }
  export const kv: KVStorage
}

declare module 'hub:blob' {
  import type { BlobStorage, BlobEnsureOptions } from '@nuxthub/core/blob'
  export const blob: BlobStorage
  export const ensureBlob: (blob: Blob, options: BlobEnsureOptions) => void
}
```

---

## Package Updates

- [ ] Update `@nuxthub/core` to v0.10+:

```bash
pnpm remove @nuxthub/core
pnpm add @nuxthub/core
```

---

## Database Migrations

- [ ] Mark all existing migrations as applied:

```bash
# List migrations
ls server/db/migrations/

# Mark each as applied
npx nuxt db mark-as-migrated 0000_migration_name
npx nuxt db mark-as-migrated 0001_migration_name
# ... repeat for all
```

---

## API Keys Scoped to Their Organization

API keys belong to exactly one organization: better-auth's API key plugin stores the
organization's id in `api_key.reference_id` (`references: 'organization'`), checks the caller's
`apiKey` permission in that organization when a key is created. The deprecated
`api_key_organization` table stays in the schema until
[#162](https://github.com/juherr/nuxt-saas-starter/issues/162) removes it: upgrade every deployment
through this release first.

The move is automatic. After all migrations, `pnpm build` (with `DATABASE_URL`),
`npx nuxt db migrate` and `pnpm dev` run
`server/db/queries/api-key-organization-owner.postgresql.sql`, a single statement that moves every
linked key to its organization, deletes the disabled keys that belong to no organization, and adds
the foreign key `api_key.reference_id` → `organization.id` (`ON DELETE CASCADE`). It refuses, and
changes nothing, while an enabled key belongs to no organization.

- [ ] Plan a short maintenance window
  ([Upgrading to organization-owned API keys](../README.md#upgrading-to-organization-owned-api-keys)):
  back up the database, stop every instance of the previous release, build and migrate, then start
  the new release. Once the query has run, the previous release cannot create a key, does not see
  or revoke the keys of the new release, and rolling back the app does not restore its behaviour.
- [ ] When upgrading from the better-auth 1.4 schema in one go, edit the generated migration as
  [Upgrading from better-auth 1.4](../README.md#upgrading-from-better-auth-14) explains, including
  deleting `ALTER TABLE "api_key_organization" DROP CONSTRAINT "api_key_organization_api_key_id_apiKey_id_fk";`
  when the link table exists: `DROP TABLE "apiKey" CASCADE` has already dropped that constraint.
- [ ] If the build or `npx nuxt db migrate` stops on that query, nothing has moved: list the
  blocking keys with the SQL in its message (enabled, in no organization, not linked), delete them
  or move each one to its organization, then run it again. If it stops on
  `canceling statement due to lock timeout`, a session held `api_key` for more than 5 seconds:
  stop it and run it again.
- [ ] Check readiness: `GET /api/health` answers `503` until the query has added the foreign key.
  On Cloudflare, whose build has no `DATABASE_URL`, run `npx nuxt db migrate` against the
  production database before or right after the deploy.
- [ ] Tell the affected users. A key deleted that way must be recreated by an owner or admin.
- [ ] Update API clients: a key is created with a top-level `organizationId`
  (`POST /api/auth/api-key/create`), not `metadata.organizationId`; a request without it gets 400
  `ORGANIZATION_ID_REQUIRED`.

Only an `owner` or `admin` of the organization may create, list or revoke its keys. The API key
plugin's own `/api-key/get`, `/api-key/list`, `/api-key/update` and `/api-key/delete` endpoints are
disabled: keys are listed and revoked through `/api/organization/api-keys`, which check the
caller's role in the key's organization and never return the key itself. A key survives the user
who created it. Deleting an organization deletes its keys through the foreign key's
`ON DELETE CASCADE`, including an organization row deleted directly in SQL; a key created while its
organization is being deleted either fails on the foreign key or is deleted with it.

---

## Deployment

- [ ] Build the application:

```bash
pnpm build
```

- [ ] Deploy to Cloudflare:

```bash
npx wrangler deploy
```

---

## Verification

- [ ] Local dev works: `pnpm dev`
- [ ] Build succeeds: `pnpm build`
- [ ] Deploy succeeds: `npx wrangler deploy`
- [ ] App loads in production
- [ ] Authentication works
- [ ] Database queries work
- [ ] File uploads work (if using blob storage)
- [ ] Caching works (sessions, rate limiting)

---

## Quick Reference: Find & Replace

| Find | Replace |
|------|---------|
| `server/database` | `server/db` |
| `NUXT_DATABASE_URL` | `DATABASE_URL` |
| `hubKV()` | `kv` (with import) |
| `hubBlob()` | `blob` (with import) |
| `hubDatabase()` | `db` (with import) |
| `hub.database: true` | `hub.db: 'postgresql'` |
