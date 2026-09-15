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

Backend and frontend are separate top-level folders, so **each server only receives its own
half of the repo**:

| Server | Folder deployed | Staging files (validated locally) |
|---|---|---|
| FE `172.28.92.56` | `frontend/` | `docker-compose.staging.yml`, `nginx/staging.conf`, built `dist/` |
| BE `172.28.92.57` | `backend/` | `docker-compose.staging.yml`, `Dockerfile`, `.env.staging.example`, `prisma/` |

Repository: `git@github.com:dwsitproject-hub/Industrial-PM-Tools.git`

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
- [ ] Local machine: e2e suite green (`cd backend && npm run test:e2e` → 67 passed) and fresh SPA build (`cd frontend && npm run build`).

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
  -c "CREATE DATABASE industrial_pm;"

# both required extensions must be available (they are standard on ApsaraDB PG)
docker run --rm -e PGPASSWORD postgres:16-alpine \
  psql -h $RDS_HOST -U engpro_stg -d industrial_pm \
  -c "SELECT name, default_version FROM pg_available_extensions WHERE name IN ('pg_trgm','pgcrypto');"
```

Expected: two rows (`pg_trgm`, `pgcrypto`). If `psql` cannot connect, fix the whitelist (step 0) first.
> If SSL is enabled on the instance, append `&sslmode=require` to `DATABASE_URL` later and add `sslmode=require` via `PGSSLMODE=require` to these `docker run` commands.

---

## 2. Prepare artifacts on your local machine

```bash
cd "D:/Claude/Industrial PM Tools"

# 2.1 fresh SPA build (served as static files by staging nginx)
cd frontend && npm run build && cd ..

# 2.2 database dump of your local EngPro (custom format, includes schema + data
#     + Prisma migration history) — ALREADY CREATED & restore-verified:
#     deploy/industrial_pm-local-20260914.dump
#     To refresh it right before deploying:
docker exec engpro-db pg_dump -U engpro -Fc -f /tmp/industrial_pm-local.dump industrial_pm
docker cp engpro-db:/tmp/industrial_pm-local.dump deploy/industrial_pm-local-$(date +%Y%m%d).dump
# (Git Bash on Windows: prefix docker commands with MSYS_NO_PATHCONV=1)
```

---

## 3. Ship the code to the servers

Each server gets only its own half. Pick **one** of the two methods.

### Method A — git clone on the servers (recommended)

Requires a read-only deploy key on each server (repo → *Settings → Deploy keys*, **without**
write access):

```bash
# on EACH server, once
ssh-keygen -t ed25519 -C "industrial-pm-staging-$(hostname)" -f ~/.ssh/id_ed25519_industrialpm -N ''
cat ~/.ssh/id_ed25519_industrialpm.pub     # register this on GitHub as a read-only deploy key
cat >> ~/.ssh/config <<'EOF'
Host github-industrialpm
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_industrialpm
  IdentitiesOnly yes
EOF

git clone git@github-industrialpm:dwsitproject-hub/Industrial-PM-Tools.git /opt/industrial_pm
```

Updating later is then just `cd /opt/industrial_pm && git pull`.
The FE server still needs a built SPA — either run `cd /opt/industrial_pm/frontend && npm ci && npm run build`
on the server, or `scp` your local `frontend/dist` (step 6).

### Method B — ship only the needed folder over scp

```bash
# from your laptop
tar --exclude='node_modules' -czf industrial-pm-backend.tar.gz backend
tar --exclude='node_modules' -czf industrial-pm-frontend.tar.gz frontend   # includes dist/

scp industrial-pm-backend.tar.gz  root@172.28.92.57:/opt/
scp industrial-pm-frontend.tar.gz root@172.28.92.56:/opt/

# on the BE server
cd /opt && mkdir -p industrial_pm && tar -xzf industrial-pm-backend.tar.gz -C industrial_pm && rm industrial-pm-backend.tar.gz
# on the FE server
cd /opt && mkdir -p industrial_pm && tar -xzf industrial-pm-frontend.tar.gz -C industrial_pm && rm industrial-pm-frontend.tar.gz
```

Either way you end up with `/opt/industrial_pm/backend` on the BE server and
`/opt/industrial_pm/frontend` on the FE server.

---

## 4. Load the data into ApsaraDB (data migration from local)

> Do this **before** starting the API for the cleanest path. The dump carries the Prisma
> migration history, so the API's automatic `prisma migrate deploy` becomes a no-op.

### Option A — restore your local database (recommended)

Brings staging to *exactly* your local state: the migrated legacy workspace
(225 tickets, repaired numbering, notes, KPI ledger) plus everything created since.
This exact procedure was rehearsed locally against the shipped dump
(restores 226 tickets / 24 users / 370 notes / 148 KPI entries cleanly).

**4A.1 — Upload the dump to the BE server (mandatory, do not skip).**
The dump is git-ignored, so it never arrives with `git clone` or the code tarball — it must be
copied by hand. Run this **on your laptop**, from the repo root:

```powershell
ssh root@172.28.92.57 "mkdir -p /opt/industrial_pm/dump"
scp deploy/industrial_pm-local-20260914.dump root@172.28.92.57:/opt/industrial_pm/dump/
```

> **If your laptop cannot reach `172.28.92.57` directly** (it is a private IP), use the
> file-transfer / SFTP panel of the SSH client you already use for these servers
> (FinalShell / WinSCP / Xshell) and drop the file into `/opt/industrial_pm/dump/`.
> Last-resort fallback over a plain terminal — the dump is only ~110 KB:
>
> ```powershell
> # laptop (PowerShell): put the file on the clipboard as base64
> [Convert]::ToBase64String([IO.File]::ReadAllBytes("deploy/industrial_pm-local-20260914.dump")) | Set-Clipboard
> ```
> ```bash
> # BE server: paste between the markers, then decode
> mkdir -p /opt/industrial_pm/dump && cat > /tmp/dump.b64 <<'B64EOF'
> <paste here>
> B64EOF
> base64 -d /tmp/dump.b64 > /opt/industrial_pm/dump/industrial_pm-local-20260914.dump
> ```

**4A.2 — Confirm it landed** (on the BE server). Skipping 4A.1 does not fail loudly: Docker
happily creates an *empty* `/opt/industrial_pm/dump` for the mount and `pg_restore` then reports
`could not open input file`.

```bash
ls -la /opt/industrial_pm/dump/
# expect: industrial_pm-local-20260914.dump   ~111676 bytes
```

**4A.3 — Restore** (on the BE server):

```bash
export RDS_HOST=pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com
export PGPASSWORD='<engpro_stg password>'

docker run --rm -e PGPASSWORD -v /opt/industrial_pm/dump:/dump postgres:16-alpine \
  pg_restore -h $RDS_HOST -U engpro_stg -d industrial_pm \
  --no-owner --no-privileges /dump/industrial_pm-local-20260914.dump

# verify
docker run --rm -e PGPASSWORD postgres:16-alpine \
  psql -h $RDS_HOST -U engpro_stg -d industrial_pm -c \
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
scp -r "D:/Claude/Industrial PM Tools/db" root@172.28.92.57:/opt/industrial_pm-legacy-db

# BE server: run the validated ETL (Tech Doc §7) with STAGING passwords
docker run --rm -v /opt/industrial_pm/backend:/app -v /opt/industrial_pm-legacy-db:/legacy -w /app \
  -e DATABASE_URL="postgresql://engpro_stg:<pw>@$RDS_HOST:5432/industrial_pm" \
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
cd /opt/industrial_pm/backend

# 5.1 environment — copy the template and fill it in
cp .env.staging.example .env.staging
openssl rand -hex 64   # run twice; paste as JWT_ACCESS_SECRET / JWT_REFRESH_SECRET
vi .env.staging        # set DATABASE_URL password + the two secrets
chmod 600 .env.staging

# 5.2 build & start (the container runs `prisma migrate deploy` before the API boots)
docker compose -f docker-compose.staging.yml up -d --build

# 5.3 verify
docker logs -f engpro-staging-api        # expect: "EngPro API listening on :3000"; Ctrl-C
curl -s http://172.28.92.57:4010/api/v1/health
curl -s http://172.28.92.57:4010/api/v1/ready       # {"status":"ready"} = DB connection OK
curl -s http://172.28.92.57:4010/api/v1/workspace   # shows "KPN Downstream-Estimation Control"
```

`.env.staging` reference (template: `.env.staging.example`):

| Variable | Staging value |
|---|---|
| `DATABASE_URL` | `postgresql://engpro_stg:<pw>@pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com:5432/industrial_pm?connection_limit=10` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | two different `openssl rand -hex 64` values |
| `CORS_ORIGIN` | `http://172.28.92.56:3060` |
| `COOKIE_SECURE` | `false` (staging is plain HTTP — `true` would break login) |
| `WORKSPACE_TZ` | `Asia/Jakarta` |

---

## 6. Deploy the frontend (FE server, 172.28.92.56)

```bash
cd /opt/industrial_pm/frontend

# the SPA must be built. Either build on the server:
#   npm ci && npm run build
# or ship your local build from the laptop:
#   scp -r frontend/dist/* root@172.28.92.56:/opt/industrial_pm/frontend/dist/
ls dist/index.html || echo "BUILD MISSING — build or upload dist/ first"

docker compose -f docker-compose.staging.yml up -d

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
  psql -h $RDS_HOST -U engpro_stg -d industrial_pm \
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

**Frontend change** (FE server) — no restart needed, assets are content-hashed and
`index.html` is no-cache:
```bash
# laptop
cd frontend && npm run build
scp -r dist/* root@172.28.92.56:/opt/industrial_pm/frontend/dist/
# or, with Method A: on the server -> cd /opt/industrial_pm && git pull && cd frontend && npm ci && npm run build
```

**Backend change** (BE server):
```bash
cd /opt/industrial_pm && git pull                     # Method A; otherwise re-ship backend/
cd backend && docker compose -f docker-compose.staging.yml up -d --build
```
Database migrations in `backend/prisma/migrations/` apply automatically on container start.

**Rollback:** `git checkout <previous-commit>` (or re-extract the previous tarball) and rebuild.
For data, use RDS point-in-time restore.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| nginx returns **502** on `/api/*` | API container down (`docker ps` on BE) or FE→BE port 4010 blocked by the security group |
| API logs `P1001: Can't reach database server` | BE server IP missing from the RDS whitelist, or wrong host/password in `DATABASE_URL` |
| `permission denied to create extension` during migrate/restore | The RDS account is not a **privileged** account — recreate it as privileged |
| Login succeeds but immediately bounces back to login | `COOKIE_SECURE=true` on plain HTTP — must be `false` in staging |
| Header dot stays **Offline** | `/ws` proxy block missing/misconfigured in nginx, or security group blocks the FE→BE connection |
| `pg_restore: could not open input file` | The dump was never uploaded to the server — do step **4A.1**. Docker creates an empty `/opt/industrial_pm/dump` when the host path does not exist, so the mount succeeds but the file is absent |
| `pg_restore` errors about roles/ownership | Add `--no-owner --no-privileges` (already in the command above) |
| Port already allocated on `up -d` | Another stack took 3060/4010 since the check — pick a new free port in the compose file (and update the nginx `proxy_pass` / security group accordingly) |
