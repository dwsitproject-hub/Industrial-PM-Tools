/**
 * Regression tests for the security hardening findings (AR-01 .. AR-16).
 * Each block names the finding it locks in, so a future change that reopens one fails here.
 */
import {
  assertSecurityConfig, resolveSecurityConfig, resetSecurityConfig,
} from '../src/common/security.config';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; 
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k] as string; }
  resetSecurityConfig();
  try { fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] as string;
    }
    resetSecurityConfig();
  }
}

const GOOD_SECRETS = {
  JWT_ACCESS_SECRET: 'a'.repeat(64),
  JWT_REFRESH_SECRET: 'b'.repeat(64),
};

describe('AR-01 — transport security is enforced in production', () => {
  it('refuses to start in production when APP_BASE_URL is plaintext', () => {
    withEnv({
      DEPLOY_ENV: 'production', ...GOOD_SECRETS,
      APP_BASE_URL: 'http://ind-pm.kpndomain.com',
      CORS_ORIGIN: 'https://ind-pm.kpndomain.com', COOKIE_SECURE: 'true',
    }, () => {
      expect(() => assertSecurityConfig(resolveSecurityConfig()))
        .toThrow(/Refusing to start/);
    });
  });

  it('refuses to start in production when COOKIE_SECURE is explicitly disabled', () => {
    withEnv({
      DEPLOY_ENV: 'production', ...GOOD_SECRETS,
      APP_BASE_URL: 'https://ind-pm.kpndomain.com',
      CORS_ORIGIN: 'https://ind-pm.kpndomain.com', COOKIE_SECURE: 'false',
    }, () => {
      expect(() => assertSecurityConfig(resolveSecurityConfig())).toThrow(/COOKIE_SECURE/);
    });
  });

  it('refuses a plaintext SSO redirect URI in production', () => {
    withEnv({
      DEPLOY_ENV: 'production', ...GOOD_SECRETS,
      APP_BASE_URL: 'https://ind-pm.kpndomain.com',
      CORS_ORIGIN: 'https://ind-pm.kpndomain.com', COOKIE_SECURE: 'true',
      SSO_ENABLED: 'true', SSO_REDIRECT_URI: 'http://ind-pm.kpndomain.com/api/v1/auth/sso/callback',
    }, () => {
      expect(() => assertSecurityConfig(resolveSecurityConfig())).toThrow(/SSO_REDIRECT_URI/);
    });
  });

  it('defaults cookies to Secure in production and starts when TLS is configured', () => {
    withEnv({
      DEPLOY_ENV: 'production', ...GOOD_SECRETS,
      APP_BASE_URL: 'https://ind-pm.kpndomain.com',
      CORS_ORIGIN: 'https://ind-pm.kpndomain.com', COOKIE_SECURE: undefined,
      SSO_ENABLED: 'false', SSO_REDIRECT_URI: undefined,
    }, () => {
      const cfg = resolveSecurityConfig();
      expect(cfg.cookieSecure).toBe(true);
      expect(cfg.hstsMaxAge).toBeGreaterThan(0);
      expect(() => assertSecurityConfig(cfg)).not.toThrow();
    });
  });

  it('warns but still starts on staging, so the private install keeps working', () => {
    withEnv({
      DEPLOY_ENV: 'staging', ...GOOD_SECRETS,
      APP_BASE_URL: 'http://test-ind-pm.kpndomain.com',
      CORS_ORIGIN: 'http://test-ind-pm.kpndomain.com', COOKIE_SECURE: 'false',
    }, () => {
      const problems = assertSecurityConfig(resolveSecurityConfig());
      expect(problems.length).toBeGreaterThan(0);
    });
  });
});

describe('AR-09 — CORS never reflects an arbitrary origin', () => {
  it('falls back to same-origin only when CORS_ORIGIN is unset', () => {
    withEnv({ DEPLOY_ENV: 'staging', CORS_ORIGIN: undefined }, () => {
      expect(resolveSecurityConfig().corsOrigins).toBe(false);
    });
  });

  it('parses an explicit allowlist', () => {
    withEnv({ DEPLOY_ENV: 'staging', CORS_ORIGIN: 'https://a.example, https://b.example' }, () => {
      expect(resolveSecurityConfig().corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    });
  });

  it('rejects a wildcard allowlist in production', () => {
    withEnv({
      DEPLOY_ENV: 'production', ...GOOD_SECRETS,
      APP_BASE_URL: 'https://ind-pm.kpndomain.com', CORS_ORIGIN: '*', COOKIE_SECURE: 'true',
    }, () => {
      expect(() => assertSecurityConfig(resolveSecurityConfig())).toThrow(/CORS_ORIGIN/);
    });
  });
});

describe('AR-13 — weak or shared signing secrets are refused in production', () => {
  it('rejects a short access secret', () => {
    withEnv({
      DEPLOY_ENV: 'production', JWT_ACCESS_SECRET: 'short', JWT_REFRESH_SECRET: 'b'.repeat(64),
      APP_BASE_URL: 'https://x.example', CORS_ORIGIN: 'https://x.example', COOKIE_SECURE: 'true',
    }, () => {
      expect(() => assertSecurityConfig(resolveSecurityConfig())).toThrow(/JWT_ACCESS_SECRET/);
    });
  });

  it('rejects identical access and refresh secrets', () => {
    withEnv({
      DEPLOY_ENV: 'production', JWT_ACCESS_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'a'.repeat(64),
      APP_BASE_URL: 'https://x.example', CORS_ORIGIN: 'https://x.example', COOKIE_SECURE: 'true',
    }, () => {
      expect(() => assertSecurityConfig(resolveSecurityConfig())).toThrow(/identical/);
    });
  });
});

// ── AR-02 ────────────────────────────────────────────────────────────────────
// Booted in isolation with deliberately tiny limits, because the limits are read when the
// route decorators evaluate. Everything before this point is pure configuration testing.
describe('AR-02 — every route is rate limited, not just login', () => {
  let app: any;
  let http: any;
  let token = '';

  beforeAll(async () => {
    process.env.THROTTLE_GLOBAL = '8';
    process.env.THROTTLE_HEAVY = '3';
    process.env.THROTTLE_LIMIT = '3';
    jest.resetModules();

    /* eslint-disable @typescript-eslint/no-var-requires */
    const { Test } = require('@nestjs/testing');
    const { ValidationPipe } = require('@nestjs/common');
    const cookieParser = require('cookie-parser').default || require('cookie-parser');
    const { AppModule } = require('../src/app.module');
    const { PrismaClient } = require('@prisma/client');
    const argon2 = require('argon2');

    const prisma = new PrismaClient();
    const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } })
      || await prisma.workspace.create({ data: { company: 'Throttle Co', ticketPrefix: 'THR' } });
    const email = `throttle.${Date.now()}@test.local`;
    await prisma.user.create({
      data: {
        workspaceId: ws.id, username: email.split('@')[0], email,
        fullName: 'Throttle Probe', role: 'MANAGER',
        passwordHash: await argon2.hash('Password10!', { type: argon2.argon2id }),
        isActive: true, activatedAt: new Date(), mustChangePassword: false,
      },
    });
    await prisma.$disconnect();

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    const res = await require('supertest')(http)
      .post('/api/v1/auth/login').send({ email, password: 'Password10!' });
    expect(res.status).toBe(200);
    token = res.body.accessToken;
  });

  afterAll(async () => { if (app) await app.close(); });

  const req = () => require('supertest')(http);

  it('throttles an ordinary authenticated endpoint (was completely unmetered)', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    let sawLimit = false;
    for (let i = 0; i < 12; i++) {
      const res = await req().get('/api/v1/users').set(auth);
      if (res.status === 429) { sawLimit = true; break; }
    }
    expect(sawLimit).toBe(true);
  });

  it('applies a tighter limit to the harvestable ticket listing', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await req().get('/api/v1/tickets').set(auth)).status);
    }
    // THROTTLE_HEAVY=3 must bite before the global limit of 8.
    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses[4]).toBe(429);
  });

  it('still throttles login per (IP, account)', async () => {
    let sawLimit = false;
    for (let i = 0; i < 6; i++) {
      const res = await req().post('/api/v1/auth/login')
        .send({ email: 'nobody@test.local', password: 'wrong-password' });
      if (res.status === 429) { sawLimit = true; break; }
    }
    expect(sawLimit).toBe(true);
  });

  it('a different account is not locked out by another account being hammered', async () => {
    const res = await req().post('/api/v1/auth/login')
      .send({ email: 'someone.else@test.local', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });
});
