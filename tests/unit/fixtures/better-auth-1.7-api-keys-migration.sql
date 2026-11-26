-- SPDX-License-Identifier: MIT
--
-- The API key statements of the 1.4 -> 1.7 migration an operator applies
-- (README, Upgrading from better-auth 1.4): what `pnpm db:generate` writes for
-- api_key when answered "create table", with the copy of step 1 added before
-- the generated DROP TABLE "apiKey" CASCADE. That CASCADE also drops the
-- foreign key of api_key_organization to "apiKey", when the table exists.
-- api_key DDL taken from server/db/schema/auth.ts at 0042dd0.
-- The link table statements follow in
-- better-auth-1.7-api-key-organization-relink.sql (1.4 deployment with a
-- link table) or better-auth-1.7-api-key-organization-create.sql (without).
CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);--> statement-breakpoint
INSERT INTO "api_key" ("id", "name", "start", "reference_id", "prefix", "key", "refill_interval", "refill_amount", "last_refill_at", "enabled", "rate_limit_enabled", "rate_limit_time_window", "rate_limit_max", "request_count", "remaining", "last_request", "expires_at", "created_at", "updated_at", "permissions", "metadata")
SELECT "id", "name", "start", "user_id", "prefix", "key", "refill_interval", "refill_amount", "last_refill_at", "enabled", "rate_limit_enabled", "rate_limit_time_window", "rate_limit_max", "request_count", "remaining", "last_request", "expires_at", "created_at", "updated_at", "permissions", "metadata" FROM "apiKey";--> statement-breakpoint
ALTER TABLE "apiKey" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "apiKey" CASCADE;--> statement-breakpoint
CREATE INDEX "apiKey_configId_idx" ON "api_key" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apiKey_referenceId_idx" ON "api_key" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "apiKey_key_idx" ON "api_key" USING btree ("key");
