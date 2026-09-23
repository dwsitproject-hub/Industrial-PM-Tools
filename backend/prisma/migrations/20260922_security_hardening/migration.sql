-- Security hardening: account lockout (AR-15) and a tamper-evident audit trail (AR-12).

-- ── AR-15 ───────────────────────────────────────────────────────────────────
-- Per-IP throttling does not stop a distributed, low-and-slow credential-stuffing run
-- against known corporate addresses. A cumulative per-account counter does.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "failed_login_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "locked_until"       TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_login_at"      TIMESTAMPTZ(6);

-- ── AR-12 ───────────────────────────────────────────────────────────────────
-- Each row carries the hash of the previous row for its workspace, so removing or editing
-- an entry breaks the chain from that point on and becomes detectable. This does not stop
-- a determined DBA rewriting the whole chain — that needs the off-host copy described in
-- SECURITY_HARDENING.md — but it removes "quietly delete one damning row" as an option.
ALTER TABLE "audit_log"
  ADD COLUMN IF NOT EXISTS "hash"      TEXT,
  ADD COLUMN IF NOT EXISTS "prev_hash" TEXT;

CREATE INDEX IF NOT EXISTS "audit_log_workspace_id_id_idx" ON "audit_log" ("workspace_id", "id");
CREATE INDEX IF NOT EXISTS "audit_log_created_at_idx"      ON "audit_log" ("created_at");
