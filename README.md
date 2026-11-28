<p align="center">
  <img src="/public/HouseOfBetterAuth.png" alt="HouseOfBetterAuth" height="80" />
  &nbsp;&nbsp;&nbsp;
  <strong style="font-size: 2em;">HouseOfBetterAuth</strong>
</p>

<p align="center">
  <em>Open-source SaaS starters powered by Better Auth</em>
</p>

<p align="center">
  We build production-ready, open-source SaaS templates using <a href="https://better-auth.com">Better Auth</a>.<br/>
  Skip the boilerplate. Ship faster.
</p>

---

## House of Better Auth Nuxt SaaS Starter

A production-ready Nuxt SaaS starter with authentication, billing, teams, and more.

> **Note:** This template is opinionated and built for my own apps. It's designed specifically for:
> - **Stripe-only billing** — Polar and other payment providers will not be supported
> - **Multi-tenant orgs** — each user can own multiple organizations, but only the first org gets a free trial
> - **No single-tenant mode** — this is not designed for single-user or personal-use SaaS apps
>
> Feel free to fork and adapt, but these constraints are intentional and won't change.

### What's Included

- [x] **Authentication** — Better Auth with email/password, OAuth (Google, GitHub), email verification
- [x] **Multi-tenant orgs** — create/switch orgs, one free trial per account
- [x] **Roles & permissions** — Owner, Admin, Member with granular access control
- [x] **Stripe billing** — subscriptions, seat-based pricing, legacy price support
- [x] **Billing previews** — see prorated charges before seat/plan changes
- [x] **Invoice history** — view and download past invoices
- [x] **Failed payment handling** — grace periods, recovery flows, warning banners
- [x] **Team invites** — invite by email, works for new and existing users
- [x] **User profiles** — avatar upload, email change, password management
- [x] **Session management** — view/revoke active sessions
- [x] **API keys** — per-org keys with expiration options
- [x] **Admin tools** — user impersonation, soft-ban
- [x] **Transactional emails** — React Email + Resend for all auth/billing events
- [x] **Timezone support** — per-org timezone settings
- [x] **Referral tracking** — track user and org referrals for attribution
- [x] **Connected accounts** — link/unlink multiple OAuth providers
- [x] **Account deletion** — secure deletion with email verification
- [ ] **More Testing** — I'm sure there are some bugs, will activtly test and make updates.
- [x] **NuxtHub self-hosted** — self-hosted deployment guide (see below)
- [ ] **Abandoned cart emails** — email users with incomplete subscription status
- [ ] **Usage-based billing** — metered billing support

<p align="center">
  <img src="/public/screenshots/home.png" alt="Homepage" width="80%" />
</p>

<p align="center">
  <img src="/public/screenshots/dashboard.png" alt="Dashboard" width="80%" />
</p>

### Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Nuxt 4 + Vue 3 + TypeScript |
| Auth | Better Auth |
| Database | PostgreSQL + Drizzle ORM + Cloudflare Hyperdrive |
| Billing | Stripe (subscriptions, seats, plan versioning) |
| Emails | React Email + Resend |

---

## Quick Start

The toolchain is installed with [mise](https://mise.jdx.dev): `mise.toml` pins Node, and pnpm is
pinned only by `packageManager` in `package.json`, run through Corepack. The commands after
`corepack enable` assume mise is [activated](https://mise.jdx.dev/getting-started.html) in your shell
(`eval "$(mise activate bash)"`, or `zsh`); otherwise prefix each with `mise exec --`. If
`mise install` asks you to trust the config on a fresh clone, run `mise trust` first.
The VS Code Vitest extension runs the `node` it finds on its `PATH`: start VS Code from a shell where
mise is activated, or set `vitest.nodeExecutable` in your user settings to the `node` shim in mise's
shims directory (`~/.local/share/mise/shims/node` by default).

```bash
mise install                             # Node from mise.toml
mise exec -- npm install -g corepack     # once: Node 26 ships no Corepack
mise exec -- corepack enable             # `pnpm` now runs the packageManager version
```

```bash
cp .env.example .env   # Fill in env vars (database, Stripe, auth, etc.)
pnpm install
pnpm run db:generate   # writes server/db/migrations (gitignored)
npx nuxt db migrate    # applies them; `pnpm dev` also does it on start
pnpm run dev -o
```

**Deploy to production:**

```bash
npx nuxthub deploy
```

### Upgrading from better-auth 1.4

The better-auth 1.7 schema changes tables that already hold data. On an existing deployment, keep
your current `server/db/migrations` folder and run `pnpm db:generate`. drizzle-kit asks how each
new table was created:

- `api_key`: choose **create table**. It replaces `apiKey`, and `user_id` becomes `reference_id`
  (plus a new `config_id`, default `'default'`). Choosing *rename table* makes drizzle-kit 0.31
  stop with `Cannot read properties of undefined (reading 'columns')`.
- `rate_limit`: choose **create table**. better-auth now keeps its rate-limit counters there.

The generated migration then ends with `DROP TABLE "apiKey" CASCADE`, which loses every API key.
**Do not apply it as generated.** Edit the new `.sql` file first:

1. Copy the keys before the line `ALTER TABLE "apiKey" DISABLE ROW LEVEL SECURITY;`:

   ```sql
   INSERT INTO "api_key" ("id", "name", "start", "reference_id", "prefix", "key", "refill_interval", "refill_amount", "last_refill_at", "enabled", "rate_limit_enabled", "rate_limit_time_window", "rate_limit_max", "request_count", "remaining", "last_request", "expires_at", "created_at", "updated_at", "permissions", "metadata")
   SELECT "id", "name", "start", "user_id", "prefix", "key", "refill_interval", "refill_amount", "last_refill_at", "enabled", "rate_limit_enabled", "rate_limit_time_window", "rate_limit_max", "request_count", "remaining", "last_request", "expires_at", "created_at", "updated_at", "permissions", "metadata" FROM "apiKey";--> statement-breakpoint
   ```

2. `subscription.status` becomes `NOT NULL`. Before the line
   `ALTER TABLE "subscription" ALTER COLUMN "status" SET NOT NULL;`, add:

   ```sql
   UPDATE "subscription" SET "status" = 'incomplete' WHERE "status" IS NULL;--> statement-breakpoint
   ```

3. If `api_key_organization` already exists (a deployment of v0.1.0 or later), delete the line:

   ```sql
   ALTER TABLE "api_key_organization" DROP CONSTRAINT "api_key_organization_api_key_id_apiKey_id_fk";
   ```

   That foreign key points at `apiKey`, and `DROP TABLE "apiKey" CASCADE` has already dropped it, so
   the statement fails with `constraint "api_key_organization_api_key_id_apiKey_id_fk" of relation
   "api_key_organization" does not exist` (SQLSTATE 42704) and stops the migration. The file then
   adds a foreign key from `api_key_organization` to `api_key`: the copy of step 1 keeps the key
   ids, so the links stay valid. A deployment from before the link table has no such line: the file
   creates the table, empty.

The copy of step 1 stays manual: the upgrade query only moves keys that are already in `api_key`.
Back up the database, and stop every instance of the previous release before you apply the
migration: a key created after the copy of step 1 is dropped with `"apiKey"`. The next section's
maintenance window covers it. Then apply the migration
(`npx nuxt db migrate`, or `pnpm build`). After it, the query of
[Upgrading to organization-owned API keys](#upgrading-to-organization-owned-api-keys) moves each
linked key to its organization. With an empty link table, every copied key still references its
creator, so the query refuses while any of them is enabled: move or delete them as that section
explains. The same migration also adds `user.stripe_customer_id` and the `subscription` columns
`cancel_at`, `canceled_at`, `ended_at`, `billing_interval` and `stripe_schedule_id`. API keys no
longer have a foreign key to `user`: an API key belongs to its organization, and deleting the
organization deletes its keys (`ON DELETE CASCADE` on the foreign key the upgrade query adds).

Single-use verification values are now written to the database as well as the KV store, and consumed
from the database. Password reset and account deletion links issued before the deploy become
invalid: their value only exists in the KV store, so a reset link still opens the form but the
submit fails with `INVALID_TOKEN`, and an account deletion link fails at once. Users have to request
a new link. Email verification and change-email links are signed tokens and keep working.

An organization whose Stripe customer has a subscription that is not canceled (active, trialing,
past due…) can no longer be deleted: the Stripe plugin refuses with
`ORGANIZATION_HAS_ACTIVE_SUBSCRIPTION`, and the settings page says so. Canceling from the billing
page keeps the subscription active until the end of the period, so deletion only works after that.
The check calls Stripe, so a Stripe outage also blocks deleting an organization that has a customer.

Google and GitHub sign-in no longer link to an existing email/password account whose email is not
verified (`account.accountLinking.requireLocalEmailVerified`, default `true`). The OAuth callback
sends the user back to the sign-in page with `?error=account_not_linked`, which explains it: the
user signs in with their password and verifies their email first. Setting the option to `false`
restores the old behaviour and lets whoever registered an unverified account at someone else's
address receive that person's OAuth sign-in; better-auth deprecates the option and plans to make the
check unconditional.

### Upgrading to organization-owned API keys

API keys now belong to an organization natively: `api_key.reference_id` holds the organization's
id. Clients create a key with a top-level `organizationId` instead of `metadata.organizationId`. A
key now survives the user who created it, and is deleted with its organization by the foreign key
described below, even when the organization row is deleted directly in SQL.

The upgrade runs without SQL by hand, but it needs a short maintenance window. Once it has run, an
instance of the previous release cannot create a key (the foreign key refuses the creator's user id
it writes as `reference_id`), does not list the keys created by the new release, and cannot revoke
them. Rolling the app back to the previous release does not bring the old behaviour back: the keys
stay moved and the foreign key stays. So:

1. back up the database;
2. stop every instance of the previous release;
3. build and migrate (below);
4. start the new release.

NuxtHub runs `server/db/queries/api-key-organization-owner.postgresql.sql` after all migrations, on
every `pnpm build` with `DATABASE_URL` set, every `npx nuxt db migrate` and every `pnpm dev` start.
It is a single statement, so it either applies in full or changes nothing. It:

1. locks `api_key` against writes, waiting at most 5 seconds for the lock;
2. moves every key listed in `api_key_organization` to its organization (`reference_id`), with its
   key material unchanged, so clients keep using the same key;
3. deletes the keys that belong to no organization and are disabled (`enabled = false`);
4. refuses while any other key belongs to no organization (see below);
5. adds the foreign key `api_key_reference_id_organization_id_fk`
   (`api_key.reference_id` → `organization.id`, `ON DELETE CASCADE`) if it is missing.

Once the foreign key exists, the query returns at once, without taking the lock, so running it on
every build is harmless. If another session holds a lock on `api_key` for more than 5 seconds (an
instance of the previous release still running, an open transaction), the query gives up with
`canceling statement due to lock timeout` (SQLSTATE 55P03) and changes nothing: stop that session
and run it again.

**The app is not ready until the query has run.** `GET /api/health` answers `503` while the foreign
key is missing, and logs the cause on the server. Nothing else stops the app from serving without
it, and then deleting an organization leaves its keys behind. Two setups never run the query on
their own:

- a Cloudflare build has no `DATABASE_URL`, so it applies neither the migrations nor the query: run
  `npx nuxt db migrate` with `DATABASE_URL` set against the production database, before or right
  after the deploy (the demo runs it in its `reset` job, before deploying,
  [docs/DEMO_DEPLOYMENT.md](docs/DEMO_DEPLOYMENT.md));
- `pnpm dev` only logs a failure of the query and keeps running.

**When the query refuses**, the build (`pnpm build`) and `npx nuxt db migrate` stop with a non-zero
exit code, and `pnpm dev` only logs the error and keeps running. The refusal rolls the whole upgrade
back: no key has moved, no disabled key is deleted, and the foreign key is not added. The message
gives the number of keys that block it and the SQL that lists exactly them, the enabled keys that
belong to no organization and are not linked in `api_key_organization`:

```sql
SELECT k.id, k.reference_id FROM api_key k WHERE k.enabled IS DISTINCT FROM false AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = k.reference_id) AND NOT EXISTS (SELECT 1 FROM api_key_organization l WHERE l.api_key_id = k.id)
```

Those keys were never linked to an organization, so no one could already list or revoke them before
this release. The linked keys and the disabled ones are not listed: the query moves the first and
deletes the second. For each listed key, either delete it (an owner or admin of the organization
recreates it if it is still needed):

```sql
DELETE FROM "api_key" WHERE "id" = '<key id>';
```

or move it to its organization:

```sql
UPDATE "api_key" SET "reference_id" = '<organization id>' WHERE "id" = '<key id>';
```

(inserting the pair into `api_key_organization` works too: the query moves it). Then run the build
or `npx nuxt db migrate` again.

The foreign key is created by this query, not by drizzle-kit: better-auth's API key schema option
only renames fields, and `pnpm auth:schema` regenerates `server/db/schema/auth.ts`, so the
constraint cannot be declared there. It is not in the drizzle snapshots, and `pnpm db:generate`
never touches it.

`api_key_organization` stays in the Drizzle schema, deprecated and no longer read or written by the
app, so that `pnpm db:generate` emits no `DROP TABLE` before the query has moved the keys. A later
release removes it ([#162](https://github.com/juherr/nuxt-saas-starter/issues/162)): upgrade
every deployment through this release first.

### Environment Variables

**Important:** Set `NUXT_APP_URL` to your production URL for Better Auth to work correctly.

```bash
# .env
NUXT_APP_URL=https://yourdomain.com
```

This URL is used by Better Auth for:
- OAuth callback URLs
- Email verification links
- Password reset links
- CORS origin validation

The origin is configured in `server/utils/auth.ts`:

```typescript
export const createBetterAuth = () => betterAuth({
  baseURL: runtimeConfig.public.baseURL,
  trustedOrigins: [
    'http://localhost:8787',
    'http://localhost:3000',
    // ... other local origins
    runtimeConfig.public.baseURL  // Your production URL
  ],
  // ...
})
```

Your `NUXT_APP_URL` is automatically added to `trustedOrigins` via `runtimeConfig.public.baseURL`.

### Version

The footer and the dashboard sidebar show the version of the build, resolved
from git when the app is built: the tag pointing at the built commit (e.g.
`v1.2.0`), otherwise `dev-<short sha>`, or `dev` without git. Set
`NUXT_PUBLIC_APP_VERSION` at build or at server start to override it, e.g.
when building from a source tree without `.git`. A shallow CI checkout
fetches no tags: a release build needs `fetch-tags: true` on
`actions/checkout`, or `NUXT_PUBLIC_APP_VERSION=${{ github.ref_name }}`.

### Recommended Hosting

**Recommended stack:**
- **Cloudflare Workers** — serverless hosting via [NuxHub](https://hub.nuxt.com)
- **Neon Postgres** — serverless PostgreSQL database
- **Cloudflare Hyperdrive** — connection pooling for Postgres

**Caching:**
- **Cloudflare KV** — no Redis needed when hosting on Cloudflare (used for session caching)
- **Node.js** — Redis is optional: sessions go through NuxtHub KV, which uses Redis only when `REDIS_URL` is set at build time, and otherwise stores them under `.data/kv` (keep that directory persistent)

The app automatically uses Cloudflare KV when deployed to Cloudflare Workers. No additional configuration needed.

To run on Node.js (migrations, sessions, build, runtime variables, admin user), see [docs/SELF_HOSTING_NODE.md](docs/SELF_HOSTING_NODE.md).

The public demo on the Cloudflare free plan, deployed from `main` and reset every night, is described in [docs/DEMO_DEPLOYMENT.md](docs/DEMO_DEPLOYMENT.md).

---

<details>
<summary><h2>🚀 NuxtHub Self-Hosted Deployment</h2></summary>

This project supports **self-hosted Cloudflare Workers** deployment instead of using NuxtHub Admin. This gives you full control over your infrastructure.

### Prerequisites

- Cloudflare account with Workers enabled
- PostgreSQL database (e.g., Neon, Supabase)
- Cloudflare resources:
  - **KV Namespace** — for caching
  - **R2 Bucket** — for file storage
  - **Hyperdrive** — for PostgreSQL connection pooling

### Quick Setup

#### 1. Create Wrangler Config

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Edit `wrangler.jsonc` with your resource IDs:

```jsonc
{
    "name": "your-worker-name",  // ⚠️ Must match your Cloudflare Worker name
    "kv_namespaces": [{ "binding": "KV", "id": "<your-kv-id>" }],
    "r2_buckets": [{ "binding": "BLOB", "bucket_name": "<your-bucket>" }],
    "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<your-hyperdrive-id>" }]
}
```

#### 2. Get Resource IDs

```bash
npx wrangler kv namespace list
npx wrangler r2 bucket list
npx wrangler hyperdrive list
```

#### 3. Environment Variables

> **Important:** `DATABASE_URL` replaces the old `NUXT_DATABASE_URL`

```bash
# .env
DATABASE_URL=postgres://user:password@host:5432/database
NUXT_NITRO_PRESET=cloudflare-module
```

#### 4. Mark Existing Migrations

If your database already has tables, mark migrations as applied:

```bash
npx nuxt db mark-as-migrated 0000_your_migration_name
```

#### 5. Build & Deploy

```bash
pnpm build
npx wrangler deploy
```

### How It Works

| Environment | Database | Cache |
|-------------|----------|-------|
| Cloudflare Workers | Hyperdrive | KV |
| Node.js hosting | `DATABASE_URL` | NuxtHub KV: Redis if `REDIS_URL` is set at build, else `.data/kv` |

### Full Documentation

See [docs/NUXTHUB_SELF_HOSTED.md](docs/NUXTHUB_SELF_HOSTED.md) for complete setup guide.

See [docs/MIGRATION_CHECKLIST.md](docs/MIGRATION_CHECKLIST.md) for migration checklist when syncing with your own app.

</details>

---

## Features

### Billing & Subscriptions

- **Stripe-powered billing** with monthly/yearly Pro plans
- **Legacy pricing support** — existing subscribers stay on their original price forever
- **Seat-based pricing** — base plan includes 1 seat, extra members cost per-seat
- **Detailed previews** before any billing change (seat changes, plan switches, trial conversions)
- **Invoice history** with pagination and PDF downloads
- **Declined card handling** with graceful recovery flows
- **Grace period support** for failed payments before auto-cancellation

#### Stripe Subscription Status Flow

| Status | When | What Happens |
|--------|------|--------------|
| `incomplete` | User opens Stripe Checkout but doesn't complete payment | Waiting for initial payment — use for retargeting abandoned checkouts |
| `trialing` | User starts a free trial | Full access during trial period |
| `active` | Payment succeeds (after trial or direct subscribe) | Full access, billing active |
| `past_due` | Payment fails on renewal | Grace period — user sees warning banners, can update payment method |
| `canceled` | Grace period ends or user canceled and billing cycle current date is past the billing cycle end date | Stripe sends webhook, access revoked, excess team members removed |

**How it works:**
1. When a payment fails, Stripe sets `status = "past_due"` and retries automatically
2. During the grace period (configured in Stripe Dashboard), users see warning banners and can update their payment method
3. If payment isn't resolved, Stripe sends a webhook after the grace period and sets `status = "canceled"`
4. On cancellation, the app downgrades the org to free tier and removes excess team members


#### Stripe Webhook Setup

**Webhook endpoint:** `https://yourdomain.com/api/auth/stripe/webhook`

Enable these webhooks in your Stripe Dashboard:

| Event | Purpose |
|-------|---------|
| `checkout.session.completed` | Handle completed checkout sessions |
| `customer.created` | Track new Stripe customers |
| `customer.subscription.created` | New subscription created |
| `customer.subscription.deleted` | Subscription ended/canceled |
| `customer.subscription.trial_will_end` | Trial ending soon (3 days before) |
| `customer.subscription.updated` | Plan changes, status updates |
| `invoice.payment_failed` | Payment declined |
| `invoice.payment_succeeded` | Payment successful |
| `payment_intent.payment_failed` | Payment method or payment attempt failed |

**API version:** create the webhook endpoint with the API version the
server's Stripe client is pinned to: `Stripe.API_VERSION` from the
`stripe` package (`2026-10-28.endive` with `stripe` 23.1.0), set in
`server/utils/stripe.ts`. Stripe renders event payloads in the
endpoint's API version, not in the client's
([Webhook versioning](https://docs.stripe.com/webhooks/versioning)), so
an endpoint on another version sends objects shaped differently from
the ones the code expects. Check it again whenever `stripe` is bumped
(Dependabot opens those pull requests): print the new value with
`node -p "require('stripe').API_VERSION"`. An endpoint's API version is
set when it is created and cannot be updated, so create a new endpoint
on that version, set `NUXT_STRIPE_WEBHOOK_SECRET` to its signing secret,
then disable the old endpoint.

<p align="center">
  <img src="/public/screenshots/subscription.png" alt="Subscription Management" width="70%" />
</p>

<details>
<summary>More billing screenshots</summary>

![Trial to Paid Seat Preview](/public/screenshots/trial-to-2-seats-preview.png)
![Invoice History](/public/screenshots/invoices-1.png)
![Seat Change Preview](/public/screenshots/billing-invite-seat-preview.png)
![Failed Payment UI](/public/screenshots/failed-payment-upgrade-ui.png)

</details>

---

### Organizations & Teams

- **Multi-org support** — each org requires its own subscription
- **14-day free trial** on first org, no trial on subsequent orgs
- **Role-based access** — Owner, Admin, Member with granular permissions
- **Invite system** — works for both new and existing users
- **Timezone per org** — billing dates and timestamps display correctly

<p align="center">
  <img src="/public/screenshots/org-settings-with-timezones.png" alt="Org Settings" width="70%" />
</p>

<details>
<summary>More org screenshots</summary>

![Create New Org](/public/screenshots/org-switcher-create-new-org.png)
![One Free Org Per Account](/public/screenshots/org-switcher-one-free-org-per%20account-1.png)
![Invite Members Step 1](/public/screenshots/invite-members-1.png)
![Invite Members Step 2](/public/screenshots/invite-members-2.png)
![Invite Members Step 3](/public/screenshots/invite-members-3.png)

</details>

---

### User Management

- **Profile settings** — avatar upload, email change, password management
- **Connected accounts** — link/unlink OAuth providers (Google, GitHub)
- **Session management** — view and revoke active sessions
- **Account deletion** with email verification
- **Stripe sync** — email/name changes automatically update Stripe customer

<p align="center">
  <img src="/public/screenshots/profile-settings-change-email-password-sessions-connected-accounts.png" alt="Profile Settings" width="70%" />
</p>

---

### Admin Tools

- **User impersonation** for support
- **Soft-ban / restrict** abusive accounts
- **API keys** — per-user or per-org with expiration options

<details>
<summary>Admin screenshots</summary>

![Impersonate User Step 1](/public/screenshots/Impersonate-1.png)
![Impersonate User Step 2](/public/screenshots/Impersonate-2.png)
![Pro Badge](/public/screenshots/pro-badge.png)
![Admin Users Panel](/public/screenshots/users.webp)
![API Key Creation](/public/screenshots/org-settings-api-key-1.png)
![API Key Created](/public/screenshots/org-settings-apit-key-2.png)

</details>

---

### Transactional Emails

Built with React Email + Resend.

| Email | Trigger |
|-------|---------|
| Verify Email | Sign up or email change |
| Reset Password | Forgot password request |
| Delete Account | Account deletion request |
| Team Invite | User invited to org |
| Trial Started | Free trial begins |
| Subscription Confirmed | Trial ends successfully or direct subscribe |
| Subscription Updated | Seat or plan changes |
| Payment Failed | Card declined |
| Subscription Canceled/Expired | Downgrade or grace period ends |

<details>
<summary>Email screenshots</summary>

![Add Seats Email](/public/screenshots/email-add-seats-confirmation.png)
![Monthly to Yearly Email](/public/screenshots/email-monthly-to-yearly-confirmation.png)
![Failed Payment Email](/public/screenshots/failed-payment-email-react-email-resend.png)

</details>

---

### Authentication

<p align="center">
  <img src="/public/screenshots/signin.png" alt="Sign In" width="45%" />
  <img src="/public/screenshots/pricing.png" alt="Pricing" width="45%" />
</p>

---

## Configuring Plans

Plans are defined in `shared/utils/plans.ts` — the single source of truth for pricing, features, and Stripe price IDs.

```typescript
export const PLANS = {
  PRO_MONTHLY: {
    id: 'pro-monthly-v2',
    priceId: 'price_yyy',        // Your Stripe Price ID
    key: 'pro',
    interval: 'month',
    label: 'Monthly',
    priceNumber: 11.99,
    seatPriceNumber: 5.99,
    trialDays: 14,
    features: ['Feature 1', 'Feature 2']
  },
  PRO_YEARLY: {
    id: 'pro-yearly-v2',
    priceId: 'price_zzz',
    key: 'pro',
    interval: 'year',
    label: 'Yearly',
    priceNumber: 99.99,
    seatPriceNumber: 44.44,
    description: 'Save ~45%',
    trialDays: 14,
    features: ['Feature 1', 'Feature 2']
  }
}
```

**Helper functions:**

```typescript
import { findPlanById, findPlanByPriceId, normalizePlanId } from '~~/shared/utils/plans'

findPlanById('pro-monthly-v2')
findPlanByPriceId('price_xxx')
normalizePlanId('pro-monthly-v2-no-trial') // → 'pro-monthly-v2'
```

### Legacy Pricing

Keep old plan entries in the file — existing subscribers are matched by `priceId` and stay on their original pricing. If they cancel and re-subscribe, they get current pricing.

---

## Reusable Components

**Billing:**
- `usePaymentStatus()` — check `isPaymentFailed`, `hasUsedTrial`, `activeSub`
- `<BillingPaymentFailedBanner />` — global warning banner
- `<BillingPaymentFailedCard />` — action card with payment update buttons

**Settings:**
- `<SettingsGeneralSection />` — org name, slug, timezone
- `<SettingsApiKeysSection />` — API key management
- `<SettingsSessionsSection />` — active sessions
- `<SettingsDangerZone />` — leave/delete org

**Members:**
- `<MembersInviteForm />` — invite with seat limit checking
- `useTimezone()` — timezone list and formatting

---

## Acknowledgments

This project is a fork of [nuxt-better-auth-saas](https://github.com/HouseOfBetterAuth/nuxt-better-auth-saas)
by HouseOfBetterAuth, itself built on NuxSaaS by the NuxSaaS team, whose repository is no longer
online. Thank you for the foundation!

If this starter saves you time, you can [sponsor its maintenance](https://github.com/sponsors/juherr).

---

## License

MIT. See [LICENSE](LICENSE).

The project follows the [REUSE](https://reuse.software) specification, checked by the `reuse` CI
job (`reuse lint` locally). Start every new source file with an SPDX header, as its first comment
(after the shebang, if any):

<!-- REUSE-IgnoreStart -->
| Files | Header |
|---|---|
| `.ts`, `.tsx`, `.mjs`, `.jsonc` | `// SPDX-License-Identifier: MIT` |
| `.vue` | `<!-- SPDX-License-Identifier: MIT -->` |
| `.css` | `/* SPDX-License-Identifier: MIT */` |
| `.yml`, `.yaml`, shell scripts | `# SPDX-License-Identifier: MIT` |

Copyright is declared once in [`REUSE.toml`](REUSE.toml). Files that cannot hold a comment (images,
JSON, Markdown) or that are generated (`server/db/schema/auth.ts`) are licensed there too: add a
path to its second table rather than a sidecar `.license` file.
<!-- REUSE-IgnoreEnd -->

---

<p align="center">
  <em>Built by <a href="https://github.com/HouseOfBetterAuth">HouseOfBetterAuth</a></em>
</p>
