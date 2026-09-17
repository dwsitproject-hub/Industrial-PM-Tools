-- Self-service password reset + email account activation.

CREATE TYPE "auth_token_type" AS ENUM ('ACTIVATION', 'PASSWORD_RESET');

CREATE TABLE "auth_tokens" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id"    UUID NOT NULL,
    "type"       "auth_token_type" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at"    TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "auth_tokens_token_hash_idx" ON "auth_tokens"("token_hash");
CREATE INDEX "auth_tokens_user_id_type_idx" ON "auth_tokens"("user_id", "type");
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Accounts created from now on start pending until the user follows the activation link.
ALTER TABLE "users" ADD COLUMN "activated_at" TIMESTAMPTZ(6);

-- Everyone who already has a working password is, by definition, already activated.
UPDATE "users" SET "activated_at" = COALESCE("created_at", now());
