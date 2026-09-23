import { Throttle } from '@nestjs/throttler';

const WINDOW = 60_000;
const n = (name: string, fallback: number) => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Requests per minute per user (or per IP when unauthenticated) on ordinary routes. */
export const globalLimit = () => n('THROTTLE_GLOBAL', 120);

/**
 * Credential endpoints — failed logins and reset requests per minute per (IP, account).
 * Deliberately low: this is the front line against credential stuffing.
 */
export const Credentials = () => Throttle({ default: { limit: n('THROTTLE_LIMIT', 5), ttl: WINDOW } });

/**
 * Endpoints that are expensive to serve or attractive to harvest: full-text search over the
 * register, listings, CSV export, the audit trail, and the SSO redirect. Bounding these is
 * what stops a legitimate low-privilege account copying the whole database at speed.
 */
export const Heavy = () => Throttle({ default: { limit: n('THROTTLE_HEAVY', 30), ttl: WINDOW } });
