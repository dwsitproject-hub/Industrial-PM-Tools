# EngPro — Staging Deployment Guide

**Version 1.0 · 14 Sep 2026**

| Component | Where | Address |
|---|---|---|
| Frontend (nginx + SPA) | FE server `StagingdwsFront` | `172.28.92.56` → port **3060** |
| Backend (NestJS API) | BE server `StagingdwsBack` | `172.28.92.57` → port **4010** (bound to private IP) |
| Database | ApsaraDB RDS PostgreSQL | `pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com:5432` |

Ports **3060** (FE) and **4010** (BE) were chosen because they are free on both hosts
(checked against the current `docker ps` on each server). No PostgreSQL container runs in
staging — the API talks to ApsaraDB directly.

```
Users ──HTTP──> 172.28.92.56:3060 (nginx: SPA + /api + /ws proxy)
                        │
                        └──> 172.28.92.57:4010 (engpro-staging-api)
                                     │
                                     └──> pgm-d9jx9o06qae8gf3h...rds.aliyuncs.com:5432
```

All staging files live in the repo under `infra/staging/`:
`docker-compose.fe.yml`, `docker-compose.be.yml`, `nginx.engpro-staging.conf`,
`.env.staging.example` — all validated locally before this guide was written.

---

## 0. Pre-flight checklist

- [ ] Both servers reachable over SSH; Docker + Docker Compose v2 installed (they are — both already run compose stacks).
- [ ] Ports still free (run on each server):
  ```bash
  ss -tlnp | grep -E ':3060|:4010' || echo "ports free"
  ```
- [ ] **Alibaba Security Groups**:
  - FE server: allow inbound TCP **3060** from your office/VPN range (same source you use for the other staging UIs).
  - BE server: allow inbound TCP **4010** from **172.28.92.56/32 only** (the FE server). Do **not** expose 4010 publicly.
- [ ] **ApsaraDB whitelist**: add the BE server (`172.28.92.57/32`, or your VPC vSwitch CIDR) to the RDS instance whitelist (console → the instance → *Data Security → Whitelist*).
- [ ] RDS engine version is PostgreSQL **14 or newer** (16 recommended — local runs 16, and the data dump was taken with pg 16 tools).
- [ ] Local machine: e2e suite green (`cd apps/api && npm run test:e2e` → 67 passed) and fresh web build (`cd apps/web && npm run build`).

---

## 1. Prepare ApsaraDB

**1.1 Create the account** (console → instance → *Accounts → Create Account*):
- Account name: `engpro_stg`, type: **Privileged account** (needed for `CREATE EXTENSION` and `CREATE DATABASE`).
- Strong password → note it for `.env.staging`.

**1.2 Create the database and verify extensions** — from the **BE server**:

```bash
export RDS_HOST=pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com
export PGPASSWORD='<engpro_stg password>'

# connectivity + create database
docker run --rm -e PGPASSWORD postgres:16-alpine \
  psql -h $RDS_HOST -U engpro_stg -d postgres \
  -c "CREATE DATABASE engpro_staging;"

# both required extensions must be available (they are standard on ApsaraDB PG)
docker run --rm -e PGPASSWORD postgres:16-alpine \
  psql -h $RDS_HOST -U engpro_stg -d engpro_staging \
  -c "SELECT name, default_version FROM pg_available_extensions WHERE name IN ('pg_trgm','pgcrypto');"
```

Expected: two rows (`pg_trgm`, `pgcrypto`). If `psql` cannot connect, fix the whitelist (step 0) first.
> If SSL is enabled on the instance, append `&sslmode=require` to `DATABASE_URL` later and add `sslmode=require` via `PGSSLMODE=require` to these `docker run` commands.

---

## 2. Prepare artifacts on your local machine

```bash
cd "D:/Claude/Industrial PM Tools"

# 2.1 fresh SPA build (served as static files by staging nginx)
cd engpro/apps/web && npm run build && cd ../../..

# 2.2 database dump of your local EngPro (custom format, includes schema + data
#     + Prisma migration history) — ALREADY CREATED & restore-verified:
#     engpro/deploy/engpro-local-20260914.dump
#     To refresh it right before deploying:
docker exec engpro-db pg_dump -U engpro -Fc -f /tmp/engpro-local.dump engpro
docker cp engpro-db:/tmp/engpro-local.dump engpro/deploy/engpro-local-$(date +%Y%m%d).dump
# (Git Bash on Windows: prefix docker commands with MSYS_NO_PATHCONV=1)

# 2.3 pack the repo (small: node_modules/dist excluded; web dist INCLUDED)
tar --exclude='engpro/apps/api/node_modules' \
    --exclude='engpro/apps/api/dist' \
    --exclude='engpro/apps/web/node_modules' \
    -czf engpro-staging.tar.gz engpro
```

---

## 3. Ship the code to both servers

Replace the host addresses with whatever you use to SSH (jump host / VPN address):

```bash
scp engpro-staging.tar.gz root@172.28.92.56:/opt/
scp engpro-staging.tar.gz root@172.28.92.57:/opt/
```

On **each** server:

```bash
cd /opt && rm -rf engpro && tar -xzf engpro-staging.tar.gz && rm engpro-staging.tar.gz
```

---

## 4. Load the data into ApsaraDB (data migration from local)

> Do this **before** starting the API for the cleanest path. The dump carries the Prisma
> migration history, so the API's automatic `prisma migrate deploy` becomes a no-op.

### Option A — restore your local database (recommended)

Brings staging to *exactly* your local state: the migrated legacy workspace
(225 tickets, repaired numbering, notes, KPI ledger) plus everything created since.
This exact procedure was rehearsed locally against the shipped dump
(restores 226 tickets / 24 users / 370 notes / 148 KPI entries cleanly).

On the **BE server**:

```bash
cd /opt/engpro
export RDS_HOST=pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com
export PGPASSWORD='<engpro_stg password>'

docker run --rm -e PGPASSWORD -v /opt/engpro/deploy:/dump postgres:16-alpine \
  pg_restore -h $RDS_HOST -U engpro_stg -d engpro_staging \
  --no-owner --no-privileges /dump/engpro-local-20260914.dump

# verify
docker run --rm -e PGPASSWORD postgres:16-alpine \
  psql -h $RDS_HOST -U engpro_stg -d engpro_staging -c \
  "SELECT (SELECT count(*) FROM tickets)  AS tickets,
          (SELECT count(*) FROM users)    AS users,
          (SELECT count(*) FROM ticket_notes) AS notes,
          (SELECT count(*) FROM kpi_entries)  AS kpi;"
```

Expected ≈ `226 | 24 | 370 | 148` (numbers grow with whatever you did locally since).

*If you already started the API before restoring* (schema exists), add
`--clean --if-exists` to the `pg_restore` command.

### Option B — fresh migration from the legacy Supabase CSVs

Use only if you want a pristine staging copy of the legacy data instead of your local state.

```bash
# local: ship the legacy CSV export
scp -r "D:/Claude/Industrial PM Tools/db" root@172.28.92.57:/opt/engpro-legacy-db

# BE server: run the validated ETL (Tech Doc §7) with STAGING passwords
docker run --rm -v /opt/engpro/apps/api:/app -v /opt/engpro-legacy-db:/legacy -w /app \
  -e DATABASE_URL="postgresql://engpro_stg:<pw>@$RDS_HOST:5432/engpro_staging" \
  -e LEGACY_DIR=/legacy \
  -e SEED_MANAGER_PASSWORD='<strong manager pw>' \
  -e SEED_MEMBER_PASSWORD='<strong shared temp pw>' \
  node:20-bookworm bash -c "apt-get update -qq && apt-get install -y -qq openssl > /dev/null && npm ci && npx prisma migrate deploy && npx ts-node -T prisma/seed-legacy.ts"
```

The ETL prints its validation gate (row counts, duplicate repair, KPI reconciliation) and
exits non-zero if anything is off.

---

## 5. Deploy the backend (BE server, 172.28.92.57)

```bash
cd /opt/engpro/infra/staging

# 5.1 environment — copy the template and fill it in
cp .env.staging.example .env.staging
openssl rand -hex 64   # run twice; paste as JWT_ACCESS_SECRET / JWT_REFRESH_SECRET
vi .env.staging        # set DATABASE_URL password + the two secrets
chmod 600 .env.staging

# 5.2 build & start (the container runs `prisma migrate deploy` before the API boots)
docker compose -f docker-compose.be.yml up -d --build

# 5.3 verify
docker logs -f engpro-staging-api        # expect: "EngPro API listening on :3000"; Ctrl-C
curl -s http://172.28.92.57:4010/api/v1/health
curl -s http://172.28.92.57:4010/api/v1/ready       # {"status":"ready"} = DB connection OK
curl -s http://172.28.92.57:4010/api/v1/workspace   # shows "KPN Downstream-Estimation Control"
```

`.env.staging` reference (template: `.env.staging.example`):

| Variable | Staging value |
|---|---|
| `DATABASE_URL` | `postgresql://engpro_stg:<pw>@pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com:5432/engpro_staging?connection_limit=10` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | two different `openssl rand -hex 64` values |
| `CORS_ORIGIN` | `http://172.28.92.56:3060` |
| `COOKIE_SECURE` | `false` (staging is plain HTTP — `true` would break login) |
| `WORKSPACE_TZ` | `Asia/Jakarta` |

---

## 6. Deploy the frontend (FE server, 172.28.92.56)

```bash
cd /opt/engpro/infra/staging
docker compose -f docker-compose.fe.yml up -d

# verify the SPA and the proxy chain end-to-end
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3060/          # 200
curl -s http://localhost:3060/api/v1/health                              # via proxy -> BE
```

Open **http://172.28.92.56:3060** in a browser — the login page must show the
company branding (proves FE → BE → RDS path). Log in and confirm the header dot says
**Live** (proves the `/ws` websocket proxy works).

---

## 7. Post-deployment hardening (do immediately)

The Option-A dump carries your **local** convenience passwords
(`Manager@2026!` / `ChangeMe123!`). Force everyone — including the manager — to set a
new password at first staging login, and drop any restored sessions:

```bash
docker run --rm -e PGPASSWORD postgres:16-alpine \
  psql -h $RDS_HOST -U engpro_stg -d engpro_staging \
  -c "UPDATE users SET must_change_password = true;" \
  -c "TRUNCATE refresh_tokens;"
```

At first login each user enters their old (local) password once and is forced to choose a
new one (min 10 chars). Afterwards, manage credentials only via *Settings → Users → Reset
password*.

Also confirm:
- [ ] BE port 4010 is **not** reachable from outside the FE server (`curl 172.28.92.57:4010` from your laptop should fail).
- [ ] RDS automated backups are enabled (console → *Backup and Restore*) — this is the staging backup story.
- [ ] `.env.staging` is `chmod 600` and never copied off the server.

---

## 8. Smoke-test checklist (10 minutes)

| # | As | Do | Expect |
|---|---|---|---|
| 1 | manager | Log in → forced password change → Dashboard | Real totals (≈226 tickets), workload cards |
| 2 | manager | Create a ticket | Number continues the series (no duplicates) |
| 3 | manager | Board: drag the new ticket to Done (assigned) | KPI toast; entry visible in KPI tab |
| 4 | manager | Settings → Roles | 4 role chips, Manager locked, matrix renders |
| 5 | estimator (e.g. `rully`) | My tickets / Team board / My KPI | Own queue, overdue banner, personal ledger |
| 6 | site admin (e.g. `site.dumai`) | My site tickets → open one → move deadline | Only own site visible; deadline saves |
| 7 | two browsers | Change a ticket in one | Other updates within ~1 s (websocket) |
| 8 | manager | Settings → Audit trail | Login + ticket entries recorded |

---

## 9. Updating staging later

**Frontend change:** build locally, ship only the dist, no restart needed
(assets are content-hashed; `index.html` is no-cache):
```bash
cd engpro/apps/web && npm run build
scp -r dist/* root@172.28.92.56:/opt/engpro/apps/web/dist/
```

**Backend change:** ship the changed `apps/api` source (or the whole tarball), then:
```bash
cd /opt/engpro/infra/staging && docker compose -f docker-compose.be.yml up -d --build
```
Database migrations in `prisma/migrations/` apply automatically on container start.

**Rollback:** keep the previous `engpro-staging.tar.gz`; re-extract + rebuild. For data,
use RDS point-in-time restore.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| nginx returns **502** on `/api/*` | API container down (`docker ps` on BE) or FE→BE port 4010 blocked by the security group |
| API logs `P1001: Can't reach database server` | BE server IP missing from the RDS whitelist, or wrong host/password in `DATABASE_URL` |
| `permission denied to create extension` during migrate/restore | The RDS account is not a **privileged** account — recreate it as privileged |
| Login succeeds but immediately bounces back to login | `COOKIE_SECURE=true` on plain HTTP — must be `false` in staging |
| Header dot stays **Offline** | `/ws` proxy block missing/misconfigured in nginx, or security group blocks the FE→BE connection |
| `pg_restore` errors about roles/ownership | Add `--no-owner --no-privileges` (already in the command above) |
| Port already allocated on `up -d` | Another stack took 3060/4010 since the check — pick a new free port in the compose file (and update the nginx `proxy_pass` / security group accordingly) |
