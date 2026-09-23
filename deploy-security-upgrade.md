# Staging upgrade — security hardening release (commit `36ca5f8`)

A one-off runbook for the release that closes the 16 architecture review findings. Read
`SECURITY_HARDENING.md` for *why*; this is the *how*, in order, with the checks that matter.

Budget 25–30 minutes. Nothing here is destructive, and every step is reversible by
`git checkout f496388` + rebuild.

---

## What makes this release different from a normal update

1. **Three database migrations** run automatically on container start. One of them backfills
   every existing user and ticket into a new "internal company". If that backfill does not
   happen, users see **nothing** — the tenancy scope fails closed by design. Step 4 verifies it.
2. **The login contract changed.** An MFA-enabled account now returns a challenge instead of a
   session. A new frontend against an old backend cannot handle it, so **deploy the backend
   first**.
3. **New environment variables.** All have safe defaults, so a missing one will not break the
   deploy — but `DEPLOY_ENV` and `TRUST_PROXY` are worth setting deliberately.

> **Do not set `DEPLOY_ENV=production` on staging.** Staging is plain HTTP, and production
> mode refuses to start without TLS. That is the intended behaviour. Use `staging`.

---

## 1. Backend: update the environment file

On the **BE server (172.28.92.57)**:

```bash
cd /opt/industrial_pm/backend
cp .env.staging .env.staging.bak.$(date +%F)     # keep a way back
```

Append the new block (nothing existing needs changing):

```bash
cat >> .env.staging <<'EOF'

# ── security hardening release ──────────────────────────────────────
# local | staging | production. Production refuses to boot without TLS;
# staging logs the same checks as warnings. Staging is HTTP, so: staging.
DEPLOY_ENV=staging

# Proxies in front of the API that append to X-Forwarded-For.
# browser -> edge nginx (FE host) -> app nginx (:3060) -> API  = 2
# Verified in step 6: the audit log must show YOUR address, not 172.28.92.x
TRUST_PROXY=2

# Rate limits (requests per minute)
THROTTLE_GLOBAL=120
THROTTLE_HEAVY=30

# Cumulative failed logins before lockout, and for how long
LOCKOUT_THRESHOLD=10
LOCKOUT_MINUTES=15

# Two-factor. Start OPTIONAL so you can try enrolment without the risk of
# locking every manager out of staging. Switch to required in step 7.
MFA_POLICY=optional
MFA_ISSUER=EngPro Staging
EOF

grep -c . .env.staging    # sanity: the file grew
```

---

## 2. Backend: pull and rebuild

```bash
cd /opt/industrial_pm && git pull
cd backend && docker compose -f docker-compose.staging.yml up -d --build
```

The image build takes a few minutes (a new dependency, `qrcode`, is added for the
two-factor QR codes).

---

## 3. Backend: read the startup log

```bash
docker compose -f docker-compose.staging.yml logs --tail=80 api
```

**Four things must be true.** If any is missing, stop and fix it before going further:

| Look for | Expected |
|---|---|
| Migrations | `3 migrations found` … applied, no error |
| Route policy | `Authorisation policy: NN routes, 0 undeclared.` |
| Startup line | `DEPLOY_ENV=staging, cookieSecure=false, trustProxy=2, cors=http://test-ind-pm.kpndomain.com` |
| Company warning | **No** line saying *"N active user(s) have no company"* |

You will also see three `WARN [Security]` lines about plaintext HTTP. **Those are correct on
staging** — they are the checks that would abort a production boot, shown as warnings here.

---

## 4. Verify the tenancy backfill (the one that can lock people out)

Still on the BE server:

> **Do not `source` this env file.** Several values contain unquoted spaces
> (`SSO_SCOPE=openid profile email`, `SSO_BUTTON_LABEL=Continue with DWS Hub`,
> `MFA_ISSUER=EngPro Staging`), so `. ./.env.staging` sets the first word and then tries to
> run the rest as commands — `profile: command not found`. Docker’s `--env-file` does not
> shell-parse, so pass the file to the container instead:

```bash
docker run --rm --env-file /opt/industrial_pm/backend/.env.staging postgres:16-alpine sh -c 'psql "${DATABASE_URL%%\?*}" -c "SELECT c.name, c.is_internal, (SELECT count(*) FROM users u WHERE u.company_id=c.id) AS users, (SELECT count(*) FROM tickets t WHERE t.company_id=c.id) AS tickets FROM companies c;"'
```

Expect **one row**, `is_internal = t`, named after your workspace, with roughly **24 users**
and **226 tickets**.

Then confirm nothing was left behind:

```bash
docker run --rm --env-file /opt/industrial_pm/backend/.env.staging postgres:16-alpine sh -c 'psql "${DATABASE_URL%%\?*}" -tc "SELECT count(*) FROM users WHERE company_id IS NULL AND is_active;"'
```

**Must be `0`.** Anything else means those accounts will see an empty application. Fix with:

```bash
docker run --rm --env-file /opt/industrial_pm/backend/.env.staging postgres:16-alpine sh -c 'psql "${DATABASE_URL%%\?*}" -c "UPDATE users u SET company_id = c.id FROM companies c WHERE c.workspace_id = u.workspace_id AND c.is_internal AND u.company_id IS NULL;"'
```

---

## 5. Frontend: deploy (immediately after the backend)

On the **FE server (172.28.92.56)**.

> **`docker compose --build` does nothing here.** The frontend compose has no build section:
> it mounts `./dist` and `./nginx/staging.conf` into a stock nginx image. `dist/` is
> git-ignored, so `git pull` does **not** update the SPA — it has to be built explicitly. And
> because only a mounted file changed (not the compose definition), `up -d` considers the
> container current and leaves nginx running with its old config in memory. Hence the
> explicit build and `--force-recreate` below.

```bash
cd /opt/industrial_pm && git pull
```

Build the SPA inside a container — no Node needed on the host:

```bash
cd /opt/industrial_pm/frontend && docker run --rm -v /opt/industrial_pm/frontend:/app -w /app node:20-bookworm-slim sh -c "npm ci --no-audit --no-fund && npm run build"
```

Confirm the build produced the new bundle, then recreate the container so nginx re-reads the
config that carries the Content-Security-Policy:

```bash
cd /opt/industrial_pm/frontend && ls -la dist/index.html && grep -o 'assets/index-[^"]*\.js' dist/index.html && docker compose -f docker-compose.staging.yml up -d --force-recreate
```

Now verify what is actually being served, and that the headers arrive through the edge:

```bash
curl -s http://localhost:3060/ | grep -o 'assets/index-[^"]*\.js' && curl -sI http://test-ind-pm.kpndomain.com/ | grep -iE 'content-security-policy|x-frame-options|referrer-policy'
```

The bundle hash must match the one `dist/index.html` reports, and all three headers must be
present. If the headers are missing but the bundle is right, nginx did not reload — recreate
the container again.

Then **hard-refresh the browser (Ctrl+Shift+R)** — assets are cached `immutable` for a year.

---


## 6. Verify TRUST_PROXY — the check people skip

Sign in at `http://test-ind-pm.kpndomain.com`, then open **Settings → Audit trail**.

The IP column on your own `login` entry must show **your workstation's address**, not
`172.28.92.x`. If it shows the proxy, `TRUST_PROXY` is too low; if a client can spoof it, too
high. Adjust and restart the API.

This matters more than it looks: every per-IP rate limit and every audit record depends on it.

---

## 7. Try two-factor, then decide

1. **Settings → Security** → *Set up two-factor authentication*.
2. Scan the QR with any authenticator app, enter the 6-digit code.
3. **Save the ten backup codes** — they are shown once.
4. Sign out and back in: the password alone should now produce a code prompt.
5. Verify a backup code works, and that it stops working the second time.

Once you are satisfied, make it mandatory for privileged roles:

```bash
# BE server
echo 'MFA_REQUIRED_ROLES=MANAGER,ADMIN' >> .env.staging
sed -i 's/^MFA_POLICY=optional/MFA_POLICY=required/' .env.staging
docker compose -f docker-compose.staging.yml restart api
```

> Every MANAGER and ADMIN is then pushed through enrolment on their next sign-in and cannot
> use the application until they finish. Tell them first.
>
> **Federated sign-in bypasses this by design** — DWS Hub owns authentication strength for
> those users. The API logs a reminder at boot.

---

## 8. Try an external company (the AR-03 feature)

1. **Settings → Companies → Add company** — e.g. *Acme Contractors*.
2. **Settings → Users → Add user** — a **Company** field now appears; pick Acme.
3. Activate that account from its invitation email.
4. Sign in as it and confirm it sees **no tickets**, only itself in the directory, and a 404
   if you paste a KPN ticket URL.

Deactivating a company signs out all of its users and keeps their tickets.

---

## 9. Smoke test

| Check | Expected |
|---|---|
| Sign in with email + password | Works |
| Sign in with DWS Hub | Works, straight into the app |
| Board, Tickets, KPI, Dashboard | Load, counts unchanged (226 tickets) |
| Create a ticket | Gets the next `EST-` number |
| Settings → Audit | New entries appear, IP column correct |
| Settings → Companies | One row, your organisation, 24 users / 226 tickets |
| `curl -sI` the domain | `Content-Security-Policy` present |
| 30 rapid refreshes of Tickets | Eventually `429` with `Retry-After` |

---

## 10. Rollback

```bash
cd /opt/industrial_pm && git checkout f496388
cd backend  && docker compose -f docker-compose.staging.yml up -d --build
cd ../frontend && docker compose -f docker-compose.staging.yml up -d --build
cp backend/.env.staging.bak.* backend/.env.staging     # restore the old env
```

The new columns and tables stay in the database. They are additive and the old code ignores
them, so a rollback needs no schema change. For data, use RDS point-in-time restore.

---

## 11. What is still outstanding after this deploy

These are infrastructure actions this release cannot perform for you. Staging is fine without
them; **production is not**:

1. **TLS** — a real certificate plus `frontend/nginx/edge-vhost-tls.conf.example`. Until then
   passwords, session cookies and OIDC codes travel in clear text.
2. **Least-privilege database role** — `backend/prisma/sql/create-app-role.sql`, then split
   `DATABASE_URL` / `MIGRATE_DATABASE_URL`. The app currently runs as the RDS superuser and
   can rewrite its own audit trail.
3. **Rotate both JWT secrets** — they have been on disk and in deployment transcripts.
4. **Off-host audit copy** — the hash chain makes edits detectable, not impossible.

`SECURITY_HARDENING.md` has the commands for each.
