-- SPDX-License-Identifier: MIT
--
-- Hand-written: the link table statements drizzle-kit writes in the 1.4 ->
-- 1.7 migration of a 1.4 deployment that predates api_key_organization. It
-- creates the link table, empty (server/db/schema/apiKeyOrganization.ts,
-- kept until #162). drizzle-kit-better-auth-1.4-to-1.7-migration.sql was
-- generated from a 1.4 schema that has the table, so it holds a
-- DROP CONSTRAINT and an ADD CONSTRAINT on it instead.
CREATE TABLE "api_key_organization" (
	"api_key_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL
);--> statement-breakpoint
ALTER TABLE "api_key_organization" ADD CONSTRAINT "api_key_organization_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_organization" ADD CONSTRAINT "api_key_organization_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_organization_organizationId_idx" ON "api_key_organization" USING btree ("organization_id");
