# EngPro — Estimation Ticket Management (Production Rebuild)

Implements **PRD v2.0** and **Technical Documentation v1.0** (both in this repo root):
React 18 + Nginx · NestJS 10 + Prisma · PostgreSQL 16 · socket.io realtime · JWT + Argon2id auth.

## Repository layout

```
backend/     NestJS API — auth, users, sites, workspace, tickets, notes, kpi, roles, audit, events
             + Dockerfile, docker-compose.staging.yml, .env.staging.example, Prisma schema/migrations/ETL
frontend/    React SPA (Vite + TanStack Query + socket.io-client)
             + nginx/{local,staging}.conf, docker-compose.staging.yml
infra/       docker-compose.local.yml — the all-in-one local stack (db + backend + frontend)
docs/        legacy system source + screenshots the PRDs were derived from
deploy/      database dumps for migration (git-ignored)
db/          legacy Supabase CSV export (git-ignored — contains real data)
```

Backend and frontend are independently deployable: in staging the FE server only needs
`frontend/`, the BE server only needs `backend/`. See **[DEPLOY_STAGING.md](DEPLOY_STAGING.md)**.

## Run locally (Docker)

```bash
cd frontend && npm install && npm run build && cd ..      # build the SPA (served by nginx)
docker compose -f infra/docker-compose.local.yml up -d --build

# one-time: migrate the legacy Supabase CSV export (db/ folder) into the stack
cd backend && npm install
DATABASE_URL=postgresql://engpro:engpro@localhost:5440/engpro npx ts-node -T prisma/seed-legacy.ts
```

Open **http://localhost:8090**

| Account | Username | Password (local seed) |
|---|---|---|
| Manager | `manager` | `Manager@2026!` |
| Estimators | `rully`, `sajali`, `wahyu`, `yohana`, `danu`, `luqman`, `halomoan`, `sumiardi` | `ChangeMe123!` |
| Office admins | `seila`, `faktul`, `sumiardi_mgr`, `rull_y` | `ChangeMe123!` |
| Site admins | `site.dumai`, `site.medan`, `site.bontang`, … | `ChangeMe123!` |

> Local convenience only: seeded users skip the forced password change. For a real
> cutover set SEED_* env vars and enable `must_change_password` in the seed.

## Frontend development

```bash
cd frontend && npm run dev      # Vite dev server on :5173, proxies /api and /ws to :3000
```

## Tests

```bash
# dev Postgres for tests (once): docker run -d --name engpro-dev-db -p 5439:5432 \
#   -e POSTGRES_USER=engpro -e POSTGRES_PASSWORD=engpro -e POSTGRES_DB=engpro postgres:16-alpine
#   then: docker exec engpro-dev-db psql -U engpro -c "CREATE DATABASE engpro_test;"
cd backend
DATABASE_URL=postgresql://engpro:engpro@localhost:5439/engpro_test npx prisma migrate deploy
npm run test:e2e     # 67 tests: auth, RBAC, roles matrix, numbering race, locking, KPI engine, audit
```

## Configurable role permissions (Settings → Roles)

Managers can configure, per role (Admin / Site Admin / Estimator — Manager is locked to full
access to prevent lockouts):

- **Page & tab access** — Dashboard, Board, All tickets, My tickets, KPI, My KPI, each Settings tab.
- **View / Create / Edit / Delete** per page or data area (only applicable actions are offered).
- **Task scope** — the role sees *all tickets* or *only tickets assigned to or created by the user*
  (Site Admins are additionally always hard-limited to their own site).

Enforced server-side (`role_configs` table + `PermGuard`); defaults mirror the originally shipped
behaviour; changes propagate live to signed-in users via the `roles.updated` socket event; every
change is audited and can be restored to defaults per role. Fixed safety envelopes remain on top of
the matrix: Estimator edit = status of own assignments; Site Admin edit = required-by date,
delete = own NEW tickets only.

## Key guarantees (vs the legacy prototype)

- Ticket numbers from an atomic per-workspace sequence — 20-way parallel-create test proves uniqueness (legacy had 32 duplicated numbers, repaired at migration with `legacy_ticket_no` kept).
- One KPI auto-award per ticket enforced by a partial unique index; reversal entries on reopen; award happens inside the status-change transaction.
- Optimistic locking (`version`) → 409 on concurrent edits.
- Server-side RBAC per field; site admins are hard-scoped to their site.
- Soft delete + restore + full audit trail.
- No secrets in the client bundle; per-user Argon2id credentials; rotating refresh tokens.
