# tests/

- Vitest projects (`vitest.config.ts`): `unit` = `tests/unit/**` (node; `~~` → root, `hub:kv` →
  `unit/stubs/hub-kv.ts`), `nuxt` = `tests/components/**` (happy-dom), `e2e` = `tests/e2e/**`.
  Scripts: root `CLAUDE.md` § Checks. `uploadRateLimiterRedis.test.ts` needs `REDIS_URL`: skipped
  locally without it, it fails when `CI` is set (the CI `unit` job provides Redis 7).
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
  sign-up, then `email_verified = true`). Build with `NUXT_APP_NAME='House of BetterAuth'`
  (`global.appName`, which the pages render). Locally: build and start the app as the job does, install
  the browser (`pnpm exec playwright-core install --only-shell chromium`), then
  `pnpm exec vitest run --project e2e`. A failed test leaves a screenshot of each page it opened in
  `test-results/e2e/` (`tests/e2e/setup.ts`).
