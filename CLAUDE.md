# nuxt-saas-starter

## Toolchain
- Node 26 (`mise.toml`), pnpm 12 via `packageManager`; run pnpm through that version, not a global shim.
- pnpm 12 rejects versions published < 24 h ago (`minimumReleaseAge` default, kept on purpose):
  a freshly resolved lockfile can fail `pnpm install --frozen-lockfile` in CI until the next day.
  Locally, `--config.minimum-release-age=0` passes that check without touching the lockfile: only
  with the user's go.
- The shell's Node may be 22: run `mise exec -- corepack pnpm <cmd>` (Node read from `mise.toml`).
  Node ≥ 25 ships no Corepack: install it once with `mise exec -- npm install -g corepack`. The husky
  hook runs under the shell's Node: Node 26 with `mise activate` in the shell, otherwise it prints
  engine warnings.
- Build scripts of dependencies are allow-listed in `pnpm-workspace.yaml` (`allowBuilds`).

## Run
- `cp .env.example .env` → `pnpm db:generate` → `pnpm dev` (applies migrations on start;
  `npx nuxt db migrate` applies them alone).
- Target is picked at build by `NUXT_NITRO_PRESET`: `node-server` (`pnpm build && pnpm serve`, see
  `docs/SELF_HOSTING_NODE.md`) or `cloudflare-module` (`pnpm preview:cf`, `pnpm run deploy`,
  `wrangler.example.jsonc`). `.env.example` sets `cloudflare-module`; unset, the build is `node-server`;
  `pnpm dev` always runs `node-server` unless `NUXT_FORCE_CLOUDFLARE_DEV` is set.
- KV (sessions) driver is baked in at **build** time: Redis when `REDIS_URL` is set, the `KV` binding on
  Cloudflare, else `fs-lite` under `.data/kv`; `NUXT_REDIS_URL` is read by nothing. The upload rate limiter reads `REDIS_URL` at run time.
- `node create-admin.ts` creates an admin from `NUXT_ADMIN_EMAIL` / `NUXT_ADMIN_PASSWORD` (needs
  `DATABASE_URL`; the CI smoke job uses it). It builds its own better-auth instance, so the app's
  `databaseHooks` do not run: probe a hook through `POST /api/auth/sign-up/email`.

## Layout
- `app/` Nuxt UI front (pages, components, composables).
- `server/api/**` routes (admin, auth, organization, public, stripe, file, health) · `server/utils/` auth
  (better-auth factory in `auth.ts`), billing, Stripe, drivers · `server/db/schema/` Drizzle schema (pg).
- `shared/utils/` code shared by app and server (e.g. `permissions.ts` access control).
- `emails/*.tsx` React Email templates rendered by `server/utils/email.ts`.
- Area conventions: `server/CLAUDE.md` (auth guards, org roles, DB, errors), `app/CLAUDE.md`
  (useAuth, route guards, i18n, forms), `tests/CLAUDE.md` (route stubs, mocks, component mounts).

## Checks
- `pnpm lint --max-warnings=0` — also the husky pre-commit hook; never `--no-verify`.
- `pnpm test:unit` (node project) · `pnpm test:ci` (unit + nuxt components, what CI runs) ·
  `pnpm test` (all); the `e2e` project builds the app or targets `NUXT_TEST_APP_URL`, out of CI.
- `pnpm typecheck` is blocking in CI and must stay at zero errors. Do not silence an error with
  `any`, `as unknown as`, `@ts-ignore`/`@ts-expect-error` or a non-null `!`. Use a guard instead.
- `postgres` is loaded by NuxtHub and `ioredis` lazily by `server/utils/redis.ts`: only a booted app
  exercises them — mirror the `smoke-node` job of `.github/workflows/ci.yml` (Postgres 16 + Redis 7,
  `DATABASE_URL` / `REDIS_URL` set at build).

## Database and auth
- `server/db/migrations` (written by `pnpm db:generate`) is gitignored: never commit migrations;
  document schema changes as an upgrade note in the README.
- Never run `pnpm db:migrate`: drizzle-kit records migrations in `drizzle.__drizzle_migrations`,
  NuxtHub in `_hub_migrations`, so each re-applies the other's (`docs/SELF_HOSTING_NODE.md`).
- Two worktrees may share one database only when their schemas are identical, and then they must
  share one `server/db/migrations` folder: `db:generate` names migrations differently per run, so
  the second build fails. With differing schemas, use separate databases: `db:generate` diffs
  against the folder's latest snapshot, so a schema missing a table generates a `DROP TABLE`.
- `pnpm auth:schema` regenerates `server/db/schema/auth.ts`; custom columns survive only when declared
  in better-auth `additionalFields` (user: `lastActiveOrganizationId`, `referralCode`; organization:
  `organizationAdditionalFields` in `server/utils/authSchemaFields.ts`); `stripeCustomerId` comes from
  the Stripe plugin.
- better-auth verification and rate limit live in the database: `hub:kv` has no atomic consume or
  increment, so `cacheClient.getAndDelete` / `increment` (`server/utils/drivers.ts`) throw on purpose.
- better-auth refuses a POST without `Origin`/`Referer` (403 `MISSING_OR_NULL_ORIGIN`), as an SSR
  in-process POST from a typed URL is; `app/utils/authClientTransport.ts` adds the configured origin
  to `set-active` only, and only when `Sec-Fetch-Site` is `none` or `same-origin`.

## Conventions
- Stripe: `apiVersion: Stripe.API_VERSION`; read period ends through
  `server/utils/stripeSubscriptionPeriod.ts`; checkout reference, customer type and seats are decided server-side.
- ESLint: `antfu/reasonable-newline` is off on purpose (#47). antfu's pnpm rules are on: they enforce
  `trustPolicy: no-downgrade`, `shellEmulator` and `minimumReleaseAgeExcludePrune` in `pnpm-workspace.yaml`.
- `ERR_PNPM_TRUST_DOWNGRADE` on install: first update the lockfile to a newer release of that package
  that carries provenance (`npm view <pkg>@<v> dist.attestations`). Last resort, once the release is
  checked legitimate (npm page, GitHub release and tag): add its exact `name@version` (never a bare
  name) to `trustPolicyExclude` with a comment.
- Conventional Commits (commitlint `commit-msg` hook; PR title and commits in CI) and a Keep a
  Changelog entry under `[Unreleased]` for user-visible changes: `CONTRIBUTING.md`.
- GitHub Actions are pinned to a commit SHA with the exact version as an end-of-line comment
  (`@<sha> # v4.4.0`); Dependabot bumps both.
- New files start with an SPDX MIT header (README › License); `reuse lint`
  (CI job `reuse`, locally `mise x pipx:reuse -- reuse lint`) fails without it.
- Confirm a Nuxt module bump with `nuxt prepare`/`build`: modules can require versions `npm view` does not show.
