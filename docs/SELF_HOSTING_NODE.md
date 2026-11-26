# Self-Hosting on Node.js

This guide covers running the app as a plain Node.js server (`node-server` Nitro preset),
outside Cloudflare Workers. For Workers, see [NUXTHUB_SELF_HOSTED.md](NUXTHUB_SELF_HOSTED.md).

You need:

- Node.js 26 or later (`mise.toml`) and pnpm (the version pinned in `packageManager` of `package.json`)
- a PostgreSQL database
- a writable, persistent directory for sessions (see [Sessions and KV](#2-sessions-and-kv)), or a Redis server

---

## 1. Database migrations

`server/db/migrations` is listed in `.gitignore`: a fresh clone has no migration files. Generate
them from the Drizzle schema (`server/db/schema/`); this step does not connect to the database:

```bash
pnpm db:generate
```

This runs `drizzle-kit generate` with `server/db/drizzle.config.ts` and writes
`server/db/migrations/0000_<name>.sql` plus a `meta/` folder. If you deploy from CI or from another
checkout, commit these files in your own repository (or remove the `server/db/migrations` line from
`.gitignore`), so that every build applies the same migrations.

Upgrading a database created with better-auth 1.4 needs a hand-edited migration: see
[Upgrading from better-auth 1.4](../README.md#upgrading-from-better-auth-14).

### Apply them through NuxtHub only

Two tools can apply these files, and each keeps its own tracking table:

| Command | Applied by | Tracking table |
|---------|-----------|----------------|
| `npx nuxt db migrate`, `pnpm dev`, `pnpm build` | NuxtHub | `_hub_migrations` |
| `pnpm db:migrate` | drizzle-kit | `drizzle.__drizzle_migrations` |

NuxtHub applies pending migrations on its own whenever `DATABASE_URL` is set: when the dev server
starts, and at the end of `pnpm build`. Mixing both tools on one database fails, because each one
sees the other's migrations as pending and stops with `relation "…" already exists`.

Use NuxtHub for every environment:

```bash
# apply pending migrations without building
DATABASE_URL=postgres://user:password@host:5432/database npx nuxt db migrate
```

Running it again prints `Database migrations up to date`. If the database was already migrated
with `pnpm db:migrate`, record the existing migrations in `_hub_migrations` once instead of
applying them again:

```bash
npx nuxt db mark-as-migrated 0000_<name>
```

> If `DATABASE_URL` is set when you run `pnpm build`, the build connects to that database and
> applies the pending migrations to it. Build against the database you deploy to, or migrate it
> separately with `npx nuxt db migrate`.

---

## 2. Sessions and KV

`NUXT_REDIS_URL` (`runtimeConfig.redisUrl`) is not read by any code. Only the upload rate limiter
talks to Redis directly (see below). Better Auth keeps its sessions in NuxtHub KV (`hub:kv`, used as `secondaryStorage`), and
NuxtHub chooses the KV driver **when the app is built**:

| Build environment | KV driver |
|-------------------|-----------|
| `REDIS_URL` set (or `KV_URL` starting with `rediss://`) | Redis, through `ioredis` |
| `NUXT_NITRO_PRESET=cloudflare-module` | Cloudflare KV binding `KV` |
| none of the above | `fs-lite`, files under `.data/kv` |

The driver and its options, including the Redis URL, are written into the build output. Changing
them means building again.

With the default `fs-lite` driver, `.data/kv` is resolved from the **working directory of the
server process**. It holds the sessions: keep it writable and persistent (a volume, in a
container); losing it signs every user out. Run a single instance with it; for
several instances behind a load balancer, build with `REDIS_URL` so that they share sessions.

### Expired entries with `fs-lite`

The `fs-lite` driver ignores TTLs: it writes each entry to a file and never removes it when it
expires. Sessions, their per-user lists and revocation markers (at most 7 days, Better Auth's
default session lifetime, which `server/utils/auth.ts` does not change) and upload rate-limit
counters (one per user and window, 1 minute by default) stay on disk after they expire, so
`.data/kv` keeps growing. Reading them is harmless: Better Auth checks a session's own expiry,
and an old rate-limit window is never read again.

Redis honours the TTLs: build with `REDIS_URL` in production. With `fs-lite`, delete from a
daily cron job the files that have not been written for longer than the longest TTL:

```bash
# from the server's working directory: files last written more than 7 full days ago
find .data/kv -type f -mtime +7 -delete
find .data/kv -mindepth 1 -type d -empty -delete
```

Every entry is rewritten with a TTL of at most 7 days, so a file older than that has expired;
`-mtime +7` only matches files at least 8 days old, which leaves a day of margin. Should it
still remove a live session, that user is only signed out: the database stays the source of
truth. Raise the number if you set `session.expiresIn` above 7 days or an upload window longer
than that.

### Uploads

Uploads only serve avatars today, so the defaults are narrow:

| Setting | Default | Runtime variable |
|---------|---------|------------------|
| `maxFileSize` | 5 MB (5242880 bytes) | `NUXT_FILE_MANAGER_MAX_FILE_SIZE` (bytes) |
| `allowedMimeTypes` | `image/png, image/jpeg, image/webp, image/gif` | `NUXT_FILE_MANAGER_ALLOWED_MIME_TYPES` (comma-separated) |

- A request without a numeric `Content-Length`, or sent chunked, gets `411`; a declared length
  above the limit gets `413`, before the body is read.
- The type is detected from the file's leading bytes and must match the declared type. SVG, HTML,
  XML, scripts and executables are always refused, even when listed. `application/pdf` is the only
  detected type outside the default list; add it to the list to accept PDFs.
- Files are stored as `yyyy-MM-dd/<uuidv7>.<extension>`, the extension coming from the detected
  type. The client's filename is only kept as display metadata.

Every stored file is served with its detected type. PNG, JPEG, WebP and GIF are served
`inline`; anything else gets `Content-Disposition: attachment`.

- **Local storage** (`NUXT_APP_STORAGE=local`): the app serves the upload directory under
  `NUXT_LOCAL_PUBLIC_PATH` (`/uploads` by default) itself, reading the files at request time, with
  `X-Content-Type-Options: nosniff` on every response. A file whose extension is not a detected
  type, such as one stored before these rules, is served as `application/octet-stream`, as an
  attachment. The public path is fixed at build time: the serving route is registered from
  `NUXT_LOCAL_PUBLIC_PATH` during the build, so setting
  `NUXT_FILE_MANAGER_STORAGE_LOCAL_PUBLIC_PATH` at runtime would only change the URLs the app
  hands out, not the route that serves them. Rebuild to change it.
- Local uploads are public: the route serves any stored file to anyone holding its URL, without a
  session. The only thing keeping a URL from being guessed is the random part of its UUIDv7 name.
  Do not store files there that must stay private.
- **S3 / R2**: each object is stored with its `Content-Type` and `Content-Disposition`, which the
  bucket returns as is. A bucket cannot store `X-Content-Type-Options`: add it in front of the
  bucket's public URL (a CDN response header rule, for instance).
- Objects stored in S3 or R2 before these rules keep the `Content-Type` the client sent, and no
  `Content-Disposition`. To bring them in line, copy each object onto itself with replaced metadata
  (for instance `aws s3 cp s3://<bucket>/<key> s3://<bucket>/<key> --metadata-directive REPLACE
  --content-type <detected type> --content-disposition <inline|attachment>`), or override
  `Content-Type`, `Content-Disposition` and `X-Content-Type-Options` with CDN response header rules
  for the old keys.

Serve user content from a separate origin when you can: a dedicated domain for the bucket's public
URL (`NUXT_CF_R2_PUBLIC_URL`, `NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL`), or a CDN in front of it.
A file served from the app's own origin shares its cookies and its origin; the headers above
are the only protection left there.

### Upload rate limit

When `uploadRateLimit` is configured, each user may upload at most `maxUploadsPerWindow` files per
**fixed window** of `windowSizeMinutes`. Windows start at multiples of the window size; the counter
of a window expires when the window ends, and later uploads in the same window never push that
expiry back. If the backend fails, uploads are refused (fail closed).

How strictly the limit holds depends on the backend:

| Backend | Guarantee |
|---------|-----------|
| Redis (`REDIS_URL`, or a `rediss://` `KV_URL`, in the **run** environment) | Atomic across all instances (one Lua script per upload) |
| `fs-lite` or any other non-Redis KV | Exact on a single instance only (per-process lock); several instances can each accept up to the limit |
| Cloudflare KV | Best effort: the store is eventually consistent, so concurrent requests can exceed the limit |

The limiter reads `REDIS_URL` / `KV_URL` from the environment **at run time**, while NuxtHub bakes
the KV URL into the build. Set `REDIS_URL` in the run environment too, not only for the build;
without it the limiter falls back to the per-process lock. With an Upstash REST configuration
(`KV_REST_API_*` or `UPSTASH_REDIS_REST_*`), the limiter is not atomic across instances unless
`REDIS_URL` is also set.

---

## 3. Build

```bash
NUXT_NITRO_PRESET=node-server pnpm build
```

Most settings are read from the environment (or `.env`) while `pnpm build` runs and stored in
`.output`, so build with the same values you run with. See [`.env.example`](../.env.example) for
the full list; the main ones are `NUXT_APP_URL`, `NUXT_APP_NAME`, `NUXT_BETTER_AUTH_SECRET`,
`DATABASE_URL`, `NUXT_RESEND_API_KEY`, the `NUXT_STRIPE_*` keys and the OAuth client IDs.

`DATABASE_URL` is optional at build time. `nuxt.config.ts` pins NuxtHub's database driver to
`postgres-js` and sets `applyMigrationsDuringBuild` only when `DATABASE_URL` (or `POSTGRES_URL` /
`POSTGRESQL_URL`) is set, so the build no longer falls back to PGlite:

- with it, the build applies the pending migrations to that database (see
  [Database migrations](#1-database-migrations)) and writes the URL into `.output` as the default
  `databaseUrl`;
- without it, the build succeeds and touches no database. Apply the migrations with
  `npx nuxt db migrate`, which reads `POSTGRES_URL`, `POSTGRESQL_URL` or `DATABASE_URL` (not
  `NUXT_DATABASE_URL`), and give the server its database with `NUXT_DATABASE_URL` when it starts.

---

## 4. Run

The build output is self-contained: copy `.output/` to the server and start it with Node.js.

```bash
PORT=3000 node .output/server/index.mjs   # or: pnpm serve
```

Nuxt also reads runtime overrides when the server starts: every `runtimeConfig` key can be
replaced by `NUXT_` followed by its path in upper snake case, and public keys by `NUXT_PUBLIC_`.
For example:

| `runtimeConfig` key | Runtime variable |
|---------------------|------------------|
| `databaseUrl` | `NUXT_DATABASE_URL` |
| `databaseConnectTimeoutMs` | `NUXT_DATABASE_CONNECT_TIMEOUT_MS` (default `10000`: a connection to PostgreSQL that takes longer fails instead of hanging; `create-admin.ts` reads it too) |
| `betterAuthSecret` | `NUXT_BETTER_AUTH_SECRET` |
| `resendApiKey` | `NUXT_RESEND_API_KEY` |
| `public.appName` | `NUXT_PUBLIC_APP_NAME` |

Some names differ from the ones read at build time (`NUXT_APP_URL` at build becomes
`NUXT_PUBLIC_BASE_URL` at runtime, `NUXT_GH_CLIENT_ID` becomes `NUXT_GITHUB_CLIENT_ID`), and a few
values are only read at build time. Making every setting configurable at runtime is tracked in
[#10](https://github.com/HouseOfBetterAuth/nuxt-better-auth-saas/issues/10); this section will
be updated once it lands.

Resend and Stripe are optional: the server starts without `NUXT_RESEND_API_KEY` and without
`NUXT_STRIPE_SECRET_KEY`. Their clients are only created when a key is set (see
[Supported configurations](#supported-configurations) for what is disabled without them).

`GET /api/health` is public and answers `{ "status": "ok" }` once `select 1` succeeds on the
configured database. It answers `503` with `{ "status": "error" }` when no database is configured,
when the query fails, or when it does not answer within 2 seconds, and logs the cause on the server
only. Use it as the readiness probe of a load balancer or a container.

### Access logs

The server writes one line per request once the response is sent: timestamp, level, method, path,
status, duration and request id. A request whose client disconnects before the response completes
is still logged once, with status `499`. The path is cut at the first `?` or `#` and logged as received,
still percent-encoded, so query strings and fragments, which can carry reset tokens or OAuth codes,
never reach the log. A secret carried in the path itself, such as the token of a password reset
link (`/api/auth/reset-password/:token`), is replaced with a placeholder named after the route
parameter. Headers and bodies are never logged.

Each response carries an `x-request-id` header. An inbound `x-request-id` made of 1 to 128
characters among `A-Z a-z 0-9 . _ : -` is kept, so a proxy can correlate its own logs; any other
value is replaced by a generated UUID.

| Variable | Values | Default |
|----------|--------|---------|
| `NUXT_LOG_LEVEL` | `debug`, `info`, `warn`, `error`: minimum level written. `4xx` responses are `warn`, `5xx` are `error`, the rest `info`. | `info` |
| `NUXT_LOG_FORMAT` | `text`, or `json` for one JSON object per line | `text` |

Both are read when the server starts; an empty or unknown value falls back to the default. `info`
and `debug` lines go to standard output, `warn` and `error` lines to standard error.

### Reverse proxy

Set the public URL explicitly: `NUXT_APP_URL` at build time, or `NUXT_PUBLIC_BASE_URL` when the
server starts. The server passes it to Better Auth as `baseURL` and adds it to the trusted origins
(`server/utils/auth.ts`), and builds the links of emails and of the Stripe portal from it. When it
is empty, Better Auth (1.4.1) falls back to the first of these environment variables that is set:
`BETTER_AUTH_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL`, `PUBLIC_BETTER_AUTH_URL`,
`NUXT_PUBLIC_BETTER_AUTH_URL`, `NUXT_PUBLIC_AUTH_URL`, then `BASE_URL` (unless it is `/`). A
generic `BASE_URL` set by your host or platform is picked up as the auth URL this way. Without
any of them, it uses the `X-Forwarded-Proto` and `X-Forwarded-Host` headers of a request, only
when both are present, then that request's URL, and keeps the first value it derives for the life
of the process.

During server-side rendering, the auth client of the pages never calls the request's origin: it
dispatches each request to `/api/auth/*` inside the server process (Nitro's `event.fetch`) with
only its path and query, so a manipulated `Host` header cannot send it to another server. In the
browser it calls the page's own origin.

Nitro (h3 1.15) derives the origin of a request with `getRequestURL`: the host comes from the
`Host` header, and `X-Forwarded-Host` is read only when a caller passes `xForwardedHost: true`
(off by default). The protocol is `https` when `X-Forwarded-Proto` is `https`, unless a caller
passes `xForwardedProto: false`. Nuxt's `useRequestURL()` uses these defaults.

Only trust `X-Forwarded-*` headers set by your own proxy:

- do not expose the Node port directly; let only the proxy reach it;
- have the proxy overwrite `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For` with its
  own values rather than append to what the client sent (the server records `X-Forwarded-For`
  as received as the IP address of auth events);
- forward only the public hostname in `Host`, and reject requests for other hosts.

### Supported configurations

| Configuration | What works | What is disabled |
|---------------|-----------|------------------|
| No database URL at build time | The build succeeds. | No migration is applied by the build: run `npx nuxt db migrate` with `DATABASE_URL` set, and set `NUXT_DATABASE_URL` when the server starts. Without a database at runtime, `GET /api/health` answers `503`. |
| No `NUXT_STRIPE_SECRET_KEY` | The server starts and email/password sign-in works. | The better-auth Stripe plugin is not registered. Billing routes under `/api/stripe/` that call Stripe answer `503 Billing is not configured`. |
| No `NUXT_RESEND_API_KEY` | The server starts; email/password sign-in works for verified accounts, such as the one `create-admin.ts` creates. | No email is sent. A new email/password account cannot be verified, so its sign-in is refused (`requireEmailVerification`); under `pnpm dev` the verification link is printed to the server log instead. A password reset request still answers success, but no email leaves and the failure is only logged. Account deletion and organization invitation emails are not sent. |

---

## 5. Create an admin user

`create-admin.ts` signs up a user with email and password, marks the email as verified and gives it
the `admin` role. It reads `DATABASE_URL` (or `NUXT_DATABASE_URL`), `NUXT_ADMIN_EMAIL` and
`NUXT_ADMIN_PASSWORD`, from the environment or `.env`. Run it once the migrations are applied:

```bash
node create-admin.ts        # Node.js 26 runs TypeScript directly
```

Running it again for an existing email only sets the role and the verified flag. It exits with code
1 and prints what to fix when a variable is missing or the database cannot be reached.

---

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, with throwaway
values only (no repository secret):

| Job | What it checks |
|-----|----------------|
| `lint` | `pnpm lint --max-warnings=0` |
| `typecheck` | `pnpm typecheck` (`nuxt typecheck`), which must report no error |
| `unit` | `pnpm test:ci`: unit tests (`tests/unit`) and component tests in the Nuxt runtime (`tests/components`); the e2e suite (`tests/e2e`) runs locally with `pnpm test` |
| `smoke-build-without-db` | `NUXT_NITRO_PRESET=node-server pnpm build` without a database, Redis, Stripe or Resend, then against a `postgres:16` service: `pnpm exec nuxt db migrate` with `DATABASE_URL`, starts `.output/server/index.mjs` with `NUXT_DATABASE_URL` and `NUXT_PUBLIC_BASE_URL`, waits for `GET /api/health`, seeds an admin with `create-admin.ts` and signs in with it. The server log and the sign-in responses are uploaded as an artifact when the job fails. |
| `smoke-node` | Against `postgres:16` and `redis:7` services: `pnpm db:generate`, `pnpm build` (which applies the migrations), starts `.output/server/index.mjs`, waits for `GET /api/health`, resets the database to the demo seed (`pnpm demo:reset` with `DEMO_RESET_CONFIRM=localhost`), seeds an admin with `create-admin.ts` and expects `POST /api/auth/sign-in/email` to answer `200` with a `better-auth.session_token` cookie. It then runs `pnpm demo:reset` a second time, which proves the reset is idempotent over a seeded database, and signs in the same way as `demo@example.com`. The server log and the sign-in responses are uploaded as an artifact when the job fails. |
