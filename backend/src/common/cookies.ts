import { CookieOptions, Response } from 'express';
import { security } from './security.config';

export const REFRESH_COOKIE = 'engpro_rt';
export const REFRESH_PATH = '/api/v1/auth';
export const SSO_HANDOFF_COOKIE = 'engpro_sso';
export const SSO_RETRY_COOKIE = 'engpro_sso_retry';
export const SSO_PATH = '/api/v1/auth/sso';

/**
 * One place decides cookie security attributes, so a change to the deployment posture
 * cannot be applied to the login cookie and forgotten on the SSO cookie.
 */
function base(path: string, sameSite: 'strict' | 'lax'): CookieOptions {
  return { httpOnly: true, secure: security().cookieSecure, sameSite, path };
}

export function refreshCookieOptions(): CookieOptions {
  const days = parseInt(process.env.REFRESH_TTL_DAYS || '7', 10);
  return { ...base(REFRESH_PATH, 'strict'), maxAge: days * 86400_000 };
}

export function setRefreshCookie(res: Response, raw: string): void {
  res.cookie(REFRESH_COOKIE, raw, refreshCookieOptions());
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
}

/** SameSite=Lax so the cookie survives the top-level redirect back from the identity provider. */
export function ssoHandoffCookieOptions(maxAgeMs: number): CookieOptions {
  return { ...base(SSO_PATH, 'lax'), maxAge: maxAgeMs };
}
