-- AR-03: company-scoped records, so users from outside the organisation can be admitted
-- without exposing KPN's tender register to them (or one external firm's work to another).
--
-- Model B from the security assessment: one workspace, every ticket owned by a company, and
-- external users hard-scoped to their own — the same mechanism that already confines a
-- SITE_ADMIN to one site, which is the pattern in this codebase with the most test coverage.
--
-- An INTERNAL company is the organisation itself. Its users are not company-scoped and keep
-- seeing everything their role allows. Only users in an EXTERNAL company are confined.

CREATE TABLE IF NOT EXISTS "companies" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name"         TEXT NOT NULL,
  "is_internal"  BOOLEAN NOT NULL DEFAULT false,
  "is_active"    BOOLEAN NOT NULL DEFAULT true,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "companies_workspace_name_key" ON "companies" ("workspace_id", lower("name"));
-- At most one internal company per workspace: "who are we" must be unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_company_internal_once"
  ON "companies" ("workspace_id") WHERE "is_internal";

ALTER TABLE "users"   ADD COLUMN IF NOT EXISTS "company_id" UUID REFERENCES "companies"("id") ON DELETE RESTRICT;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "company_id" UUID REFERENCES "companies"("id") ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS "users_company_id_idx"   ON "users" ("company_id");
CREATE INDEX IF NOT EXISTS "tickets_company_id_idx" ON "tickets" ("company_id");

-- Backfill: every existing workspace gets an internal company named after it, and every
-- existing user and ticket is attributed to it. Nothing changes behaviourally — internal
-- users are unscoped — but the column is populated so the scoping code has something to
-- filter on from day one rather than treating NULL as a special case forever.
INSERT INTO "companies" ("workspace_id", "name", "is_internal")
SELECT w."id", w."company", true
FROM "workspaces" w
WHERE NOT EXISTS (SELECT 1 FROM "companies" c WHERE c."workspace_id" = w."id" AND c."is_internal")
ON CONFLICT DO NOTHING;

UPDATE "users" u
SET "company_id" = c."id"
FROM "companies" c
WHERE c."workspace_id" = u."workspace_id" AND c."is_internal" AND u."company_id" IS NULL;

UPDATE "tickets" t
SET "company_id" = c."id"
FROM "companies" c
WHERE c."workspace_id" = t."workspace_id" AND c."is_internal" AND t."company_id" IS NULL;
