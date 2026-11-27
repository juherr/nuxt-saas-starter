-- SPDX-License-Identifier: MIT
--
-- The 1.4 -> 1.7 migration `pnpm db:generate` writes on top of
-- drizzle-kit-better-auth-1.4-schema.sql (README, Upgrading from
-- better-auth 1.4): the output of `drizzle-kit generate` (drizzle-kit
-- 0.31.11, postgresql dialect) from the snapshot of server/db/schema at
-- 0042dd0^ (8335797) to server/db/schema at 5693557 (last schema change
-- 08c2b3e). Interactive answers: api_key -> "create table", rate_limit ->
-- "create table". It is not applicable as generated: the tests apply the
-- README edits to it. Below this header, the file is the generated output,
-- byte for byte.
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
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "apiKey" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "apiKey" CASCADE;--> statement-breakpoint
ALTER TABLE "api_key_organization" DROP CONSTRAINT "api_key_organization_api_key_id_apiKey_id_fk";
--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "cancel_at" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "canceled_at" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "ended_at" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "billing_interval" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "stripe_schedule_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
CREATE INDEX "apiKey_configId_idx" ON "api_key" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apiKey_referenceId_idx" ON "api_key" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "apiKey_key_idx" ON "api_key" USING btree ("key");--> statement-breakpoint
ALTER TABLE "api_key_organization" ADD CONSTRAINT "api_key_organization_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE cascade ON UPDATE no action;