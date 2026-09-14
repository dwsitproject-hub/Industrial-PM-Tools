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

const ARGON_OPTS: argon2.Options = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };

export interface TokenPair {
  accessToken: string;
  refreshToken: string; // raw value for the cookie
}

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private audit: AuditService) {}

  static hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  async hashPassword(pw: string): Promise<string> {
    return argon2.hash(pw, ARGON_OPTS);
  }

  private signAccess(user: { id: string; workspaceId: string; role: string; siteId: string | null; mustChangePassword: boolean }): string {
    const payload: JwtUser = {
      sub: user.id, ws: user.workspaceId, role: user.role as JwtUser['role'],
      siteId: user.siteId, mcp: user.mustChangePassword || undefined,
    };
    return this.jwt.sign(payload as any, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: process.env.ACCESS_TTL || '15m',
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

  async login(username: string, password: string, ip?: string, userAgent?: string) {
    const user = await this.prisma.user.findFirst({
      where: { username: (username || '').toLowerCase(), isActive: true, deletedAt: null },
      include: { workspace: true },
    });
    const invalid = new UnauthorizedException('Invalid username or password');
    if (!user) throw invalid;
    const ok = await argon2.verify(user.passwordHash, password || '').catch(() => false);
    if (!ok) {
      await this.audit.log({
        workspaceId: user.workspaceId, actorId: user.id, entityType: 'auth',
        entityId: user.id, action: 'login-failed', ip,
      });
      throw invalid;
    }
    const accessToken = this.signAccess(user);
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
    const accessToken = this.signAccess(row.user);
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
    const accessToken = this.signAccess(updated);
    const refreshToken = await this.issueRefresh(userId, randomUUID());
    return { accessToken, refreshToken, user: updated };
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
        id: user.id, username: user.username, fullName: user.fullName, role: user.role,
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
