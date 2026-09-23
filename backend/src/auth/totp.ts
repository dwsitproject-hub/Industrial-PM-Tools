import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * RFC 6238 TOTP over RFC 4226 HOTP, using node's own HMAC.
 *
 * Written out rather than taken from a package: otplib v13 pulls in an ESM-only dependency
 * that the CommonJS test runner cannot load, and this is a specified construction over a
 * primitive node already provides — not hand-rolled cryptography. It is verified against the
 * published RFC 6238 test vectors in test/app.e2e-spec.ts, which is the point of using a
 * standard with published vectors.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = String(input || '').toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, the RFC-recommended shared-secret size. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export interface TotpOptions {
  digits?: number;
  period?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
  /** Unix seconds; defaults to now. */
  now?: number;
}

export function hotp(secret: Buffer, counter: number, digits = 6, algorithm = 'sha1'): string {
  const buf = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer. Written as two 32-bit halves because a JS number
  // cannot hold 64 bits exactly, and writeBigUInt64BE would force BigInt on every call.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac(algorithm, secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function generate(secret: string, opts: TotpOptions = {}): string {
  const { digits = 6, period = 30, algorithm = 'sha1' } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  return hotp(base32Decode(secret), Math.floor(now / period), digits, algorithm);
}

/**
 * Accepts codes from the adjacent time steps as well, so a slightly skewed phone clock or a
 * code typed as the window rolls over still works. One step either side is the usual balance:
 * it triples the guessing surface from 1e-6 to 3e-6, which the rate limit and account lockout
 * (AR-15) already bound far more tightly than that.
 */
export function verify(token: string, secret: string, opts: TotpOptions & { window?: number } = {}): boolean {
  const { digits = 6, period = 30, algorithm = 'sha1', window = 1 } = opts;
  const clean = String(token || '').replace(/\s/g, '');
  if (!new RegExp(`^[0-9]{${digits}}$`).test(clean)) return false;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / period);
  const key = base32Decode(secret);
  const candidate = Buffer.from(clean, 'utf8');

  let ok = false;
  for (let drift = -window; drift <= window; drift++) {
    const expected = Buffer.from(hotp(key, counter + drift, digits, algorithm), 'utf8');
    // Compare every step without short-circuiting, so the loop takes the same time whichever
    // step matches and the response does not reveal the drift.
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) ok = true;
  }
  return ok;
}

/** otpauth:// URI consumed by Google Authenticator, Authy, 1Password and the like. */
export function keyUri(secret: string, label: string, issuer: string): string {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(label)}`
    + `?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
