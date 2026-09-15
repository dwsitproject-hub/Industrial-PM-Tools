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
Use the instance's **privileged account** — on this instance that is **`postgres`**.
A *standard* account cannot `CREATE EXTENSION` and cannot create objects in the `public`
schema, so both the restore and Prisma's migrations fail on it.

- If the privileged account already exists, just note/reset its password in the console.
- If not: console → instance → *Accounts → Create Account → Account Type: **Privileged Account***.
- Note the password → it goes in `.env.staging`.

> Staging uses this one account for both the restore and the API. If you prefer the API to run
> as a lower-privileged account later, create it and hand over ownership:
> ```sql
> ALTER DATABASE industrial_pm OWNER TO <app_account>;
> GRANT ALL ON SCHEMA public TO <app_account>;
> GRANT ALL ON ALL TABLES    IN SCHEMA public TO <app_account>;
> GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO <app_account>;
> ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO <app_account>;
> ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO <app_account>;
> ```

**1.2 Create the database and verify extensions** — from the **BE server**:

```bash
export RDS_HOST=pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com
export PGPASSWORD='<postgres account password>'
# fail loudly if these are not set in THIS shell (a new SSH session loses them):
: "${RDS_HOST:?export RDS_HOST first}" ; : "${PGPASSWORD:?export PGPASSWORD first}"

# connectivity + create database
docker run --rm -e PGPASSWORD postgres:16-alpine \
  psql -h $RDS_HOST -U postgres -d postgres \
  -c "CREATE DATABASE industrial_pm;"

# both required extensions must be available (they are standard on ApsaraDB PG)
docker run --rm -e PGPASSWORD postgres:16-alpine \
  psql -h $RDS_HOST -U postgres -d industrial_pm \
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
export PGPASSWORD='<postgres account password>'
# fail loudly if these are not set in THIS shell (a new SSH session loses them):
: "${RDS_HOST:?export RDS_HOST first}" ; : "${PGPASSWORD:?export PGPASSWORD first}"

docker run --rm -e PGPASSWORD -e RDS_HOST -v /opt/industrial_pm/dump:/dump postgres:16-alpine \
  sh -c 'pg_restore -h "$RDS_HOST" -U postgres -d industrial_pm \
          --no-owner --no-privileges /dump/industrial_pm-local-*.dump'

# verify
docker run --rm -e PGPASSWORD postgres:16-alpine \
  psql -h $RDS_HOST -U postgres -d industrial_pm -c \
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
  -e DATABASE_URL="postgresql://postgres:<pw>@$RDS_HOST:5432/industrial_pm" \
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

# the DB password must be PERCENT-ENCODED in DATABASE_URL (a raw '@' breaks it -> P1013).
# print the encoded form without echoing the password itself:
read -rs -p "RDS password: " PW; echo
docker run --rm -e PW="$PW" python:3-alpine   python -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['PW'],safe=''))"

vi .env.staging        # paste the ENCODED password into DATABASE_URL + the two secrets
chmod 600 .env.staging

# sanity check: exactly one '@' must remain in the line, and the host:port must be intact
awk -F'@' '/^DATABASE_URL/{print NF-1" at-signs (must be 1)"}' .env.staging
grep '^DATABASE_URL' .env.staging | sed -E 's|(://[^:]*:)[^@]*@|\1****@|'   # password masked; host:port must look right

# 5.2 build & start (the container runs `prisma migrate deploy` before the API boots)
docker compose -f docker-compose.staging.yml up -d --build

# 5.3 verify
docker logs -f engpro-staging-api        # expect: "EngPro API listening on :3000"; Ctrl-C
curl -s http://172.28.92.57:4010/api/v1/health
curl -s http://172.28.92.57:4010/api/v1/ready       # {"status":"ready"} = DB connection OK
curl -s http://172.28.92.57:4010/api/v1/workspace   # shows "KPN Downstream-Estimation Control"
```

> **The account in `DATABASE_URL` must be the same account that ran the restore** (step 4A.3),
> otherwise it authenticates fine but owns nothing and the API fails with
> `permission denied for table _prisma_migrations`. If you restored as `postgres`, the API must
> connect as `postgres` too — or grant the app account rights first (step 1.1 hand-over block).

`.env.staging` reference (template: `.env.staging.example`):

| Variable | Staging value |
|---|---|
| `DATABASE_URL` | `postgresql://postgres:<pw>@pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com:5432/industrial_pm?connection_limit=10` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | two different `openssl rand -hex 64` values |
| `CORS_ORIGIN` | `http://172.28.92.56:3060` |
| `COOKIE_SECURE` | `false` (staging is plain HTTP — `true` would break login) |
| `WORKSPACE_TZ` | `Asia/Jakarta` |

---

## 6. Deploy the frontend (FE server, 172.28.92.56)

```bash
cd /opt/industrial_pm/frontend

# The SPA must be built: dist/ is git-ignored, so a clone never contains it.
# Build it inside a container — no Node needed on the server:
docker run --rm -v /opt/industrial_pm/frontend:/app -w /app node:20-bookworm-slim   sh -c "npm ci --no-audit --no-fund && npm run build"

# (alternatives: `npm ci && npm run build` if Node is installed on the host, or ship your
#  laptop build:  scp -r frontend/dist/* root@172.28.92.56:/opt/industrial_pm/frontend/dist/ )

ls -la dist/index.html || echo "BUILD MISSING — build or upload dist/ first"

docker compose -f docker-compose.staging.yml up -d

# verify the SPA and the proxy chain end-to-end
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3060/          # 200
curl -s http://localhost:3060/api/v1/health                              # via proxy -> BE
```

Open **http://172.28.92.56:3060** in a browser — the login page must show the
company branding (proves FE → BE → RDS path). Log in and confirm the header dot says
**Live** (proves the `/ws` websocket proxy works).

---

## 7. Post-deployment hardening (on the **BE server**, do immediately)

> Every database command in this guide runs **on the BE server (172.28.92.57)** — it is the only
> host in the ApsaraDB whitelist, and the only one with `.env.staging`. The FE server has no
> database access by design.


The Option-A dump carries your **local** convenience passwords
(`Manager@2026!` / `ChangeMe123!`). Force everyone — including the manager — to set a
new password at first staging login, and drop any restored sessions:

```bash
cd /opt/industrial_pm/backend
docker run --rm --env-file .env.staging postgres:16-alpine \
  sh -c 'psql "${DATABASE_URL%%\?*}" \
    -c "UPDATE users SET must_change_password = true;" \
    -c "TRUNCATE refresh_tokens;"'
```

> **Tip — query staging without exporting anything.** Once `.env.staging` exists, reuse it instead
> of re-exporting `RDS_HOST`/`PGPASSWORD` in every new SSH session (forgetting them makes psql fail
> with `could not translate host name "-U"`, because `-h` swallows the next flag). The expansion
> `${DATABASE_URL%%\?*}` strips Prisma's `?connection_limit=…`, which libpq rejects — the
> `\?` escape is required, or the expansion returns an empty string:
>
> ```bash
> cd /opt/industrial_pm/backend
> docker run --rm --env-file .env.staging postgres:16-alpine \
>   sh -c 'psql "${DATABASE_URL%%\?*}" -c "SELECT count(*) FROM tickets;"'
> ```

At first login each user enters their old (local) password once and is forced to choose a
new one (min 10 chars). Afterwards, manage credentials only via *Settings → Users → Reset
password*.

**Sign-in uses the email address, not a username.** The legacy data had no emails, so the
migration backfills `<username>@engpro.local` (e.g. `manager@engpro.local`,
`rully@engpro.local`, `site.dumai@engpro.local`). Replace them with real addresses — either in
*Settings → Users*, or in bulk:

```bash
cd /opt/industrial_pm/backend
docker run --rm --env-file .env.staging postgres:16-alpine   sh -c 'psql "${DATABASE_URL%%\?*}" -c     "UPDATE users SET email = replace(email, '"'"'@engpro.local'"'"', '"'"'@yourcompany.com'"'"');"'

# list who can sign in and with which address
docker run --rm --env-file .env.staging postgres:16-alpine   sh -c 'psql "${DATABASE_URL%%\?*}" -c "SELECT full_name, email, role FROM users ORDER BY role, full_name;"'
```

Also confirm:
- [ ] BE port 4010 is **not** reachable from outside the FE server (`curl 172.28.92.57:4010` from your laptop should fail).
- [ ] RDS automated backups are enabled (console → *Backup and Restore*) — this is the staging backup story.
- [ ] `.env.staging` is `chmod 600` and never copied off the server.

---

## 8. Smoke-test checklist (10 minutes)

| # | As | Do | Expect |
|---|---|---|---|
| 1 | manager (`manager@engpro.local`) | Log in → forced password change → Dashboard | Real totals (≈226 tickets), workload cards |
| 2 | manager | Create a ticket | Number continues the series (no duplicates) |
| 3 | manager | Board: drag the new ticket to Done (assigned) | KPI toast; entry visible in KPI tab |
| 4 | manager | Settings → Roles | 4 role chips, Manager locked, matrix renders |
| 5 | estimator (e.g. `rully@engpro.local`) | My tickets / Team board / My KPI | Own queue, overdue banner, personal ledger |
| 6 | site admin (e.g. `site.dumai@engpro.local`) | My site tickets → open one → move deadline | Only own site visible; deadline saves |
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
| API logs `permission denied for table _prisma_migrations` | `DATABASE_URL` uses a different account than the one that restored the dump. Point it at the restore account (`postgres`), or grant the app account rights: `GRANT ALL ON SCHEMA public`, `GRANT ALL ON ALL TABLES/SEQUENCES IN SCHEMA public`, plus `ALTER DEFAULT PRIVILEGES` (step 1.1) |
| API logs `P1013 ... invalid port number in database URL` | The password in `DATABASE_URL` contains a character that breaks URL parsing (usually `@`, also `#/:?&%+`). Percent-encode it (`@`=`%40`, `#`=`%23`, `/`=`%2F`, `:`=`%3A`). Check with `awk -F'@' '/^DATABASE_URL/{print NF-1" at-signs"}' .env.staging` — it must print `1 at-signs` |
| API logs `P1001: Can't reach database server` | BE server IP missing from the RDS whitelist, or wrong host/password in `DATABASE_URL` |
| `permission denied to create extension "pg_trgm"` / `permission denied for schema public` | The account is a *standard* RDS account. Re-run as the instance's **privileged** account (`postgres`) — see step 1.1. Nothing is half-written when this happens: every statement fails, so the database is still empty and a plain re-run is safe |
| Login succeeds but immediately bounces back to login | `COOKIE_SECURE=true` on plain HTTP — must be `false` in staging |
| Header dot stays **Offline** | `/ws` proxy block missing/misconfigured in nginx, or security group blocks the FE→BE connection |
| `could not translate host name "-U" to address` | `RDS_HOST` is empty in this shell, so `-h` consumed the next flag — or you are on the **FE server**, which has no DB access. Run DB commands on the BE server. Re-export it, or use the `.env.staging` form shown in step 7 (`--env-file .env.staging` + `psql "${DATABASE_URL%%\?*}"`) |
| `connection to server on socket "/var/run/postgresql/..." failed` | `RDS_HOST` was empty, so `-h` got nothing and the client fell back to a local socket inside the container. `export RDS_HOST=...` and `export PGPASSWORD=...` in the **same** shell session as the `docker run` — `-e VAR` only forwards a variable that is actually set on the host |
| `pg_restore: could not open input file` | The dump was never uploaded to the server — do step **4A.1**. Docker creates an empty `/opt/industrial_pm/dump` when the host path does not exist, so the mount succeeds but the file is absent |
| `pg_restore` errors about roles/ownership | Add `--no-owner --no-privileges` (already in the command above) |
| Port already allocated on `up -d` | Another stack took 3060/4010 since the check — pick a new free port in the compose file (and update the nginx `proxy_pass` / security group accordingly) |
