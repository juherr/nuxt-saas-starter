# tests/

- Vitest projects (`vitest.config.ts`): `unit` = `tests/unit/**` (node; `~~` → root, `hub:kv` →
  `unit/stubs/hub-kv.ts`), `nuxt` = `tests/components/**` (happy-dom), `e2e` = `tests/e2e/**`.
  Scripts: root `CLAUDE.md` § Checks. `uploadRateLimiterRedis.test.ts` and the key-format suite of
  `cacheBackend.test.ts` need `REDIS_URL`: skipped locally without it, they fail when `CI` is set (the
  CI `unit` job provides Redis 7). Under that job the real `cacheClient` (`drivers.ts`) picks Redis:
  a test that needs it on `hub:kv` builds its own with `createCacheClient({ kv, redis: async () => null })`.
  Postgres suites (`describeWithPostgres`, `unit/support/postgres.ts`) need `TEST_DATABASE_URL`, an
  admin URL: each file creates and drops its own database; same skip/fail rule (CI: Postgres 16).
- One file: `pnpm vitest run <file>` (unit), `pnpm vitest run --project nuxt <file>` (components).
- Route tests: `beforeAll(stubNitroGlobals)` then `callRoute(() => import('~~/server/api/...'), body, query,
  params, headers)` from `unit/support/nitroGlobals.ts`; stub `useRuntimeConfig` yourself when needed.
- Mocks: `vi.hoisted(() => vi.fn())` + `vi.mock('~~/server/utils/<name>', ...)`; `useDB` returns
  `{ query: { <table>: { findFirst } } }`. Reuse fakes in `unit/support/` (`sql.ts` renderSql,
  `stripeSubscriptionsFake.ts`) and `resetKvStub` / `kvSetCalls` from the `hub:kv` stub.
- A `vi.mock` factory replaces the whole module: a new export added to a mocked
  `server/utils/<name>` is `undefined` in those suites, so put a new shared helper in its own module.
- Component tests: `mountSuspended` + `mockNuxtImport` from `@nuxt/test-utils/runtime`; SFCs with an
  `<i18n>` block need `mockNuxtImport('useI18n', () => () => ({ t: key => key }))`.
- e2e: `setup({ host: process.env.NUXT_TEST_APP_URL })` + `createPage`, run by the CI job `e2e`. Two
  users must exist: an admin (`NUXT_ADMIN_EMAIL` / `PASSWORD`, `node create-admin.ts`) and a regular
  user with a verified email (`NUXT_TEST_EMAIL` / `PASSWORD`, `.github/scripts/e2e-seed-user.sh`:
  sign-up, then `email_verified = true`). That script expects a fresh database in a Postgres container
  (`POSTGRES_CONTAINER`, run through `docker exec`) and fails if the user already exists. The pages
  render `global.appName` (`app/i18n/global.json`), and the tests look for it through
  `NUXT_APP_NAME`: export `NUXT_APP_NAME='House of BetterAuth'` in the shell that runs vitest (the
  build reads it only for a meta tag). Locally: build and start the app as the job does, install the
  browser (`pnpm exec playwright-core install --only-shell chromium`), then
  `pnpm exec vitest run --project e2e`. A failed test leaves a screenshot of each page still open in
  `test-results/e2e/` (`tests/e2e/setup.ts`, which patches `chromium.launch`; the unit test
  `e2eScreenshotPatch.test.ts` fails if `@nuxt/test-utils` launches another copy of playwright-core).
  To check the screenshots by hand, run the suite with a wrong `NUXT_APP_NAME`: the tests that look
  for the title fail and leave PNGs there.
