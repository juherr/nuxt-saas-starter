-- SPDX-License-Identifier: MIT
--
-- The link table of a better-auth 1.4 deployment that scoped its keys to an
-- organization, as drizzle-kit generates it from
-- server/db/schema/apiKeyOrganization.ts at e0abea3 (released in v0.1.0):
-- it references "apiKey", the 1.4 key table.
CREATE TABLE "api_key_organization" (
	"api_key_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL
);
ALTER TABLE "api_key_organization" ADD CONSTRAINT "api_key_organization_api_key_id_apiKey_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."apiKey"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "api_key_organization" ADD CONSTRAINT "api_key_organization_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "api_key_organization_organizationId_idx" ON "api_key_organization" USING btree ("organization_id");
