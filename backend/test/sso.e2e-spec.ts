import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import cookieParser from 'cookie-parser';
import express from 'express';
import * as http from 'http';
import { createHash, randomBytes } from 'crypto';
import { SignJWT, exportJWK, generateKeyPair, KeyLike } from 'jose';
import request from 'supertest';

/**
 * Exercises the full DWS Hub contract against a stand-in Hub:
 * discovery -> authorize (PKCE S256) -> JSON token endpoint -> RS256 id_token verified via JWKS.
 */
const prisma = new PrismaClient();

const CLIENT_ID = 'engpro-staging';
let hubServer: http.Server;
let hubUrl = '';
let privateKey: KeyLike;
let publicJwk: any;
const KID = 'hub-test-key-1';

/** what the stand-in Hub will assert about the next user to sign in */
let identity = { sub: 'hub-uuid-alice', email: 'alice@test.local', name: 'ALICE' };
/** lets a test force a bad signature or audience */
let tamper: 'none' | 'wrong-aud' | 'wrong-issuer' = 'none';

const codes = new Map<string, { challenge: string; nonce?: string; redirectUri: string; used: boolean }>();

async function startMockHub(): Promise<void> {
  const { privateKey: priv, publicKey } = await generateKeyPair('RS256');
  privateKey = priv;
  publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

  const app = express();
  app.use(express.json());

  app.get('/api/sso/.well-known/openid-configuration', (_req, res) => {
    res.json({
      issuer: hubUrl,
      authorization_endpoint: `${hubUrl}/api/sso/authorize`,
      token_endpoint: `${hubUrl}/api/sso/token`,
      jwks_uri: `${hubUrl}/api/sso/jwks`,
    });
  });

  app.get('/api/sso/jwks', (_req, res) => res.json({ keys: [publicJwk] }));

  app.get('/api/sso/authorize', (req, res) => {
    const q = req.query as Record<string, string>;
    if (q.client_id !== CLIENT_ID) return res.status(400).json({ error: 'invalid_client' });
    if (q.response_type !== 'code') return res.status(400).json({ error: 'unsupported_response_type' });
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return res.status(400).json({ error: 'invalid_request', detail: 'PKCE S256 required' });
    }
    const code = randomBytes(12).toString('hex');
    codes.set(code, { challenge: q.code_challenge, nonce: q.nonce, redirectUri: q.redirect_uri, used: false });
    const back = new URL(q.redirect_uri);
    back.searchParams.set('code', code);
    if (q.state) back.searchParams.set('state', q.state);
    res.redirect(back.toString());
  });

  app.post('/api/sso/token', async (req, res) => {
    const b = req.body || {};
    const entry = codes.get(b.code);
    if (b.grant_type !== 'authorization_code' || !entry || entry.used) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    if (b.client_id !== CLIENT_ID || b.redirect_uri !== entry.redirectUri) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    const derived = createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
    if (derived !== entry.challenge) return res.status(400).json({ error: 'invalid_grant', detail: 'PKCE mismatch' });
    entry.used = true;

    const id_token = await new SignJWT({
      user_id: identity.sub, email: identity.email, name: identity.name,
      ...(entry.nonce ? { nonce: entry.nonce } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setSubject(identity.sub)
      .setIssuer(tamper === 'wrong-issuer' ? 'http://somewhere.else' : hubUrl)
      .setAudience(tamper === 'wrong-aud' ? 'another-app' : CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(privateKey);

    res.json({ token_type: 'Bearer', expires_in: 60, id_token, scope: 'openid profile email' });
  });

  await new Promise<void>((resolve) => {
    hubServer = app.listen(0, '127.0.0.1', () => {
      const addr = hubServer.address() as any;
      hubUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

let app: INestApplication;
let http_: any;
let ws: any;
const PW = 'Password10!';

/** Drives start -> Hub authorize -> callback, exactly as a browser would. */
async function ssoRoundTrip(agent: any) {
  const start = await agent.get('/api/v1/auth/sso/start');
  expect(start.status).toBe(302);
  const authorizeUrl = start.headers.location as string;
  const hubRes = await fetch(authorizeUrl, { redirect: 'manual' });
  const back = hubRes.headers.get('location');
  if (!back) return { start, callback: null as any, authorizeUrl, hubStatus: hubRes.status };
  const cb = new URL(back);
  const callback = await agent.get(`/api/v1/auth/sso/callback${cb.search}`);
  return { start, callback, authorizeUrl, hubStatus: hubRes.status };
}
const errorOf = (res: any) => new URL(res.headers.location, 'http://x').searchParams.get('sso_error');

beforeAll(async () => {
  await startMockHub();

  process.env.SSO_ENABLED = 'true';
  process.env.SSO_ISSUER = hubUrl;
  process.env.SSO_CLIENT_ID = CLIENT_ID;
  process.env.SSO_REDIRECT_URI = 'http://127.0.0.1:9/api/v1/auth/sso/callback';
  process.env.SSO_AUTO_PROVISION = 'false';
  process.env.SSO_DEFAULT_ROLE = 'ESTIMATOR';
  process.env.APP_BASE_URL = 'http://127.0.0.1:9';

  await prisma.authToken.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.kpiEntry.deleteMany();
  await prisma.ticketNote.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.kpiSettings.deleteMany();
  await prisma.roleConfig.deleteMany();
  await prisma.user.deleteMany();
  await prisma.site.deleteMany();
  await prisma.workspace.deleteMany();

  ws = await prisma.workspace.create({ data: { company: 'SSO Test Co', ticketPrefix: 'SSO' } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  await prisma.user.create({
    data: {
      workspaceId: ws.id, username: 'alice', email: 'alice@test.local', fullName: 'ALICE',
      role: 'ESTIMATOR', passwordHash: hash, mustChangePassword: false, activatedAt: new Date(),
    },
  });

  const { AppModule } = await import('../src/app.module');
  const modRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = modRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  http_ = app.getHttpServer();
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>((r) => hubServer?.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(() => {
  identity = { sub: 'hub-uuid-alice', email: 'alice@test.local', name: 'ALICE' };
  tamper = 'none';
});

describe('F20 DWS Hub SSO (OIDC authorization code + PKCE)', () => {
  it('advertises SSO to the login page', async () => {
    const res = await request(http_).get('/api/v1/auth/sso/config');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.buttonLabel).toBeTruthy();
  });

  it('resolves Hub endpoints through discovery', async () => {
    const res = await request(http_).get('/api/v1/auth/sso/health');
    expect(res.body.enabled).toBe(true);
    expect(res.body.endpoints.token_endpoint).toBe(`${hubUrl}/api/sso/token`);
    expect(res.body.endpoints.jwks_uri).toBe(`${hubUrl}/api/sso/jwks`);
  });

  it('the authorize redirect carries client_id, redirect_uri, state and PKCE S256', async () => {
    const res = await request(http_).get('/api/v1/auth/sso/start');
    expect(res.status).toBe(302);
    const u = new URL(res.headers.location);
    expect(u.origin + u.pathname).toBe(`${hubUrl}/api/sso/authorize`);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('redirect_uri')).toBe(process.env.SSO_REDIRECT_URI);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')!.length).toBeGreaterThan(20);
    expect(u.searchParams.get('state')).toBeTruthy();
    // the verifier must never travel to the browser in readable form
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toContain('engpro_sso=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie.toLowerCase()).toContain('samesite=lax');   // survives the redirect back
  });

  it('a full round trip signs the matching user in and links the Hub subject', async () => {
    const agent = request.agent(http_);
    const { callback } = await ssoRoundTrip(agent);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('http://127.0.0.1:9/');
    const setCookie = String(callback.headers['set-cookie']);
    expect(setCookie).toContain('engpro_rt=');

    const linked = await prisma.user.findFirst({ where: { email: 'alice@test.local' } });
    expect(linked!.ssoSubject).toBe('hub-uuid-alice');

    // the session is real: the SPA's silent refresh yields a usable access token
    const refreshed = await agent.post('/api/v1/auth/refresh');
    expect(refreshed.status).toBe(200);
    const me = await request(http_).get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('alice@test.local');
  });

  it('a second sign-in matches on the Hub subject even if the email changed', async () => {
    await prisma.user.updateMany({ where: { email: 'alice@test.local' }, data: { email: 'alice.new@test.local' } });
    identity = { sub: 'hub-uuid-alice', email: 'stale@test.local', name: 'ALICE' };
    const agent = request.agent(http_);
    const { callback } = await ssoRoundTrip(agent);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('http://127.0.0.1:9/');
    const u = await prisma.user.findFirst({ where: { ssoSubject: 'hub-uuid-alice' } });
    expect(u!.email).toBe('alice.new@test.local');   // local record wins; no duplicate account
    await prisma.user.updateMany({ where: { id: u!.id }, data: { email: 'alice@test.local' } });
  });

  it('a pending invitation is activated by a successful Hub sign-in', async () => {
    await prisma.user.create({
      data: {
        workspaceId: ws.id, username: 'pending', email: 'pending@test.local', fullName: 'Pending Person',
        role: 'ESTIMATOR', passwordHash: 'x', mustChangePassword: false, activatedAt: null,
      },
    });
    identity = { sub: 'hub-uuid-pending', email: 'pending@test.local', name: 'Pending Person' };
    const { callback } = await ssoRoundTrip(request.agent(http_));
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('http://127.0.0.1:9/');
    const u = await prisma.user.findFirst({ where: { email: 'pending@test.local' } });
    expect(u!.activatedAt).not.toBeNull();
    expect(u!.ssoSubject).toBe('hub-uuid-pending');
  });

  it('an unknown Hub identity is refused while auto-provisioning is off', async () => {
    identity = { sub: 'hub-uuid-stranger', email: 'stranger@test.local', name: 'Stranger' };
    const { callback } = await ssoRoundTrip(request.agent(http_));
    expect(callback.status).toBe(302);
    expect(errorOf(callback)).toBe('not_registered');
    expect(await prisma.user.count({ where: { email: 'stranger@test.local' } })).toBe(0);
  });

  it('auto-provisioning creates the account with the configured default role', async () => {
    process.env.SSO_AUTO_PROVISION = 'true';
    identity = { sub: 'hub-uuid-newbie', email: 'newbie@test.local', name: 'New Bie' };
    const { callback } = await ssoRoundTrip(request.agent(http_));
    expect(callback.headers.location).toBe('http://127.0.0.1:9/');
    const u = await prisma.user.findFirst({ where: { email: 'newbie@test.local' } });
    expect(u).toBeTruthy();
    expect(u!.role).toBe('ESTIMATOR');
    expect(u!.activatedAt).not.toBeNull();
    expect(u!.username).toBe('newbie');
    process.env.SSO_AUTO_PROVISION = 'false';
  });

  it('a disabled account cannot get in through Hub', async () => {
    await prisma.user.updateMany({ where: { email: 'newbie@test.local' }, data: { isActive: false } });
    identity = { sub: 'hub-uuid-newbie', email: 'newbie@test.local', name: 'New Bie' };
    const { callback } = await ssoRoundTrip(request.agent(http_));
    expect(errorOf(callback)).toBe('account_disabled');
  });

  it('a mismatched state is rejected (CSRF)', async () => {
    const agent = request.agent(http_);
    const start = await agent.get('/api/v1/auth/sso/start');
    const authorizeUrl = new URL(start.headers.location);
    const hubRes = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
    const back = new URL(hubRes.headers.get('location')!);
    back.searchParams.set('state', 'tampered-state');
    const callback = await agent.get(`/api/v1/auth/sso/callback${back.search}`);
    expect(errorOf(callback)).toBe('state_mismatch');
  });

  it('a callback without the handoff cookie is rejected', async () => {
    const agent = request.agent(http_);
    const start = await agent.get('/api/v1/auth/sso/start');
    const hubRes = await fetch(start.headers.location, { redirect: 'manual' });
    const back = new URL(hubRes.headers.get('location')!);
    const callback = await request(http_).get(`/api/v1/auth/sso/callback${back.search}`);  // no cookie jar
    expect(errorOf(callback)).toBe('no_session');   // distinct from a tampered state
  });

  it('an authorization code cannot be replayed', async () => {
    const agent = request.agent(http_);
    const start = await agent.get('/api/v1/auth/sso/start');
    const hubRes = await fetch(start.headers.location, { redirect: 'manual' });
    const back = new URL(hubRes.headers.get('location')!);
    const first = await agent.get(`/api/v1/auth/sso/callback${back.search}`);
    expect(first.headers.location).toBe('http://127.0.0.1:9/');
    const agent2 = request.agent(http_);
    const start2 = await agent2.get('/api/v1/auth/sso/start');
    const state2 = new URL(start2.headers.location).searchParams.get('state')!;
    back.searchParams.set('state', state2);
    const replay = await agent2.get(`/api/v1/auth/sso/callback${back.search}`);
    expect(errorOf(replay)).toBe('exchange_failed');   // Hub refuses the used code
  });

  it('Hub is held to the PKCE contract: authorize without S256 is refused', async () => {
    const u = new URL(`${hubUrl}/api/sso/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', CLIENT_ID);
    u.searchParams.set('redirect_uri', process.env.SSO_REDIRECT_URI!);
    const res = await fetch(u.toString(), { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('an id_token for another audience is rejected', async () => {
    tamper = 'wrong-aud';
    const { callback } = await ssoRoundTrip(request.agent(http_));
    expect(errorOf(callback)).toBe('token_invalid');
  });

  it('an id_token from another issuer is rejected', async () => {
    tamper = 'wrong-issuer';
    const { callback } = await ssoRoundTrip(request.agent(http_));
    expect(errorOf(callback)).toBe('token_invalid');
  });

  it('SSO login is recorded in the audit trail', async () => {
    const rows = await prisma.auditLog.findMany({ where: { action: { in: ['sso-login', 'sso-linked', 'sso-provisioned'] } } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.action === 'sso-login')).toBe(true);
  });

  it('password login still works alongside SSO', async () => {
    const res = await request(http_).post('/api/v1/auth/login')
      .send({ email: 'alice@test.local', password: PW });
    expect(res.status).toBe(200);
  });
});
