import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Public } from '../common/auth.types';
import { SsoError, SsoService } from './sso.service';

const HANDOFF_COOKIE = 'engpro_sso';
const REFRESH_COOKIE = 'engpro_rt';

@Controller('auth/sso')
export class SsoController {
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
  @Get('start')
  async start(@Query('returnTo') returnTo: string, @Res() res: Response) {
    try {
      const { url, handoff } = await this.sso.buildAuthorizeUrl(returnTo);
      // SameSite=Lax so the cookie survives the top-level redirect back from Hub.
      res.cookie(HANDOFF_COOKIE, JSON.stringify(handoff), {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE === 'true',
        sameSite: 'lax',
        path: '/api/v1/auth/sso',
        maxAge: 10 * 60_000,
      });
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
      res.clearCookie(HANDOFF_COOKIE, { path: '/api/v1/auth/sso' });
      return res.redirect(`${this.appBase()}/login?sso_error=${c}`);
    };

    if (error) return fail(error === 'access_denied' ? 'access_denied' : 'server_error');

    let handoff: { state: string; verifier: string; nonce?: string; returnTo?: string };
    try {
      handoff = JSON.parse(req.cookies?.[HANDOFF_COOKIE] || '');
    } catch {
      return fail('state_mismatch');
    }
    if (!code || !state || !handoff?.state || state !== handoff.state) return fail('state_mismatch');

    try {
      const { accessToken, refreshToken } = await this.sso.completeLogin(
        code, handoff.verifier, handoff.nonce, req.ip, req.headers['user-agent'],
      );
      const days = parseInt(process.env.REFRESH_TTL_DAYS || '7', 10);
      res.clearCookie(HANDOFF_COOKIE, { path: '/api/v1/auth/sso' });
      res.cookie(REFRESH_COOKIE, refreshToken, {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE === 'true',
        sameSite: 'strict',
        path: '/api/v1/auth',
        maxAge: days * 86400_000,
      });
      // The SPA silently refreshes on load, so landing on the app is enough to be signed in.
      const target = handoff.returnTo && handoff.returnTo.startsWith('/') ? handoff.returnTo : '/';
      void accessToken;
      return res.redirect(`${this.appBase()}${target}`);
    } catch (e: any) {
      return fail(e instanceof SsoError ? e.code : 'server_error');
    }
  }
}
