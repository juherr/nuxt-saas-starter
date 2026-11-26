-- SPDX-License-Identifier: MIT
--
-- Ends better-auth-1.7-api-keys-migration.sql on a 1.4 deployment that has
-- api_key_organization: drizzle-kit points the link back at api_key
-- (server/db/schema/apiKeyOrganization.ts, kept until #162).
ALTER TABLE "api_key_organization" ADD CONSTRAINT "api_key_organization_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE cascade ON UPDATE no action;
