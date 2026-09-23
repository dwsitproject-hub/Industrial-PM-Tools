-- Audit retention (AR-12). Run as the PRIVILEGED account — the application role is
-- deliberately unable to delete audit rows.
--
--   psql "postgresql://postgres:<pw>@<host>:5432/industrial_pm" \
--        -v days=400 -f prune-audit.sql
--
-- The technical documentation commits to keeping 12 months; 400 days leaves headroom for a
-- year-end investigation. Export to your log archive BEFORE pruning if you need longer.
\if :{?days}
\else
\set days 400
\endif

BEGIN;
SELECT count(*) AS will_delete
FROM audit_log
WHERE created_at < now() - (:'days' || ' days')::interval;

DELETE FROM audit_log
WHERE created_at < now() - (:'days' || ' days')::interval;
COMMIT;

-- Note: pruning necessarily breaks the hash chain at the boundary. Record the hash of the
-- oldest surviving row before pruning so the remaining chain can still be verified from it.
SELECT id, created_at, hash AS new_chain_root
FROM audit_log ORDER BY id ASC LIMIT 1;
