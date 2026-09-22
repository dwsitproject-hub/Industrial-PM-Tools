import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthService } from '../auth/auth.service';

export interface SsoConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  buttonLabel: string;
  autoProvision: boolean;
  defaultRole: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** Errors surfaced to the login page as ?sso_error=<code>; never leak internals to the browser. */
export type SsoErrorCode =
  | 'sso_disabled' | 'state_mismatch' | 'no_session' | 'exchange_failed' | 'token_invalid'
  | 'not_registered' | 'account_disabled' | 'server_error';

export class SsoError extends Error {
  constructor(public code: SsoErrorCode, message?: string) {
    super(message || code);
  }
}

@Injectable()
export class SsoService {
  private readonly log = new Logger('SsoService');
  private discovery?: { doc: Discovery; fetchedAt: number };
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private auth: AuthService,
  ) {}

  config(): SsoConfig {
    const issuer = (process.env.SSO_ISSUER || '').replace(/\/+$/, '');
    return {
      enabled: process.env.SSO_ENABLED === 'true' && !!issuer && !!process.env.SSO_CLIENT_ID,
      issuer,
      clientId: process.env.SSO_CLIENT_ID || '',
      redirectUri: process.env.SSO_REDIRECT_URI || '',
      scope: process.env.SSO_SCOPE || 'openid profile email',
      buttonLabel: process.env.SSO_BUTTON_LABEL || 'Continue with DWS Hub',
      autoProvision: process.env.SSO_AUTO_PROVISION === 'true',
      defaultRole: process.env.SSO_DEFAULT_ROLE || 'ESTIMATOR',
    };
  }

  private assertEnabled(): SsoConfig {
    const cfg = this.config();
    if (!cfg.enabled) throw new SsoError('sso_disabled', 'Single sign-on is not configured on this server');
    return cfg;
  }

  /** Discovery document, cached for 10 minutes; falls back to the documented Hub paths. */
  private async getDiscovery(): Promise<Discovery> {
    const cfg = this.assertEnabled();
    if (this.discovery && Date.now() - this.discovery.fetchedAt < 600_000) return this.discovery.doc;
    const url = `${cfg.issuer}/api/sso/.well-known/openid-configuration`;
    let doc: Discovery;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      doc = {
        issuer: body.issuer || cfg.issuer,
        authorization_endpoint: body.authorization_endpoint || `${cfg.issuer}/api/sso/authorize`,
        token_endpoint: body.token_endpoint || `${cfg.issuer}/api/sso/token`,
        jwks_uri: body.jwks_uri || `${cfg.issuer}/api/sso/jwks`,
      };
    } catch (e: any) {
      this.log.warn(`Discovery failed (${url}): ${e?.message}. Using documented default paths.`);
      doc = {
        issuer: cfg.issuer,
        authorization_endpoint: `${cfg.issuer}/api/sso/authorize`,
        token_endpoint: `${cfg.issuer}/api/sso/token`,
        jwks_uri: `${cfg.issuer}/api/sso/jwks`,
      };
    }
    this.discovery = { doc, fetchedAt: Date.now() };
    this.jwks = undefined;   // re-bind JWKS if the endpoint moved
    return doc;
  }

  // ── PKCE ───────────────────────────────────────────────────────────
  static verifier(): string {
    return randomBytes(48).toString('base64url');   // 64 chars, within the 43–128 spec range
  }
  static challenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
  }

  /** Builds the authorize URL and the one-time values the callback must check. */
  async buildAuthorizeUrl(returnTo?: string) {
    const cfg = this.assertEnabled();
    const doc = await this.getDiscovery();
    const verifier = SsoService.verifier();
    const state = randomBytes(16).toString('base64url');
    const nonce = randomUUID();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', cfg.redirectUri);
    url.searchParams.set('code_challenge', SsoService.challenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('scope', cfg.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    return { url: url.toString(), handoff: { state, verifier, nonce, returnTo: returnTo || '/' } };
  }

  /** Authorization-code + PKCE exchange. Hub's contract posts JSON, not form-encoding. */
  private async exchangeCode(code: string, verifier: string): Promise<string> {
    const cfg = this.assertEnabled();
    const doc = await this.getDiscovery();
    let res: Response;
    try {
      res = await fetch(doc.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: cfg.redirectUri,
          client_id: cfg.clientId,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e: any) {
      this.log.error(`Token endpoint unreachable: ${e?.message}`);
      throw new SsoError('exchange_failed', 'Token endpoint unreachable');
    }
    const bodyText = await res.text();
    if (!res.ok) {
      this.log.error(`Token exchange failed (${res.status}): ${bodyText.slice(0, 400)}`);
      throw new SsoError('exchange_failed', `Token endpoint returned ${res.status}`);
    }
    let body: any;
    try { body = JSON.parse(bodyText); } catch {
      throw new SsoError('exchange_failed', 'Token endpoint returned a non-JSON body');
    }
    if (!body.id_token) throw new SsoError('exchange_failed', 'Token response carried no id_token');
    return body.id_token as string;
  }

  /** Verifies signature via JWKS and enforces iss / aud / exp / sub (and nonce when present). */
  private async verifyIdToken(idToken: string, expectedNonce?: string): Promise<JWTPayload> {
    const cfg = this.assertEnabled();
    const doc = await this.getDiscovery();
    if (!this.jwks) this.jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        issuer: doc.issuer,
        audience: cfg.clientId,
      }));
    } catch (e: any) {
      this.log.error(`ID token verification failed: ${e?.message}`);
      throw new SsoError('token_invalid', 'ID token failed verification');
    }
    if (!payload.sub) throw new SsoError('token_invalid', 'ID token has no sub');
    if (expectedNonce && payload.nonce && payload.nonce !== expectedNonce) {
      throw new SsoError('token_invalid', 'Nonce mismatch');
    }
    return payload;
  }

  /**
   * Maps a Hub identity to a local account:
   *   1. known sso_subject        -> that user
   *   2. matching email           -> link the subject (and activate a pending invitation)
   *   3. SSO_AUTO_PROVISION=true  -> create a new account with SSO_DEFAULT_ROLE
   *   otherwise the login is refused, so Hub access alone cannot create EngPro users.
   */
  private async resolveUser(payload: JWTPayload, ip?: string) {
    const cfg = this.config();
    const sub = String(payload.sub);
    const email = String(payload.email || '').trim().toLowerCase();
    const name = String(payload.name || email || 'DWS Hub user');

    let user = await this.prisma.user.findFirst({ where: { ssoSubject: sub, deletedAt: null } });

    if (!user && email) {
      const byEmail = await this.prisma.user.findFirst({ where: { email, deletedAt: null } });
      if (byEmail) {
        user = await this.prisma.user.update({
          where: { id: byEmail.id },
          data: {
            ssoSubject: sub,
            // Hub has verified this person, so a pending invitation is satisfied
            activatedAt: byEmail.activatedAt ?? new Date(),
            mustChangePassword: false,
          },
        });
        await this.audit.log({
          workspaceId: user.workspaceId, actorId: user.id, entityType: 'auth',
          entityId: user.id, action: 'sso-linked', after: { sub }, ip,
        });
      }
    }

    if (!user) {
      if (!cfg.autoProvision || !email) {
        // Logged so an operator can see exactly which address to put on the EngPro account.
        this.log.warn(
          `Refused Hub identity with no matching EngPro account — sub=${sub} email=${email || '(none sent)'} name=${name}. ` +
          'Set this email on a user in Settings → Users, or enable SSO_AUTO_PROVISION.',
        );
        throw new SsoError('not_registered',
          'No EngPro account matches this Hub identity. Ask a manager to add you in Settings → Users.');
      }
      const workspace = await this.prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
      if (!workspace) throw new SsoError('server_error', 'No workspace configured');
      const base = (email.split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'user';
      let username = base;
      for (let i = 1; await this.prisma.user.findFirst({ where: { workspaceId: workspace.id, username } }); i++) {
        username = `${base}${i + 1}`;
      }
      user = await this.prisma.user.create({
        data: {
          workspaceId: workspace.id,
          username,
          email,
          fullName: name,
          role: cfg.defaultRole as any,
          ssoSubject: sub,
          activatedAt: new Date(),
          mustChangePassword: false,
          passwordHash: await this.auth.hashPassword(randomBytes(32).toString('hex')),
        },
      });
      await this.audit.log({
        workspaceId: user.workspaceId, actorId: user.id, entityType: 'user',
        entityId: user.id, action: 'sso-provisioned', after: { email, role: cfg.defaultRole }, ip,
      });
    }

    if (!user.isActive || user.deletedAt) {
      throw new SsoError('account_disabled', 'This account is disabled. Contact your manager.');
    }
    return user;
  }

  /** Full callback: exchange -> verify -> map -> issue an EngPro session. */
  async completeLogin(code: string, verifier: string, nonce: string | undefined, ip?: string, userAgent?: string) {
    const idToken = await this.exchangeCode(code, verifier);
    const payload = await this.verifyIdToken(idToken, nonce);
    const user = await this.resolveUser(payload, ip);
    const session = await this.auth.issueSession(user, userAgent);
    await this.audit.log({
      workspaceId: user.workspaceId, actorId: user.id, entityType: 'auth',
      entityId: user.id, action: 'sso-login', ip,
    });
    return { user, ...session };
  }

  /** Surfaced by GET /auth/sso/health so operators can see what the API resolved. */
  async diagnostics() {
    const cfg = this.config();
    if (!cfg.enabled) return { enabled: false };
    try {
      const doc = await this.getDiscovery();
      return { enabled: true, clientId: cfg.clientId, redirectUri: cfg.redirectUri, endpoints: doc };
    } catch (e: any) {
      return { enabled: true, clientId: cfg.clientId, redirectUri: cfg.redirectUri, error: e?.message };
    }
  }
}
