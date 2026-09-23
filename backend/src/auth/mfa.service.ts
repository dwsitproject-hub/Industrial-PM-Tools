import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as totp from './totp';
import * as QRCode from 'qrcode';
import {
  createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual,
} from 'crypto';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';

export type MfaPolicy = 'required' | 'optional' | 'off';

/** Roles that must hold a second factor when MFA_POLICY=required. */
export function mfaRequiredRoles(): string[] {
  return (process.env.MFA_REQUIRED_ROLES || 'MANAGER,ADMIN')
    .split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
}

export function mfaPolicy(): MfaPolicy {
  const raw = (process.env.MFA_POLICY || 'optional').toLowerCase();
  return raw === 'required' || raw === 'off' ? raw : 'optional';
}

@Injectable()
export class MfaService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private audit: AuditService,
  ) {}

  // ── secret storage ───────────────────────────────────────────────
  /**
   * The TOTP secret is encrypted at rest. A stolen database dump is a realistic scenario
   * (backups, a copied RDS snapshot); plaintext secrets there would let an attacker generate
   * valid codes indefinitely, which defeats the point of the second factor.
   *
   * The key comes from MFA_SECRET_KEY when set, otherwise it is derived from the refresh
   * secret so existing installs need no extra mandatory variable. Rotating either invalidates
   * enrolments and users re-enrol, which is the safe direction to fail in.
   */
  private key(): Buffer {
    const material = process.env.MFA_SECRET_KEY || process.env.JWT_REFRESH_SECRET || '';
    if (!material) throw new Error('MFA requires MFA_SECRET_KEY or JWT_REFRESH_SECRET to be set');
    return createHash('sha256').update(`engpro-mfa:${material}`).digest();
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
  }

  private decrypt(stored: string): string {
    const [iv, tag, data] = stored.split('.');
    if (!iv || !tag || !data) throw new BadRequestException('Stored MFA secret is unreadable — re-enrol.');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  private static hashCode(raw: string): string {
    return createHash('sha256').update(String(raw).replace(/[\s-]/g, '').toUpperCase()).digest('hex');
  }

  // ── enrolment ────────────────────────────────────────────────────
  /** Generates a candidate secret. Nothing is enabled until a code from it is verified. */
  async beginSetup(userId: string): Promise<{ secret: string; uri: string; qr: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId }, select: { email: true, mfaEnabledAt: true },
    });
    if (!user) throw new UnauthorizedException();
    if (user.mfaEnabledAt) {
      throw new BadRequestException('Two-factor authentication is already on. Turn it off first to re-enrol.');
    }
    const secret = totp.generateSecret();
    const uri = totp.keyUri(secret, user.email || userId, process.env.MFA_ISSUER || 'EngPro');
    await this.prisma.user.update({
      where: { id: userId }, data: { mfaSecret: this.encrypt(secret) },
    });
    return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  }

  /** Confirms the authenticator works, switches MFA on, and issues backup codes. */
  async enable(userId: string, code: string, workspaceId: string, ip?: string): Promise<{ backupCodes: string[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId }, select: { mfaSecret: true, mfaEnabledAt: true },
    });
    if (!user?.mfaSecret) throw new BadRequestException('Start the setup first.');
    if (user.mfaEnabledAt) throw new BadRequestException('Two-factor authentication is already on.');
    if (!await this.checkTotp(this.decrypt(user.mfaSecret), code)) {
      throw new BadRequestException('That code is not right. Check your authenticator and try again.');
    }
    // Shown once. Stored hashed, so the database never holds a usable code either.
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').toUpperCase());
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabledAt: new Date(), mfaBackupCodes: codes.map(MfaService.hashCode) },
    });
    await this.audit.log({
      workspaceId, actorId: userId, entityType: 'auth', entityId: userId, action: 'mfa-enabled', ip,
    });
    return { backupCodes: codes };
  }

  async disable(userId: string, workspaceId: string, ip?: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabledAt: null, mfaSecret: null, mfaBackupCodes: [] },
    });
    await this.audit.log({
      workspaceId, actorId: userId, entityType: 'auth', entityId: userId, action: 'mfa-disabled', ip,
    });
  }

  async status(userId: string, role: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId }, select: { mfaEnabledAt: true, mfaBackupCodes: true },
    });
    return {
      enabled: !!user?.mfaEnabledAt,
      enabledAt: user?.mfaEnabledAt ?? null,
      backupCodesRemaining: user?.mfaBackupCodes.length ?? 0,
      required: MfaService.isRequiredFor(role),
      policy: mfaPolicy(),
    };
  }

  // ── verification ─────────────────────────────────────────────────
  private async checkTotp(secret: string, token: string): Promise<boolean> {
    return totp.verify(token, secret);
  }

  /**
   * Accepts either a TOTP code or one unused backup code. Backup codes are single use — a
   * consumed one is removed so an overheard or shoulder-surfed code cannot be replayed.
   */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mfaSecret: true, mfaEnabledAt: true, mfaBackupCodes: true },
    });
    if (!user?.mfaEnabledAt || !user.mfaSecret) return false;

    if (await this.checkTotp(this.decrypt(user.mfaSecret), code)) return true;

    const candidate = MfaService.hashCode(code || '');
    const match = user.mfaBackupCodes.find((stored) => {
      const a = Buffer.from(stored, 'utf8');
      const b = Buffer.from(candidate, 'utf8');
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!match) return false;
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaBackupCodes: user.mfaBackupCodes.filter((c) => c !== match) },
    });
    return true;
  }

  // ── the interim token issued between password and second factor ──
  /**
   * Signed with a key derived from — but not equal to — the access secret, so a challenge
   * token can never be presented as an access token even if a guard were to change.
   */
  private challengeSecret(): string {
    return createHash('sha256')
      .update(`engpro-mfa-challenge:${process.env.JWT_ACCESS_SECRET || ''}`).digest('hex');
  }

  issueChallenge(userId: string): string {
    return this.jwt.sign(
      { sub: userId, purpose: 'mfa' },
      {
        secret: this.challengeSecret(),
        expiresIn: process.env.MFA_CHALLENGE_TTL || '5m',
        algorithm: 'HS256',
      },
    );
  }

  readChallenge(token: string): string {
    try {
      const payload: any = this.jwt.verify(token, {
        secret: this.challengeSecret(), algorithms: ['HS256'],
      });
      if (payload?.purpose !== 'mfa' || !payload?.sub) throw new Error('bad purpose');
      return payload.sub as string;
    } catch {
      throw new UnauthorizedException('That sign-in attempt has expired. Please sign in again.');
    }
  }

  /** Whether this user is obliged to hold a second factor. */
  static isRequiredFor(role: string): boolean {
    return mfaPolicy() === 'required' && mfaRequiredRoles().includes(String(role).toUpperCase());
  }
}
