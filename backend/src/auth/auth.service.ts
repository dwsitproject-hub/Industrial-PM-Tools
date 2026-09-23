import {
  BadRequestException, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { JwtUser } from '../common/auth.types';
import { validatePassword } from '../common/util';
import { TokensService } from './tokens.service';
import { MfaService } from './mfa.service';

const ARGON_OPTS: argon2.Options = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };

export interface TokenPair {
  accessToken: string;
  refreshToken: string; // raw value for the cookie
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private audit: AuditService,
    private tokens: TokensService,
    private mfa: MfaService,
  ) {}

  static hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * A real argon2 hash of a value nobody knows, verified against when the submitted email
   * matches no account. Without it an unknown address answers in microseconds while a known
   * one costs a full argon2 verification — a timing difference that re-opens the account
   * enumeration the uniform error message was meant to close (AR-05).
   */
  private static dummyHash: Promise<string> | null = null;
  private static DUMMY(): Promise<string> {
    if (!AuthService.dummyHash) {
      AuthService.dummyHash = argon2.hash(randomBytes(32).toString('hex'), ARGON_OPTS);
    }
    return AuthService.dummyHash;
  }

  async hashPassword(pw: string): Promise<string> {
    return argon2.hash(pw, ARGON_OPTS);
  }

  /**
   * AR-03: always re-reads the user with its company, rather than trusting whatever the
   * caller happened to have loaded. The company scope is a security control; deriving it
   * from a partially-loaded record would fail open the moment someone signed a token from a
   * query that omitted the relation — which is exactly the kind of mistake that survives
   * review. One extra query per token issuance is a negligible price for that.
   */
  private async signAccessFor(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, workspaceId: true, role: true, siteId: true,
        mustChangePassword: true, mfaEnabledAt: true, companyId: true,
        company: { select: { isInternal: true } },
      },
    });
    if (!user) throw new UnauthorizedException();
    return this.signAccess(user);
  }

  private signAccess(user: {
    id: string; workspaceId: string; role: string; siteId: string | null;
    mustChangePassword: boolean; mfaEnabledAt?: Date | null;
    companyId?: string | null; company?: { isInternal: boolean } | null;
  }): string {
    const payload: JwtUser = {
      sub: user.id, ws: user.workspaceId, role: user.role as JwtUser['role'],
      siteId: user.siteId, mcp: user.mustChangePassword || undefined,
      mfa: user.mfaEnabledAt ? true : undefined,
      co: user.companyId ?? undefined,
      // Only a user in an explicitly INTERNAL company is unscoped. Anything else — an
      // external company, or a company relation that was not loaded — is treated as
      // external, so the failure mode is over-restriction rather than data exposure.
      ext: user.company?.isInternal === true ? undefined : true,
    };
    return this.jwt.sign(payload as any, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: process.env.ACCESS_TTL || '15m',
      // AR-08: pinned on both sides. Leaving the algorithm open is a standing invitation
      // for an algorithm-confusion bypass the day this moves to asymmetric keys.
      algorithm: 'HS256',
    });
  }

  private async issueRefresh(userId: string, familyId: string, userAgent?: string): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    const days = parseInt(process.env.REFRESH_TTL_DAYS || '7', 10);
    await this.prisma.refreshToken.create({
      data: {
        userId, familyId,
        tokenHash: AuthService.hashToken(raw),
        userAgent: userAgent || null,
        expiresAt: new Date(Date.now() + days * 86400_000),
      },
    });
    return raw;
  }

  /**
   * AR-15: the per-IP throttle slows one source; it does nothing about a distributed
   * credential-stuffing run spread thinly across many addresses. A cumulative per-account
   * counter closes that, and notifying the owner means a real person learns about an attack
   * on their account even though the attacker is told nothing.
   */
  private async registerFailedLogin(
    user: { id: string; email: string | null; fullName: string; workspaceId: string; failedLoginCount: number },
    ip?: string,
  ): Promise<void> {
    const threshold = parseInt(process.env.LOCKOUT_THRESHOLD || '10', 10);
    const minutes = parseInt(process.env.LOCKOUT_MINUTES || '15', 10);
    const count = user.failedLoginCount + 1;
    const lock = threshold > 0 && count >= threshold;

    await this.prisma.user.update({
      where: { id: user.id },
      data: lock
        ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + minutes * 60_000) }
        : { failedLoginCount: count },
    });
    await this.audit.log({
      workspaceId: user.workspaceId, actorId: user.id, entityType: 'auth',
      entityId: user.id, action: lock ? 'login-lockout' : 'login-failed', ip,
    });
    if (lock && user.email) {
      await this.tokens.notifyLockout(
        { email: user.email, fullName: user.fullName }, minutes, ip,
      ).catch(() => undefined);
    }
  }

  async login(email: string, password: string, ip?: string, userAgent?: string) {
    const user = await this.prisma.user.findFirst({
      where: { email: (email || '').trim().toLowerCase(), isActive: true, deletedAt: null },
      include: { workspace: true },
    });
    // AR-05: every failure below answers identically. On a private network telling an
    // invited user "not activated yet" was helpful; on the internet it confirms which
    // corporate addresses hold accounts, and which are new enough to phish with an
    // activation-themed email. The login page offers a self-service resend instead.
    const invalid = new UnauthorizedException('Invalid email or password');
    if (!user) {
      // Spend comparable time on an unknown address so response timing does not become
      // the enumeration oracle that the uniform message just closed.
      await argon2.verify(await AuthService.DUMMY(), password || '').catch(() => false);
      throw invalid;
    }
    if (!user.activatedAt) {
      await this.audit.log({
        workspaceId: user.workspaceId, actorId: user.id, entityType: 'auth',
        entityId: user.id, action: 'login-pending', ip,
      });
      throw invalid;
    }
    // AR-15: a locked account answers exactly like a wrong password. Saying "temporarily
    // locked" would hand an attacker both a confirmation that the address is real and a
    // progress meter for their run; the real owner is told by email instead.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.log({
        workspaceId: user.workspaceId, actorId: user.id, entityType: 'auth',
        entityId: user.id, action: 'login-locked', ip,
      });
      throw invalid;
    }
    const ok = await argon2.verify(user.passwordHash, password || '').catch(() => false);
    if (!ok) {
      await this.registerFailedLogin(user, ip);
      throw invalid;
    }
    // AR-04: the password is only the first factor. When the account holds a second one the
    // response carries a short-lived challenge instead of a session, and no refresh cookie is
    // set — so a stolen password alone never produces a usable session.
    if (user.mfaEnabledAt) {
      await this.audit.log({
        workspaceId: user.workspaceId, actorId: user.id, entityType: 'auth',
        entityId: user.id, action: 'login-mfa-challenge', ip,
      });
      return { mfaRequired: true as const, mfaToken: this.mfa.issueChallenge(user.id) };
    }
    return this.startSession(user, ip, userAgent);
  }

  /** Second step of a two-factor login: exchange the challenge plus a code for a session. */
  async completeMfa(mfaToken: string, code: string, ip?: string, userAgent?: string) {
    const userId = this.mfa.readChallenge(mfaToken);
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true, deletedAt: null },
      include: { workspace: true },
    });
    if (!user) throw new UnauthorizedException('Invalid email or password');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!await this.mfa.verifyCode(userId, code)) {
      // A wrong second factor counts towards lockout too, otherwise the code is a free
      // 1-in-a-million guess repeated without limit once a password is known.
      await this.registerFailedLogin(user, ip);
      throw new UnauthorizedException('That code is not right.');
    }
    return this.startSession(user, ip, userAgent);
  }

  /** Clears the failure counters and issues the token pair. */
  private async startSession(user: any, ip?: string, userAgent?: string) {
    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      });
    } else {
      await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    }
    const accessToken = await this.signAccessFor(user.id);
    const refreshToken = await this.issueRefresh(user.id, randomUUID(), userAgent);
    await this.audit.log({
      workspaceId: user.workspaceId, actorId: user.id, entityType: 'auth',
      entityId: user.id, action: 'login', ip,
    });
    return { accessToken, refreshToken, user };
  }

  async refresh(raw: string, userAgent?: string) {
    if (!raw) throw new UnauthorizedException('No refresh token');
    const row = await this.prisma.refreshToken.findFirst({
      where: { tokenHash: AuthService.hashToken(raw) },
      include: { user: { include: { workspace: true } } },
    });
    if (!row) throw new UnauthorizedException('Invalid refresh token');
    if (row.revokedAt) {
      // replay of a rotated token: revoke the whole family
      await this.prisma.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.log({
        workspaceId: row.user.workspaceId, actorId: row.userId, entityType: 'auth',
        entityId: row.userId, action: 'token-replay',
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if (row.expiresAt < new Date()) throw new UnauthorizedException('Refresh token expired');
    if (!row.user.isActive || row.user.deletedAt) throw new UnauthorizedException('Account disabled');

    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    const refreshToken = await this.issueRefresh(row.userId, row.familyId, userAgent);
    const accessToken = await this.signAccessFor(row.user.id);
    return { accessToken, refreshToken, user: row.user };
  }

  async logout(raw: string | undefined) {
    if (!raw) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: AuthService.hashToken(raw), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const ok = await argon2.verify(user.passwordHash, currentPassword || '').catch(() => false);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');
    const policyError = validatePassword(newPassword);
    if (policyError) throw new BadRequestException(policyError);
    const passwordHash = await this.hashPassword(newPassword);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null }, data: { revokedAt: new Date() },
    });
    await this.audit.log({
      workspaceId: user.workspaceId, actorId: userId, entityType: 'auth',
      entityId: userId, action: 'password-changed',
    });
    const accessToken = await this.signAccessFor(updated.id);
    const refreshToken = await this.issueRefresh(userId, randomUUID());
    return { accessToken, refreshToken, user: updated };
  }

  /**
   * Always resolves the same way so the endpoint cannot be used to discover which
   * addresses are registered. A link is only issued for an activated, active account.
   */
  async forgotPassword(email: string, company: string, ip?: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { email: (email || '').trim().toLowerCase(), isActive: true, deletedAt: null },
      select: { id: true, email: true, fullName: true, workspaceId: true, activatedAt: true },
    });
    if (!user) return;
    if (!user.activatedAt) {
      // pending account: resend the activation link instead — same outcome for the caller
      await this.tokens.sendActivation(user, company);
      return;
    }
    await this.tokens.sendReset(user, company);
    await this.audit.log({
      workspaceId: user.workspaceId, actorId: user.id, entityType: 'auth',
      entityId: user.id, action: 'password-reset-requested', ip,
    });
  }

  /** Completes a self-service reset: sets the password and kills every existing session. */
  async resetPassword(rawToken: string, newPassword: string, ip?: string) {
    const policyError = validatePassword(newPassword);
    if (policyError) throw new BadRequestException(policyError);
    const row = await this.tokens.consume(rawToken, 'PASSWORD_RESET');
    const passwordHash = await this.hashPassword(newPassword);
    const user = await this.prisma.user.update({
      where: { id: row.userId },
      data: { passwordHash, mustChangePassword: false },
    });
    await this.revokeAllForUser(user.id);
    await this.audit.log({
      workspaceId: user.workspaceId, actorId: user.id, entityType: 'auth',
      entityId: user.id, action: 'password-reset-completed', ip,
    });
    return { ok: true };
  }

  /** Completes activation: the invited user picks their own password and the account goes live. */
  async activate(rawToken: string, newPassword: string, ip?: string) {
    const policyError = validatePassword(newPassword);
    if (policyError) throw new BadRequestException(policyError);
    const row = await this.tokens.consume(rawToken, 'ACTIVATION');
    const passwordHash = await this.hashPassword(newPassword);
    const user = await this.prisma.user.update({
      where: { id: row.userId },
      data: { passwordHash, mustChangePassword: false, activatedAt: new Date() },
    });
    await this.audit.log({
      workspaceId: user.workspaceId, actorId: user.id, entityType: 'auth',
      entityId: user.id, action: 'account-activated', ip,
    });
    return { ok: true, email: user.email };
  }

  /** Issues an EngPro session for an already-authenticated identity (used by SSO). */
  async issueSession(
    user: { id: string; workspaceId: string; role: string; siteId: string | null; mustChangePassword: boolean },
    userAgent?: string,
  ) {
    const accessToken = await this.signAccessFor(user.id);
    const refreshToken = await this.issueRefresh(user.id, randomUUID(), userAgent);
    return { accessToken, refreshToken };
  }

  /** Re-issues a session for the current user, e.g. after MFA enrolment changes the claims. */
  async reissue(userId: string, userAgent?: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true, deletedAt: null },
    });
    if (!user) throw new UnauthorizedException();
    const accessToken = await this.signAccessFor(user.id);
    const refreshToken = await this.issueRefresh(user.id, randomUUID(), userAgent);
    return { accessToken, refreshToken };
  }

  /** Re-authenticates the current user before a sensitive change (turning MFA off). */
  async assertPassword(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true, deletedAt: null }, select: { passwordHash: true },
    });
    if (!user) throw new UnauthorizedException();
    const ok = await argon2.verify(user.passwordHash, password || '').catch(() => false);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');
  }

  async revokeAllForUser(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null }, data: { revokedAt: new Date() },
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { workspace: true, site: true },
    });
    if (!user || !user.isActive || user.deletedAt) throw new UnauthorizedException();
    return this.profile(user);
  }

  profile(user: any) {
    return {
      user: {
        id: user.id, username: user.username, email: user.email, fullName: user.fullName, role: user.role,
        siteId: user.siteId ?? null, siteName: user.site?.name ?? null,
        avatarColor: user.avatarColor, mustChangePassword: user.mustChangePassword,
      },
      workspace: user.workspace ? {
        id: user.workspace.id, company: user.workspace.company,
        subtitle: user.workspace.subtitle, ticketPrefix: user.workspace.ticketPrefix,
        timezone: user.workspace.timezone,
      } : undefined,
    };
  }
}
