import { Logger } from '@nestjs/common';

/**
 * Security posture resolved once at boot.
 *
 * The application is moving from a private network to the public internet, so the
 * settings that used to be "nice to have" (TLS, Secure cookies, a real CORS allowlist)
 * become load-bearing. DEPLOY_ENV decides how strictly they are enforced:
 *
 *   local | staging  -> violations are logged loudly, the app still starts
 *   production       -> violations abort the boot, so a misconfigured deploy cannot
 *                       silently serve credentials over plaintext
 *
 * Failing closed here is deliberate: an outage during a deploy is recoverable,
 * a week of cleartext sessions is not.
 */
export type DeployEnv = 'local' | 'staging' | 'production';

export interface SecurityConfig {
  env: DeployEnv;
  /** Mark session cookies Secure so browsers refuse to send them over plaintext. */
  cookieSecure: boolean;
  /** Explicit allowlist, or false = same-origin only (never reflect the caller). */
  corsOrigins: string[] | false;
  /** Number of proxy hops in front of the API, for req.ip / X-Forwarded-For. */
  trustProxy: number;
  /** Strict-Transport-Security max-age in seconds; 0 disables the header. */
  hstsMaxAge: number;
  /** Whether the app believes it is reachable over https. */
  httpsBaseUrl: boolean;
}

export function deployEnv(): DeployEnv {
  const raw = (process.env.DEPLOY_ENV || '').trim().toLowerCase();
  if (raw === 'production' || raw === 'staging' || raw === 'local') return raw;
  // Unset: infer the safest thing we can without breaking existing installs.
  return process.env.NODE_ENV === 'production' ? 'staging' : 'local';
}

function intEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveSecurityConfig(): SecurityConfig {
  const env = deployEnv();
  const appBase = (process.env.APP_BASE_URL || '').trim();
  const httpsBaseUrl = appBase.startsWith('https://');

  const listed = (process.env.CORS_ORIGIN || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  return {
    env,
    // In production Secure is the default; it can only be turned off by an explicit
    // COOKIE_SECURE=false, which assertSecurityConfig then refuses.
    cookieSecure: env === 'production'
      ? process.env.COOKIE_SECURE !== 'false'
      : process.env.COOKIE_SECURE === 'true',
    // AR-09: an unset allowlist means same-origin only. It must never mean "reflect
    // whatever Origin the caller sent", which combined with credentials turns every
    // authenticated endpoint into a cross-origin target.
    corsOrigins: listed.length > 0 ? listed : false,
    trustProxy: intEnv('TRUST_PROXY', 0),
    hstsMaxAge: intEnv('HSTS_MAX_AGE', env === 'production' ? 15552000 : 0),
    httpsBaseUrl,
  };
}

/**
 * Refuses to start a production deployment that would leak credentials.
 * Returns the warnings raised so callers can log them in non-production.
 */
export function assertSecurityConfig(cfg: SecurityConfig): string[] {
  const log = new Logger('Security');
  const problems: string[] = [];
  const appBase = (process.env.APP_BASE_URL || '').trim();

  if (!cfg.httpsBaseUrl) {
    problems.push(
      `APP_BASE_URL is not https (${appBase || 'unset'}) — login credentials, session ` +
      'cookies, OIDC authorization codes and emailed activation links all travel in cleartext.',
    );
  }
  if (!cfg.cookieSecure) {
    problems.push(
      'COOKIE_SECURE is not enabled — the refresh cookie will be sent over plaintext HTTP.',
    );
  }
  if (cfg.corsOrigins === false) {
    problems.push('CORS_ORIGIN is not set — cross-origin requests are refused (same-origin only).');
  } else if (cfg.corsOrigins.some((o) => o === '*' )) {
    problems.push('CORS_ORIGIN contains "*", which cannot be combined with credentialed requests.');
  } else if (cfg.corsOrigins.some((o) => o.startsWith('http://'))) {
    problems.push(`CORS_ORIGIN contains a plaintext origin: ${cfg.corsOrigins.join(', ')}`);
  }

  const ssoRedirect = (process.env.SSO_REDIRECT_URI || '').trim();
  if (process.env.SSO_ENABLED === 'true' && ssoRedirect && !ssoRedirect.startsWith('https://')) {
    problems.push(`SSO_REDIRECT_URI is not https (${ssoRedirect}) — an intercepted authorization code can be replayed.`);
  }

  for (const [name, min] of [['JWT_ACCESS_SECRET', 32], ['JWT_REFRESH_SECRET', 32]] as const) {
    const v = process.env[name] || '';
    if (v.length < min) problems.push(`${name} is shorter than ${min} characters — generate one with: openssl rand -hex 64`);
  }
  if (process.env.JWT_ACCESS_SECRET && process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
    problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are identical — they must be different values.');
  }

  // Advisories: valid configurations that still deserve a word, because the control they
  // depend on lives outside this application.
  if ((process.env.MFA_POLICY || '').toLowerCase() === 'required' && process.env.SSO_ENABLED === 'true') {
    log.warn(
      'MFA_POLICY=required, but federated sign-in bypasses the app own second factor by design — ' +
      'the identity provider owns authentication strength. Confirm DWS Hub enforces MFA for these users.',
    );
  }
  if (cfg.trustProxy === 0 && cfg.env !== 'local') {
    log.warn(
      'TRUST_PROXY=0 behind a reverse proxy: req.ip will be the proxy for every request, so ' +
      'per-IP rate limits and the audit log record the wrong address. Set it to the number of proxies.',
    );
  }

  if (problems.length === 0) {
    log.log(`Security posture OK (DEPLOY_ENV=${cfg.env}, TLS enforced, cookies Secure).`);
    return problems;
  }

  if (cfg.env === 'production') {
    for (const p of problems) log.error(p);
    // The causes go in the exception too, not just the log: a container that exits on boot
    // is usually diagnosed from the crash message, and buffered logs can be lost.
    throw new Error([
      `Refusing to start: ${problems.length} security requirement(s) not met for DEPLOY_ENV=production.`,
      ...problems.map((p) => `  - ${p}`),
      'Fix the items above, or set DEPLOY_ENV=staging if this really is a private, non-production install.',
    ].join('\n'));
  }
  log.warn(`DEPLOY_ENV=${cfg.env}: ${problems.length} setting(s) would be refused in production —`);
  for (const p of problems) log.warn(`  • ${p}`);
  return problems;
}

let cached: SecurityConfig | null = null;
/** Resolved once; used by cookie helpers on every request. */
export function security(): SecurityConfig {
  if (!cached) cached = resolveSecurityConfig();
  return cached;
}
/** Test seam — forces the next security() call to re-read the environment. */
export function resetSecurityConfig(): void {
  cached = null;
}
