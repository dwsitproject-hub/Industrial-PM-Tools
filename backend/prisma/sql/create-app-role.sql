-- AR-16: give the running application its own least-privilege database role.
--
-- Today the API connects with the RDS privileged account, because that account was needed
-- once to restore the dump and create extensions. The consequence is that any compromise of
-- the API container — or any SQL injection, should one ever appear — escalates straight to
-- full control of the database, including the power to rewrite the audit trail that would
-- record it.
--
-- Run ONCE as the privileged account, against the application database:
--     psql "postgresql://postgres:<pw>@<host>:5432/industrial_pm" \
--          -v app_password='a-strong-password' -f create-app-role.sql
--
-- Then point the API at the new role and keep the privileged account for migrations only:
--     DATABASE_URL=postgresql://industrial_pm_app:<pw>@<host>:5432/industrial_pm?sslmode=require
--     MIGRATE_DATABASE_URL=postgresql://postgres:<pw>@<host>:5432/industrial_pm?sslmode=require
-- (percent-encode both passwords — a raw '@' makes Prisma fail with P1013)

\if :{?app_password}
\else
\set app_password 'CHANGE_ME_APP_PASSWORD'
\endif

-- 1. The role itself.
--    psql does NOT substitute :variables inside dollar-quoted blocks, so the password is
--    injected with format()+\gexec rather than a DO block.
SELECT format('CREATE ROLE industrial_pm_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'industrial_pm_app')
\gexec

SELECT format('ALTER ROLE industrial_pm_app LOGIN PASSWORD %L', :'app_password')
\gexec

-- 2. Read/write on the data, and nothing else. current_database() keeps this script usable
--    against any environment without editing the database name in.
SELECT format('GRANT CONNECT ON DATABASE %I TO industrial_pm_app', current_database())
\gexec
GRANT USAGE ON SCHEMA public TO industrial_pm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO industrial_pm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO industrial_pm_app;

-- 3. Tables added by future migrations inherit the same grants. Migrations run as whichever
--    account executes them, which is the account running this script.
DO $$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO industrial_pm_app', current_user);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT USAGE, SELECT ON SEQUENCES TO industrial_pm_app', current_user);
END
$$;

-- 4. No schema changes, and no rewriting of the migration ledger, from the app account.
REVOKE CREATE ON SCHEMA public FROM industrial_pm_app;
REVOKE ALL ON TABLE "_prisma_migrations" FROM industrial_pm_app;
GRANT SELECT ON TABLE "_prisma_migrations" TO industrial_pm_app;

-- 5. AR-12: the application appends to the audit trail and must not be able to rewrite it.
--    Retention pruning is a maintenance task — see prune-audit.sql — run by the privileged
--    account on a schedule, not by the application.
--
--    NOTE: this revoke targets the existing table. If a future migration ever drops and
--    recreates audit_log, re-run this script. The verification query in step 6 will show it.
REVOKE UPDATE, DELETE ON TABLE "audit_log" FROM industrial_pm_app;

-- 6. Verify. audit_log must show INSERT and SELECT only.
SELECT table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE grantee = 'industrial_pm_app' AND table_schema = 'public'
  AND table_name IN ('audit_log', 'tickets', 'users', '_prisma_migrations')
GROUP BY table_name
ORDER BY table_name;
