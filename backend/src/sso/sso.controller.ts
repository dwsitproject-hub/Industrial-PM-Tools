import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Public } from '../common/auth.types';
import {
  setRefreshCookie, ssoHandoffCookieOptions,
  SSO_HANDOFF_COOKIE as HANDOFF_COOKIE, SSO_RETRY_COOKIE as RETRY_COOKIE, SSO_PATH,
} from '../common/cookies';
import { Heavy } from '../common/throttle';
import { SsoError, SsoService } from './sso.service';


@Controller('auth/sso')
export class SsoController {
  private readonly log = new Logger('SsoController');

  constructor(private sso: SsoService) {}

  private appBase(): string {
    return (process.env.APP_BASE_URL || 'http://localhost:8090').replace(/\/+$/, '');
  }

  /** Public: lets the login page decide whether to show the SSO button. */
  @Public()
  @Get('config')
  config() {
    const c = this.sso.config();
    return { enabled: c.enabled, buttonLabel: c.buttonLabel };
  }

  /** Operator diagnostics — no secrets, just what the API resolved from discovery. */
  @Public()
  @Get('health')
  health() {
    return this.sso.diagnostics();
  }

  /** Entry point: also what DWS Hub can launch directly. */
  @Public()
  @Heavy()
  @Get('start')
  async start(@Query('returnTo') returnTo: string, @Res() res: Response) {
    try {
      const { url, handoff } = await this.sso.buildAuthorizeUrl(returnTo);
      // SameSite=Lax so the cookie survives the top-level redirect back from Hub.
      res.cookie(HANDOFF_COOKIE, JSON.stringify(handoff), ssoHandoffCookieOptions(10 * 60_000));
      this.log.log(`SSO flow started (state=${handoff.state.slice(0, 8)}…) -> ${url.split('?')[0]}`);
      return res.redirect(url);
    } catch (e: any) {
      const code = e instanceof SsoError ? e.code : 'server_error';
      return res.redirect(`${this.appBase()}/login?sso_error=${code}`);
    }
  }

  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const fail = (c: string) => {
      res.clearCookie(HANDOFF_COOKIE, { path: SSO_PATH });
      return res.redirect(`${this.appBase()}/login?sso_error=${c}`);
    };

    if (error) return fail(error === 'access_denied' ? 'access_denied' : 'server_error');

    const rawCookie = req.cookies?.[HANDOFF_COOKIE];
    let handoff: { state: string; verifier: string; nonce?: string; returnTo?: string } | null = null;
    try {
      handoff = rawCookie ? JSON.parse(rawCookie) : null;
    } catch {
      handoff = null;
    }

    if (!handoff?.verifier) {
      // No handoff cookie: the authorization request was not built here, so we hold no PKCE
      // verifier and cannot exchange this code. That is what a Hub-initiated launch looks like —
      // Hub sends the browser straight to the callback. Restart the flow from our side once, which
      // Hub satisfies silently because the user already has a Hub session.
      const alreadyRetried = !!req.cookies?.[RETRY_COOKIE];
      this.log.warn(
        `SSO callback without a handoff cookie. host=${req.headers.host} ` +
        `params=[${Object.keys(req.query || {}).join(', ') || 'none'}] ` +
        `cookies=[${Object.keys(req.cookies || {}).join(', ') || 'none'}] retried=${alreadyRetried}`,
      );
      if (code && !alreadyRetried) {
        // The app itself must own the PKCE verifier, so begin our own authorization request.
        res.cookie(RETRY_COOKIE, '1', ssoHandoffCookieOptions(5 * 60_000));
        this.log.log('Hub-initiated landing detected — restarting the flow from /auth/sso/start');
        return res.redirect('/api/v1/auth/sso/start');
      }
      res.clearCookie(RETRY_COOKIE, { path: SSO_PATH });
      return fail('no_session');
    }
    res.clearCookie(RETRY_COOKIE, { path: SSO_PATH });
    if (!code) {
      this.log.warn('SSO callback carried no authorization code');
      return fail('server_error');
    }
    if (state && state !== handoff.state) {
      this.log.warn(`SSO state mismatch: hub returned ${state.slice(0, 8)}…, expected ${handoff.state.slice(0, 8)}…`);
      return fail('state_mismatch');
    }
    if (!state) {
      // state is optional in the Hub contract; PKCE + the handoff cookie still bind the exchange.
      this.log.warn('Hub returned no state parameter — continuing on PKCE and the handoff cookie');
    }

    try {
      const { accessToken, refreshToken } = await this.sso.completeLogin(
        code, handoff.verifier, handoff.nonce, req.ip, req.headers['user-agent'],
      );
      res.clearCookie(HANDOFF_COOKIE, { path: SSO_PATH });
      setRefreshCookie(res, refreshToken);
      // The SPA silently refreshes on load, so landing on the app is enough to be signed in.
      const target = handoff.returnTo && handoff.returnTo.startsWith('/') ? handoff.returnTo : '/';
      void accessToken;
      return res.redirect(`${this.appBase()}${target}`);
    } catch (e: any) {
      return fail(e instanceof SsoError ? e.code : 'server_error');
    }
  }
}
