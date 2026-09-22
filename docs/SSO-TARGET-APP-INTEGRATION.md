# SSO Target App Integration (Strict OIDC Contract)

This document is for downstream applications integrating with Downstream Hub after strict security enforcement.

In strict mode:

- Bridge flow is disabled (`/api/sso/bridge` returns `410`)
- OIDC authorization code + PKCE is required
- ID tokens are signed with asymmetric keys and verified via JWKS

---

## 1) Required endpoints on Hub

- `GET /api/sso/.well-known/openid-configuration`
- `GET /api/sso/authorize`
- `POST /api/sso/token`
- `GET /api/sso/jwks`

---

## 2) Authorization request requirements

Your app (or Hub launch handoff) must provide:

- `response_type=code`
- `client_id`
- `redirect_uri` (must exactly match one configured in Hub)
- `code_challenge` (PKCE S256)
- `code_challenge_method=S256`
- optional `state`, `nonce`, `scope`

Hub validates `client_id` and `redirect_uri` against the app registration.

---

## 3) Token exchange requirements

Call token endpoint:

`POST /api/sso/token` with JSON:

```json
{
  "grant_type": "authorization_code",
  "code": "AUTH_CODE",
  "redirect_uri": "https://app.example.com/auth/callback",
  "client_id": "your-client-id",
  "code_verifier": "PKCE_VERIFIER"
}
```

Successful response:

```json
{
  "token_type": "Bearer",
  "expires_in": 60,
  "id_token": "JWT",
  "scope": "openid profile email"
}
```

---

## 4) ID token validation rules

Validate `id_token` with JWKS and enforce all:

- Signature valid for active `kid`
- `iss` matches Hub issuer from discovery doc
- `aud` equals your `client_id`
- `exp` not expired
- `sub` exists

Use `sub` as canonical user key. Use `email`/`name` as profile attributes only.

---

## 5) Claims you should expect

| Claim | Description |
|------|-------------|
| `sub` | Stable Hub user UUID (primary key) |
| `user_id` | Backward-compatible duplicate of `sub` |
| `email` | User email |
| `name` | Display name |
| `iss` | Hub issuer URL |
| `aud` | Target app client id |
| `iat` | Issued at |
| `exp` | Expiration |

---

## 6) App registration checklist in Hub

For each target app in Hub Admin:

- `sso_mode` = `oidc`
- `oauth_client_id` is set and unique
- `oidc_redirect_uris` includes every valid callback URI

If not configured, Hub launch returns an enforcement error.

---

## 7) Node.js verification example (jose)

```js
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'http://localhost:4000';
const CLIENT_ID = process.env.OIDC_CLIENT_ID;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/api/sso/jwks`));

export async function verifyIdToken(idToken) {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: ISSUER,
    audience: CLIENT_ID,
  });
  if (!payload.sub) throw new Error('Missing sub');
  return payload;
}
```

---

## 8) Common failures

- `invalid_grant` from token endpoint:
  - wrong `redirect_uri`
  - wrong `client_id`
  - wrong `code_verifier`
  - reused/expired code

- ID token verification fails:
  - stale JWKS cache
  - incorrect `iss`/`aud` check
  - validating with HS256 logic instead of JWKS-based verification

- Hub dashboard shows enforcement message:
  - app is not configured as `sso_mode=oidc`

---

## 9) Runtime sanity checks

```bash
curl -i http://localhost:4000/api/sso/jwks
curl -i http://localhost:4000/api/sso/.well-known/openid-configuration
curl -i http://localhost:4000/api/sso/bridge
```

Expected in strict mode:

- `jwks` -> `200`
- `openid-configuration` -> `200`
- `bridge` -> `410`
