-- Login by email instead of username.
-- Existing rows (incl. the migrated legacy accounts) have no email, so backfill a
-- deterministic placeholder first; managers replace them in Settings -> Users.

-- 1. backfill from username
UPDATE "users"
   SET "email" = lower("username") || '@engpro.local'
 WHERE "email" IS NULL OR btrim("email") = '';

-- 2. normalise existing values (login lookups are lower-cased)
UPDATE "users" SET "email" = lower(btrim("email"));

-- 3. de-duplicate defensively: keep the oldest, suffix the rest
UPDATE "users" u
   SET "email" = split_part(u."email", '@', 1) || '+' || left(u."id"::text, 8)
                 || '@' || split_part(u."email", '@', 2)
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "email" ORDER BY "created_at", "id") AS rn
      FROM "users"
  ) d
 WHERE d."id" = u."id" AND d.rn > 1;

-- 4. enforce
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
