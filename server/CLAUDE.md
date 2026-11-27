# server/

- Routes: `server/api/**/<name>.<method>.ts`, `[param].<method>.ts`. h3 helpers (`defineEventHandler`,
  `readBody`, `getQuery`, `getRouterParam`, `createError`) stay auto-imported; project helpers are
  imported explicitly from `~~/server/utils/<name>` — unit tests `vi.mock` those exact paths.
- Auth first, before reading input (anonymous → 401, not 400):
  `requireAuthSession(event)` (`utils/billing.ts`, cached per event) or `requireAuth(event)` (`utils/auth.ts`);
  `getAuthSession(event)` returns null instead of throwing.
- Organization access: `requireOrganizationRole(event, orgId, roles?)` (`utils/billing.ts`) — same 403 for
  non-members and wrong roles; `requireOrganizationPermission(event, orgId, { apiKey: ['read'] })`
  asks the `ac` grants of `shared/utils/permissions.ts` instead (what better-auth's own endpoints
  check, so API key routes use it); wrapper `requireOwnedSubscription` (`utils/billing.ts`). Map 403 to 404
  when the resource's existence must not leak (`api/organization/api-keys/[id].delete.ts`).
- `/api/admin*` is guarded once by `middleware/1.auth.ts` (admin role); admin routes add no check.
- DB: `const db = await useDB()` in routes — tables from `~~/server/db/schema`, Drizzle
  `db.query.<table>.findFirst` with `eq`/`and`. `getDB()` (sync) only outside routes (auth hooks, audit);
  it is built without schema: query builder only, no `db.query.*` (#22).
- Errors: `throw createError({ statusCode, statusMessage })` — keep these names: h3 1.x derives
  `message` from `statusMessage`, not `statusText` (migration in #50); reusable ones as factories
  (`const keyNotFound = () => createError(...)`).
- Validation: zod via `getValidatedQuery(event, schema.parse)` in admin routes (`utils/query.ts` filters);
  other routes check fields by hand → 400.
- Optional services: `isStripeConfigured()` / `createStripeClient()` (503 "Billing is not configured").
- Audit: `logAuditEvent({ userId, category, action, targetType, targetId, status, details })`
  (`utils/auditLogger.ts`, never throws). Access logs are automatic (`middleware/0.common.ts`,
  `plugins/accessLog.ts`); routes use `console.error` for errors.
