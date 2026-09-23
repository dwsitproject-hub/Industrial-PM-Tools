# Security hardening — what changed and what you must do

Companion to `EngPro_Security_PenTest_and_Architecture_Review_v1.0.docx`. That document
identified 16 architecture findings (AR-01…AR-16) against the application as it stood. This
one records what has been fixed in the code, and what remains an **operator action** —
because several findings cannot be closed by code alone.

Read this before the next staging deploy: some settings are new and one of them will stop a
production deployment from starting if it is wrong. That is deliberate.

---

## 1. The short version

| Finding | Status | What you have to do |
|---|---|---|
| AR-01 no TLS | Code + config ready | Install a certificate and the TLS vhost (§3) |
| AR-02 no global rate limiting | **Fixed** | Optionally tune `THROTTLE_*` |
| AR-03 single-tenant assumptions | **Fixed** | Add each external company in Settings → Companies (§7) |
| AR-04 no MFA | **Fixed** | Set `MFA_POLICY=required` and have managers enrol (§4) |
| AR-05 account enumeration | **Fixed** | Nothing |
| AR-06 restore behind a read permission | **Fixed** | Re-check your Roles matrix (§5) |
| AR-07 undeclared authorisation | **Fixed** | Nothing |
| AR-08 JWT algorithms not pinned | **Fixed** | Nothing |
| AR-09 CORS fail-open | **Fixed** | Make sure `CORS_ORIGIN` is set |
| AR-10 no CSP | **Fixed** | Redeploy the frontend |
| AR-11 HTML injection in email | **Fixed** | Nothing |
| AR-12 audit not tamper-evident | **Fixed** | Schedule `prune-audit.sql`; ship logs off-host (§6) |
| AR-13 secret handling | Partly fixed | Rotate secrets, move them off disk (§8) |
| AR-14 test-email relay | **Fixed** | Nothing |
| AR-15 no account lockout | **Fixed** | Tune `LOCKOUT_*` if 10/15min does not suit |
| AR-16 privileged database account | Code + script ready | Run `create-app-role.sql` and split the URLs (§2) |
| PT-F03 CSV formula injection | **Fixed** | Nothing |

Everything marked **Fixed** has a regression test in `backend/test/` named after the finding,
so a future change that reopens one fails the suite rather than shipping.

---

## 2. AR-16 — stop running the app as the database superuser

The API currently connects to ApsaraDB as `postgres`. Any compromise of the API container
escalates straight to full database control, including the power to rewrite the audit trail
that would record it.

```bash
# 1. On the backend server, create the least-privilege role (run once, as postgres):
psql "postgresql://postgres:<pw>@<host>:5432/industrial_pm" \
     -v app_password='<a-new-strong-password>' \
     -f backend/prisma/sql/create-app-role.sql
```

The script prints the resulting grants. `audit_log` must show **INSERT, SELECT** only — that
is the check that matters.

```bash
# 2. Split the connection strings in .env.staging (percent-encode both passwords):
DATABASE_URL=postgresql://industrial_pm_app:<pw>@<host>:5432/industrial_pm?connection_limit=10
MIGRATE_DATABASE_URL=postgresql://postgres:<pw>@<host>:5432/industrial_pm
```

The container entrypoint runs migrations with `MIGRATE_DATABASE_URL` when it is present and
the application itself with `DATABASE_URL`. If you omit `MIGRATE_DATABASE_URL` nothing breaks
— both fall back to `DATABASE_URL`, exactly as before.

> Consequence: the app can no longer delete audit records. That is the point. Retention moves
> to scheduled maintenance — see §6.

---

## 3. AR-01 — TLS

Nothing else on this list matters until this is done. Over plain HTTP, passwords, session
cookies, OIDC authorization codes and activation links are all readable by anyone on the path.

```bash
# on the frontend server
sudo certbot certonly --nginx -d ind-pm.kpndomain.com
sudo openssl dhparam -out /etc/nginx/dhparam.pem 2048
sudo cp frontend/nginx/edge-vhost-tls.conf.example /etc/nginx/conf.d/ind-pm.conf
# edit the hostname in that file, then:
sudo nginx -t && sudo systemctl reload nginx
```

Then, on the backend, switch every URL to `https://` and turn the enforcement on:

```
DEPLOY_ENV=production
COOKIE_SECURE=true
APP_BASE_URL=https://ind-pm.kpndomain.com
CORS_ORIGIN=https://ind-pm.kpndomain.com
SSO_REDIRECT_URI=https://ind-pm.kpndomain.com/api/v1/auth/sso/callback
TRUST_PROXY=2
HSTS_MAX_AGE=300
```

Re-register the new redirect URI in DWS Hub Admin, or SSO will fail with `token_invalid`.

**The API will refuse to start** with `DEPLOY_ENV=production` if any of these is still
plaintext, if the JWT secrets are short or identical, or if `CORS_ORIGIN` is missing. The
error message names each problem. If you genuinely need a plaintext install, use
`DEPLOY_ENV=staging` — the same checks then log as warnings and the app starts.

### TRUST_PROXY

Set it to the number of proxies in front of the API that append to `X-Forwarded-For`
(edge nginx + app nginx = 2 in the current staging topology). Too low and every rate limit
and audit entry records the proxy's address instead of the user's; too high and a client can
forge its own address. **Verify after deploying:** sign in, then open Settings → Audit. The
IP column must show your workstation address, not `172.28.92.x`.

---

## 4. AR-04 — multi-factor authentication

Users enrol themselves at **Settings → Security** using any authenticator app. The page shows
a QR code, verifies one code before switching MFA on, and then issues ten single-use backup
codes — shown once.

```
MFA_POLICY=required          # required | optional | off
MFA_REQUIRED_ROLES=MANAGER,ADMIN
MFA_ISSUER=EngPro
# optional: a dedicated key for encrypting TOTP secrets at rest.
# Defaults to a value derived from JWT_REFRESH_SECRET.
MFA_SECRET_KEY=<openssl rand -hex 32>
```

With `MFA_POLICY=required`, a listed role that has not enrolled gets `403
MfaEnrollmentRequired` on every route except the enrolment ones, `/auth/me` and logout — so
they are pushed through setup on first sign-in and cannot skip it.

> **Federated sign-in bypasses this by design.** When a user signs in through DWS Hub, Hub owns
> authentication strength; EngPro's own second factor is not consulted. If you set
> `MFA_POLICY=required`, confirm Hub enforces MFA for these accounts too, otherwise the SSO
> button is a way around the requirement. The API logs this warning at every boot.

Rotating `MFA_SECRET_KEY` (or `JWT_REFRESH_SECRET`, when no dedicated key is set) invalidates
every enrolment and everyone must re-enrol. That is the safe direction to fail in, but plan
for it.

---

## 5. AR-06 — re-check your Roles matrix

Restoring a deleted ticket used to be gated on **audit visibility**. It now requires
`tickets.delete`, and the restore is additionally scoped to the tickets the role can reach —
a site admin can no longer resurrect another site's ticket by id.

Open **Settings → Roles** and confirm the roles you had given audit visibility to are the ones
you actually want able to bring deleted tickets back. For most workspaces this changes
nothing; if you had a supervisor role with audit access, it has quietly lost a power it was
never meant to have.

---

## 6. AR-12 — the audit trail

Every audit record now carries the hash of the previous record for its workspace. Editing or
deleting an entry breaks the chain from that point on, and the break is detectable.

Records written before this upgrade have no hash. They are reported as `unchained` rather than
as tampering, so the trail stays readable across the upgrade.

**Retention.** The application can no longer delete audit rows (§2), so retention is a
scheduled task:

```bash
# monthly, as the privileged account
psql "postgresql://postgres:<pw>@<host>:5432/industrial_pm" \
     -v days=400 -f backend/prisma/sql/prune-audit.sql
```

Pruning necessarily breaks the chain at the boundary — the script prints the hash of the
oldest surviving record so you can keep verifying from there. Record it.

**This is tamper-evidence, not tamper-proofing.** Someone with sustained database access can
recompute the whole chain. The control that actually closes that is shipping audit events to
append-only storage off the host (SIEM, or a write-only log sink). Treat the hash chain as the
thing that makes quiet, single-row edits detectable, and the off-host copy as the real
protection. That copy is still outstanding.

---

## 7. AR-03 — tenancy (company-scoped records)

**Model B was chosen: one workspace, every record owned by a company.** Exactly one company
is INTERNAL — your organisation — and its users are unscoped, exactly as they are today.
Every other company is external, and its users are hard-scoped to their own records by the
same mechanism that already confines a SITE_ADMIN to one site.

Nothing changes for existing users. The migration creates the internal company from your
workspace name and attributes every existing user and ticket to it.

### What an external user can and cannot see

| | External user |
|---|---|
| Tickets, notes | Only their own company's. Another company's ticket answers **404**, not 403, so its existence is not disclosed |
| Search, listings, stats, exports | Computed within their company; totals do not leak your volume |
| People | Their own company's directory only — never your staff list |
| KPI | Their own company's members only; they cannot award points outside it |
| Audit trail | Their own company's activity only |
| Realtime | A company room, never the workspace room — they do not even learn that your work is happening |
| Companies | Their own only; they cannot create, rename or deactivate any |

The scope is an **identity constraint, not a permission**. It is not configurable in
Settings → Roles and a manager cannot widen it, because the entire point is that no
permission mistake can expose one customer's tenders to another. An external user holding the
MANAGER role still sees nothing outside their company.

### Onboarding a company

1. **Settings → Companies → Add company.**
2. **Settings → Users → Add user**, and pick the company in the new Company field. (The field
   only appears once at least one external company exists.)
3. The user activates by email as usual.

Deactivating a company signs out and disables every user in it, and keeps their tickets.

### How it fails

A user with **no** company is treated as external and sees nothing. That is deliberate: the
alternative — treating a missing company as internal — turns a data anomaly into a
cross-company disclosure. The API logs a warning at boot naming how many active accounts are
in that state, so the anomaly is loud rather than a support ticket.

### Verification

`backend/test/tenancy.e2e-spec.ts` is the PT-E series from the assessment, run against two
live external tenants plus the internal one: 31 tests covering object access, listing and
search leakage, stats, exports, KPI, tenant forgery, realtime rooms, administrative blast
radius and company deactivation. It was also exercised by hand against the real migrated data
(226 tickets, 24 users) with an external MANAGER account, which saw 0 tickets, 0 KPI members,
1 user (itself) and got 404 on every KPN ticket id.

### Residual, and accepted

Email addresses are the login identifier and are therefore unique across the whole
installation. If an external administrator tries to register an address that already exists
anywhere, they get a conflict — which tells them the address is in use **somewhere**, though
never whose it is. That is inherent to a shared login namespace under this model. If it ever
matters, the alternative is Model A (a workspace per company) with per-workspace email
uniqueness and host-based workspace resolution.

## 8. AR-13 — secrets

Still plaintext in `.env.staging` on the backend host, and visible to anyone who can run
`docker inspect`. Partly addressed: the API now refuses to start in production with short or
identical JWT secrets.

Outstanding operator actions:

1. **Rotate both JWT secrets now** — they have been on disk, in a shell history and in a
   deployment transcript. `openssl rand -hex 64`, twice, different values. Rotating invalidates
   every session; users sign in again.
2. Move secrets to Docker secrets or a secret manager rather than an env file.
3. Set a rotation schedule, and rotate on any staff change affecting server access.
4. Never put secrets in the repository. `.gitignore` already excludes `.env*`; the
   `.env.*.example` templates are the only ones committed.

---

## 9. New environment variables

Added by this work. All have safe defaults, so an existing `.env.staging` keeps working.

| Variable | Default | Purpose |
|---|---|---|
| `DEPLOY_ENV` | inferred | `local`/`staging`/`production`; production enforces the TLS checks |
| `TRUST_PROXY` | `0` | Proxy hops in front of the API |
| `HSTS_MAX_AGE` | `15552000` in production | Strict-Transport-Security on API responses |
| `THROTTLE_GLOBAL` | `120` | Requests/min per user on ordinary routes |
| `THROTTLE_HEAVY` | `30` | Requests/min for search, listings, export, SSO start |
| `THROTTLE_LIMIT` | `5` | Failed logins/min per (IP, account) |
| `LOCKOUT_THRESHOLD` | `10` | Cumulative failures before lockout |
| `LOCKOUT_MINUTES` | `15` | Lockout duration |
| `MFA_POLICY` | `optional` | `required`/`optional`/`off` |
| `MFA_REQUIRED_ROLES` | `MANAGER,ADMIN` | Roles obliged to enrol |
| `MFA_ISSUER` | `EngPro` | Name shown in the authenticator app |
| `MFA_SECRET_KEY` | derived | Encrypts TOTP secrets at rest |
| `MFA_CHALLENGE_TTL` | `5m` | Lifetime of the between-factors token |
| `MAIL_TEST_ALLOWLIST` | empty | Extra recipients for `POST /mail/test` |
| `AUDIT_RETENTION_DAYS` | unset | Only used if the DB account can delete |
| `MIGRATE_DATABASE_URL` | unset | Privileged URL used for migrations only |

No new variables are needed for tenancy — companies are managed in the UI.

---

## 10. Deployment order

Both sides change, and the login contract changes with them. Deploy backend first, frontend
immediately after — a new frontend against an old backend will not know what to do with an
MFA challenge.

```bash
# backend server
cd /opt/industrial_pm && git pull
cd backend
# edit .env.staging: add the §9 variables you want
docker compose -f docker-compose.staging.yml up -d --build
docker compose -f docker-compose.staging.yml logs -f api | head -40   # check the Security lines
```

```bash
# frontend server
cd /opt/industrial_pm && git pull
cd frontend
docker compose -f docker-compose.staging.yml up -d --build
curl -sI http://test-ind-pm.kpndomain.com/ | grep -i content-security-policy
```

### Post-deploy checks

1. The API startup log prints `DEPLOY_ENV`, `cookieSecure`, `trustProxy` and the CORS list —
   read it and confirm it says what you expect.
2. Sign in, then check Settings → Audit: the IP column must show a real client address
   (validates `TRUST_PROXY`).
3. Settings → Security: enrol one account, then sign out and back in to confirm the challenge.
4. `curl -sI` the frontend and confirm `Content-Security-Policy` is present.
5. Confirm the app still starts after switching `DATABASE_URL` to the restricted role, and
   that creating a ticket still writes an audit record.
6. Settings → Companies shows your organisation with the right user and ticket counts, and
   the boot log reports **0 users without a company**.
