/** Date-only string (YYYY-MM-DD) for "today" in the workspace timezone. */
export function todayInTz(tz: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

export function dateOnly(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function isOverdue(deadline: Date | string, status: string, tz: string): boolean {
  if (status === 'DONE') return false;
  return dateOnly(deadline) < todayInTz(tz);
}

/** JSON-safe clone for audit payloads (BigInt/Decimal/Date handling). */
export function jsonSafe(obj: unknown): any {
  if (obj === null || obj === undefined) return null;
  return JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

const PW_DENYLIST = new Set([
  'password12', 'password123', 'passw0rd123', '1234567890', 'qwertyuiop',
  'engpro12345', 'estimation1', 'abcdefghij',
]);

export function validatePassword(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password must be at most 128 characters.';
  if (PW_DENYLIST.has(pw.toLowerCase())) return 'Password is too common.';
  return null;
}

const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
export function generateTempPassword(len = 12): string {
  const { randomInt } = require('crypto');
  let out = '';
  for (let i = 0; i < len; i++) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  return out;
}
