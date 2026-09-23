-- AR-04: multi-factor authentication.
--
-- A password plus an internet-reachable login is the entire barrier for accounts that can
-- read every tender in the register, reset other people's passwords and rewrite the
-- permission matrix. Once external users are admitted, credential phishing and reuse become
-- the most probable attack; a second factor is what stops a leaked password being enough.
--
-- mfa_secret holds the TOTP shared secret encrypted with AES-256-GCM (see mfa.service.ts),
-- so a database dump on its own does not hand over working second factors.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "mfa_secret"       TEXT,
  ADD COLUMN IF NOT EXISTS "mfa_enabled_at"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "mfa_backup_codes" TEXT[] NOT NULL DEFAULT '{}';
