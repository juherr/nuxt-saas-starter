-- SPDX-License-Identifier: MIT
--
-- Moves API keys to organization ownership, then lets the database keep it.
-- Registered in nuxt.config.ts (hub:db:queries:paths): NuxtHub runs it after
-- every migration, on each build with a database URL, `nuxt db migrate` and
-- `pnpm dev`. It is idempotent: once the foreign key exists, it is a no-op.
--
-- 1. Lock api_key against writes from a still-running previous release.
-- 2. Give each key listed in the deprecated link table api_key_organization
--    its organization as reference_id.
-- 3. Delete the keys that still reference no organization and are disabled
--    (enabled = false): they no longer authenticate. A NULL enabled counts
--    as enabled, as better-auth only refuses enabled = false.
-- 4. Stop with an error while enabled keys reference no organization: the
--    operator decides (README, Upgrading to organization-owned API keys).
-- 5. Add the foreign key api_key.reference_id -> organization.id with
--    ON DELETE CASCADE, so deleting an organization deletes its keys.
--
-- It is one DO statement, so a failure rolls all of it back. NuxtHub splits
-- the file with a scanner that ignores dollar quoting: the body is a
-- single-quoted string, and must hold no apostrophe and no backslash. String
-- constants inside it use dollar quotes, which only PL/pgSQL reads.
DO '
DECLARE
  orphans integer;
BEGIN
  LOCK TABLE api_key IN SHARE ROW EXCLUSIVE MODE;

  UPDATE api_key
  SET reference_id = l.organization_id
  FROM api_key_organization l
  WHERE l.api_key_id = api_key.id
    AND api_key.reference_id IS DISTINCT FROM l.organization_id;

  DELETE FROM api_key
  WHERE enabled = false
    AND NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = api_key.reference_id);

  SELECT count(*) INTO orphans
  FROM api_key
  WHERE NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = api_key.reference_id);

  IF orphans > 0 THEN
    RAISE EXCEPTION $msg$% enabled API key(s) belong to no organization, so none was moved. List them with: SELECT id, reference_id FROM api_key WHERE NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = api_key.reference_id); then move or delete them and run it again (README, Upgrading to organization-owned API keys).$msg$, orphans;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = $name$api_key_reference_id_organization_id_fk$name$
      AND conrelid = to_regclass($table$api_key$table$)
  ) THEN
    ALTER TABLE api_key
      ADD CONSTRAINT api_key_reference_id_organization_id_fk
      FOREIGN KEY (reference_id) REFERENCES organization(id) ON DELETE CASCADE;
  END IF;
END
';
