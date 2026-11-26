# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Public demo mode, enabled with `NUXT_PUBLIC_DEMO_MODE=true`: the sign-in page shows the demo
  accounts and can fill the form with them, sign-up, social sign-in and uploads are hidden or
  refused, and auth requests that would change the shared demo accounts, organizations, avatars
  or logos answer 403 `DEMO_MODE_RESTRICTED`. The admin data routes also hide audit logs,
  sessions, accounts, verifications, rate limits and API keys in demo mode
  ([#103](https://github.com/juherr/nuxt-saas-starter/pull/103),
  [#112](https://github.com/juherr/nuxt-saas-starter/pull/112),
  [#115](https://github.com/juherr/nuxt-saas-starter/pull/115))
- Deterministic demo data with `pnpm demo:seed`, and `pnpm demo:reset`, which wipes and reseeds a
  database only when `DEMO_RESET_CONFIRM` equals the hostname of `DATABASE_URL`
  ([#102](https://github.com/juherr/nuxt-saas-starter/pull/102))
- Demo workflow deploying to Cloudflare Workers from `main` after a green CI run and resetting the
  demo database nightly, documented in [docs/DEMO_DEPLOYMENT.md](docs/DEMO_DEPLOYMENT.md)
  ([#104](https://github.com/juherr/nuxt-saas-starter/pull/104))
- The build version (git tag, else `dev-<short sha>`) is shown in the footer and the dashboard
  sidebar; `NUXT_PUBLIC_APP_VERSION` overrides it
  ([#114](https://github.com/juherr/nuxt-saas-starter/pull/114))
- REUSE compliance: every source file carries an SPDX header, `REUSE.toml` covers the files that
  cannot, and a `reuse` CI job fails on a new file without one. The README explains how to license
  a new file
- This changelog, following Keep a Changelog. Commit messages follow Conventional Commits, checked
  by a commitlint `commit-msg` hook and, on pull requests, on the title and the commits.
  `CONTRIBUTING.md` and a pull request template describe both

### Changed

- `pnpm typecheck` is a blocking CI check and must stay at zero errors
  ([#98](https://github.com/juherr/nuxt-saas-starter/pull/98))
- Rename the package to `nuxt-saas-starter`, declare it MIT in `package.json`, restore the NuxSaaS
  copyright notice in `LICENSE` next to every other holder, and point funding and repository links
  (`NUXT_APP_REPO` default, site navigation) to this project
- GitHub Actions are pinned to commit SHAs, with their version in a comment that Dependabot updates

### Removed

- `NUXT_CF_HYPERDRIVE_ID` from `.env.example`: nothing read it, the Hyperdrive binding comes from
  `wrangler.jsonc` ([#104](https://github.com/juherr/nuxt-saas-starter/pull/104))

### Fixed

- `pnpm install --frozen-lockfile` no longer fails on the `better-sqlite3` build script under
  pnpm 12 ([#84](https://github.com/juherr/nuxt-saas-starter/pull/84))
- The pricing page sends a plan the Stripe plugin knows, so checkout no longer fails
  ([#89](https://github.com/juherr/nuxt-saas-starter/pull/89))
- The seat-change preview of a trialing subscription no longer crashes
  ([#85](https://github.com/juherr/nuxt-saas-starter/pull/85))
- Invitation emails link to the accept-invite page instead of a 404
  ([#86](https://github.com/juherr/nuxt-saas-starter/pull/86))
- The creator's referral code is copied onto a new organization
  ([#87](https://github.com/juherr/nuxt-saas-starter/pull/87))
- Signing in with an unverified email opens the verify-email dialog
  ([#88](https://github.com/juherr/nuxt-saas-starter/pull/88))
- Creating a user outside an endpoint no longer fails, and the profile page shows a linked GitHub
  account as linked ([#94](https://github.com/juherr/nuxt-saas-starter/pull/94))
- Danger buttons and other components using Nuxt UI v2 colour names or `ui` objects render with
  their intended style ([#96](https://github.com/juherr/nuxt-saas-starter/pull/96),
  [#97](https://github.com/juherr/nuxt-saas-starter/pull/97))
- Admin table filters naming an inherited key such as `toString` are ignored
  ([#95](https://github.com/juherr/nuxt-saas-starter/pull/95))
- Switching the home page screenshot tabs no longer flashes an empty panel
- The members page role menu shows every role a member holds and adds or removes one role at a
  time instead of replacing the whole list; the last role cannot be removed
  ([#132](https://github.com/juherr/nuxt-saas-starter/pull/132))
- Users holding the admin role among several roles (`user,admin`) can reach the admin pages and
  API and delete other users' files, and the admin users page role menu adds or removes the
  clicked role instead of replacing the list ([#123](https://github.com/juherr/nuxt-saas-starter/pull/123))
- The dashboard's profile settings page and its notifications follow the selected language
  (English, French, Japanese or Simplified Chinese) instead of always showing English
  ([#127](https://github.com/juherr/nuxt-saas-starter/pull/127))
- Billing previews show the real next billing date: the trial end while trialing, and the current
  period end for a seat change on a yearly plan instead of a date a year from now
  ([#130](https://github.com/juherr/nuxt-saas-starter/pull/130))
- Cookies refreshed while a page renders on the server, such as the session cache set by
  `get-session`, now reach the browser and the later requests of the same render
  ([#131](https://github.com/juherr/nuxt-saas-starter/pull/131))
- Resending the verification email no longer claims an email was sent when delivery failed: the
  sign-in page shows a neutral message, and the server logs the failure as an error
  ([#128](https://github.com/juherr/nuxt-saas-starter/pull/128))
- The French, Japanese and Chinese pages translate the dashboard link and the home page features
  instead of showing raw message keys, and a key missing from a locale now falls back to English
  ([#129](https://github.com/juherr/nuxt-saas-starter/pull/129))
- A removed user, or a revoked session, loses access to the API routes at once instead of keeping
  it for up to five minutes through the session cookie cache
  ([#124](https://github.com/juherr/nuxt-saas-starter/pull/124))
- Deleting an account deletes the files the user uploaded, rows and stored objects. A file whose
  storage deletion fails is logged and kept for a later cleanup, without blocking the account
  deletion ([#125](https://github.com/juherr/nuxt-saas-starter/pull/125))
- Replacing or removing your avatar deletes the previous avatar file you uploaded, instead of
  leaving it in storage. A file another user uploaded at the same URL is kept
  ([#126](https://github.com/juherr/nuxt-saas-starter/pull/126))
- **Breaking:** `NUXT_ADMIN_EMAIL` and `NUXT_ADMIN_PASSWORD` no longer default to placeholder
  credentials: set both before running `node create-admin.ts`. The script now exits with code 1 and
  says what to fix when the admin cannot be created or a setting is missing, and an unreachable
  database fails after 10 seconds instead of hanging (`NUXT_DATABASE_CONNECT_TIMEOUT_MS`)
  ([#133](https://github.com/juherr/nuxt-saas-starter/pull/133))
- The Node self-hosting guide explains that the default `fs-lite` KV driver never removes expired
  sessions and rate-limit counters, recommends Redis in production, and gives a cron-able `find`
  command that clears them from `.data/kv`
  ([#134](https://github.com/juherr/nuxt-saas-starter/pull/134))
- **Breaking:** S3 or R2 storage without a public URL now refuses every upload with a 503 that
  names the variable to set, instead of storing a file with no URL and leaving the uploaded avatar
  empty. Set the bucket's public URL in `NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL` (S3), or in
  `NUXT_CF_R2_PUBLIC_URL` at build or `NUXT_FILE_MANAGER_STORAGE_R2_PUBLIC_URL` at runtime (R2)
  ([#141](https://github.com/juherr/nuxt-saas-starter/pull/141))

## [0.1.0] - 2026-11-18

First release of the fork of
[HouseOfBetterAuth/nuxt-better-auth-saas](https://github.com/HouseOfBetterAuth/nuxt-better-auth-saas)
as of 2025-12-14, itself built on NuxSaaS. Changes made before the fork are not itemised here.

### Added

- `GET /api/health` for load balancers: it answers 503 when the database is not configured or does
  not answer within 2 seconds ([#16](https://github.com/juherr/nuxt-saas-starter/pull/16))
- Access log with one line per request, a request id echoed in `x-request-id`, and the
  `NUXT_LOG_LEVEL` and `NUXT_LOG_FORMAT` (text or JSON) settings
  ([#28](https://github.com/juherr/nuxt-saas-starter/pull/28))
- `pnpm db:backfill-api-keys`, which links existing API keys to their organization and, with
  `--disable-unlinked`, disables the keys it cannot link
  ([#23](https://github.com/juherr/nuxt-saas-starter/pull/23))
- CI workflow running lint, typecheck, unit and component tests, a build without any service
  configured, and a Node.js smoke test against PostgreSQL and Redis; Dependabot for npm and GitHub
  Actions ([#16](https://github.com/juherr/nuxt-saas-starter/pull/16),
  [#54](https://github.com/juherr/nuxt-saas-starter/pull/54))
- Self-hosting guide for Node.js ([docs/SELF_HOSTING_NODE.md](docs/SELF_HOSTING_NODE.md)), covering
  migrations, KV, uploads, access logs and reverse proxy settings
  ([upstream #15][upstream-15],
  [#27](https://github.com/juherr/nuxt-saas-starter/pull/27))
- `CLAUDE.md` files with the project commands and conventions for coding agents
  ([#65](https://github.com/juherr/nuxt-saas-starter/pull/65),
  [#82](https://github.com/juherr/nuxt-saas-starter/pull/82))

### Changed

- **Breaking:** upgrade better-auth and its Stripe plugin from 1.4 to 1.7. Existing databases need
  `pnpm db:generate` and a hand-edited migration (new `api_key` and `rate_limit` tables, a
  `NOT NULL` subscription status), as described in
  [Upgrading from better-auth 1.4](README.md#upgrading-from-better-auth-14). Verification values
  and rate limits now live in PostgreSQL, so password reset and account deletion links sent before
  the deploy stop working. An organization with a live subscription can no longer be deleted, and
  Google or GitHub sign-in no longer links to an account whose email is not verified
  ([#56](https://github.com/juherr/nuxt-saas-starter/pull/56))
- **Breaking:** API keys now belong to exactly one organization through the new
  `api_key_organization` table. Generate and apply its migration, then run
  `pnpm db:backfill-api-keys`: keys left unlinked are no longer listed and must be recreated (see
  [API Keys Scoped to Their Organization](docs/MIGRATION_CHECKLIST.md#api-keys-scoped-to-their-organization))
  ([#23](https://github.com/juherr/nuxt-saas-starter/pull/23))
- **Breaking:** require Node.js 26 and pnpm 12 (pinned through `packageManager`). Dependency build
  scripts are allow-listed in `pnpm-workspace.yaml`; TypeScript moves to 6, Vitest to 5 with a
  single `vitest.config.ts` (`unit`, `nuxt` and `e2e` projects, `pnpm test:ci` for CI), ESLint to
  10 ([#57](https://github.com/juherr/nuxt-saas-starter/pull/57),
  [#58](https://github.com/juherr/nuxt-saas-starter/pull/58))
- **Breaking:** upgrade the Stripe SDK to 23 and pin the client to its API version
  (`Stripe.API_VERSION`, `2026-10-28.endive`). The webhook endpoint must use the same version: since
  an endpoint's version cannot be changed, create a new one and put its signing secret in
  `NUXT_STRIPE_WEBHOOK_SECRET` (see [Stripe Webhook Setup](README.md#stripe-webhook-setup))
  ([#60](https://github.com/juherr/nuxt-saas-starter/pull/60))
- **Breaking:** uploads are limited by default to 5 MB and to PNG, JPEG, WebP and GIF images, whose
  content must match the declared type; SVG, HTML and executables are always refused. Widen the
  defaults with `NUXT_FILE_MANAGER_MAX_FILE_SIZE` and `NUXT_FILE_MANAGER_ALLOWED_MIME_TYPES`.
  Stored files get generated names, and `NUXT_LOCAL_PUBLIC_PATH` is now read at build time only
  ([#37](https://github.com/juherr/nuxt-saas-starter/pull/37))
- Upgrade Nuxt to 4.6, Nuxt UI to 4.12, `@nuxtjs/seo` to 6 (with `@nuxtjs/i18n` 10), ECharts to 6,
  VueUse to 15, React Email to 6 and wrangler to 4.163, along with the other dependencies within
  their majors ([#55](https://github.com/juherr/nuxt-saas-starter/pull/55),
  [#59](https://github.com/juherr/nuxt-saas-starter/pull/59))
- Resend and Stripe are optional: the server starts without `NUXT_RESEND_API_KEY` or
  `NUXT_STRIPE_SECRET_KEY`, and billing routes answer 503 until Stripe is configured
  ([upstream #14][upstream-14],
  [upstream #19][upstream-19])
- Billing routes act on the organization's single active or trialing subscription, across every
  page of Stripe results, and answer 400 when there is none and 409 when there are several
  ([#21](https://github.com/juherr/nuxt-saas-starter/pull/21))
- Lower the PostgreSQL pool from 90 to 10 connections per process, leaving room for a second
  instance, migrations and admin sessions
  ([upstream #14][upstream-14])

### Removed

- **Breaking:** the better-auth plugin endpoints `/subscription/cancel`, `/subscription/restore`
  and `/api-key/get`, `/api-key/list`, `/api-key/update`, `/api-key/delete` are disabled, since they
  do not check the organization. Use `/api/stripe/cancel`, `/api/stripe/resume` and the
  organization API key routes instead
  ([#19](https://github.com/juherr/nuxt-saas-starter/pull/19),
  [#23](https://github.com/juherr/nuxt-saas-starter/pull/23))
- The unused `/api/organization/page-data` route; `/api/organization/full-data` returns the same
  data ([#27](https://github.com/juherr/nuxt-saas-starter/pull/27))
- The unused `useCustomFetch` composable
  ([#59](https://github.com/juherr/nuxt-saas-starter/pull/59))

### Fixed

- Every runtime config key can now be set when the server starts (`NUXT_DATABASE_URL`,
  `NUXT_PUBLIC_BASE_URL`, `NUXT_FILE_MANAGER_STORAGE_*`…), not only at build time, and
  `create-admin.ts` reads `DATABASE_URL` like the app
  ([upstream #16][upstream-16],
  [upstream #15][upstream-15])
- `pnpm build` works without a database URL; migrations are applied at build time only when one is
  set
  ([upstream #20][upstream-20])
- `pnpm preview:cf` no longer passes a flag current wrangler rejects
  ([#59](https://github.com/juherr/nuxt-saas-starter/pull/59))
- Switching organization during server rendering keeps the new active organization, including from
  a typed URL or a bookmark, and a refused switch redirects instead of showing the wrong
  organization ([#27](https://github.com/juherr/nuxt-saas-starter/pull/27),
  [#79](https://github.com/juherr/nuxt-saas-starter/pull/79))
- Members holding several roles (such as `owner,admin`) are recognised by billing, API key and
  dashboard checks, and by the member cleanup on subscription expiry
  ([#77](https://github.com/juherr/nuxt-saas-starter/pull/77))
- Subscription period ends are read from the subscription items, so renewal dates in emails,
  scheduled plan changes and seat updates are no longer empty, and the credit balance shows the
  proration credits of the upcoming invoice again
  ([#60](https://github.com/juherr/nuxt-saas-starter/pull/60))
- The forgot-password page calls the endpoint better-auth serves, and unlinking a social account
  works with better-auth 1.7 ([#56](https://github.com/juherr/nuxt-saas-starter/pull/56))
- Admin table filters no longer share one selection between instances
  ([#55](https://github.com/juherr/nuxt-saas-starter/pull/55))
- Deleting a file whose stored copy cannot be removed keeps its record and reports the failure
  ([#76](https://github.com/juherr/nuxt-saas-starter/pull/76))

### Security

- The billing portal requires membership of the organization and only returns to the app's own
  URLs ([upstream #13][upstream-13])
- Cancelling, resuming and upgrading a subscription check that it belongs to the caller's
  organization ([#19](https://github.com/juherr/nuxt-saas-starter/pull/19))
- API keys can only be created, listed and revoked by an owner or admin of their organization,
  listings no longer expose key hashes, and keys are deleted with their organization or their user
  ([#23](https://github.com/juherr/nuxt-saas-starter/pull/23),
  [#56](https://github.com/juherr/nuxt-saas-starter/pull/56))
- During server rendering, the auth client no longer derives its URL from the `Host` header, which
  could send the visitor's session cookie to another origin
  ([#27](https://github.com/juherr/nuxt-saas-starter/pull/27))
- Access logs no longer contain query strings or password reset tokens, and cannot be forged with
  control characters ([#28](https://github.com/juherr/nuxt-saas-starter/pull/28))
- Email verification links are no longer printed to the server log outside development
  ([upstream #14][upstream-14])
- The upload rate limit holds under concurrent requests (atomic with Redis) and refuses uploads
  when its store is down ([#31](https://github.com/juherr/nuxt-saas-starter/pull/31))
- Uploads check their bytes against their declared type, never take a storage path from the client
  filename, stay inside the upload directory even through symbolic links, and are served with
  `nosniff` and an attachment disposition for anything but images
  ([#37](https://github.com/juherr/nuxt-saas-starter/pull/37),
  [#76](https://github.com/juherr/nuxt-saas-starter/pull/76))
- Error responses no longer echo Stripe, database or file system messages, and deleting another
  user's file answers 404 like an unknown file
  ([#76](https://github.com/juherr/nuxt-saas-starter/pull/76),
  [#78](https://github.com/juherr/nuxt-saas-starter/pull/78))

[unreleased]: https://github.com/juherr/nuxt-saas-starter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/juherr/nuxt-saas-starter/releases/tag/v0.1.0
[upstream-13]: https://github.com/HouseOfBetterAuth/nuxt-better-auth-saas/pull/13
[upstream-14]: https://github.com/HouseOfBetterAuth/nuxt-better-auth-saas/pull/14
[upstream-15]: https://github.com/HouseOfBetterAuth/nuxt-better-auth-saas/pull/15
[upstream-16]: https://github.com/HouseOfBetterAuth/nuxt-better-auth-saas/pull/16
[upstream-19]: https://github.com/HouseOfBetterAuth/nuxt-better-auth-saas/pull/19
[upstream-20]: https://github.com/HouseOfBetterAuth/nuxt-better-auth-saas/pull/20
