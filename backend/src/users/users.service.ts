import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthService } from '../auth/auth.service';
import { EventsGateway } from '../events/events.gateway';
import { JwtUser } from '../common/auth.types';
import { PermissionsService } from '../common/permissions';
import { TokensService } from '../auth/tokens.service';

const PUBLIC_SELECT = {
  id: true, username: true, fullName: true, role: true, siteId: true,
  avatarColor: true, isActive: true,
};

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private auth: AuthService,
    private events: EventsGateway,
    private permsSvc: PermissionsService,
    private tokens: TokensService,
  ) {}

  private async companyName(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    return ws?.company || 'EngPro';
  }

  async list(user: JwtUser, role?: string, active?: string) {
    const where: any = { workspaceId: user.ws, deletedAt: null };
    if (role) where.role = role;
    if (active === 'true') where.isActive = true;
    if (active === 'false') where.isActive = false;
    if (await this.permsSvc.can(user, 'stUsers', 'view')) {
      const rows = await this.prisma.user.findMany({
        where, orderBy: { fullName: 'asc' },
        select: { ...PUBLIC_SELECT, email: true, mustChangePassword: true, activatedAt: true, createdAt: true, site: { select: { id: true, name: true } } },
      });
      return rows;
    }
    // directory for non-managers (assignee dropdowns, avatars)
    return this.prisma.user.findMany({
      where: { ...where, isActive: true },
      orderBy: { fullName: 'asc' },
      select: PUBLIC_SELECT,
    });
  }

  /** Usernames are a legacy identifier only (login is by email); derive one that is free. */
  private async deriveUsername(workspaceId: string, email: string, wanted?: string): Promise<string> {
    const base = (wanted || email.split('@')[0] || 'user')
      .toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24) || 'user';
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : `${base}${i + 1}`;
      const clash = await this.prisma.user.findFirst({
        where: { workspaceId, username: candidate }, select: { id: true },
      });
      if (!clash) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  async create(actor: JwtUser, dto: any, ip?: string) {
    const email = String(dto.email).trim().toLowerCase();
    const username = await this.deriveUsername(actor.ws, email, dto.username);
    // No usable password until the invitee activates: hash an unguessable random value.
    const passwordHash = await this.auth.hashPassword(require('crypto').randomBytes(32).toString('hex'));
    try {
      const created = await this.prisma.user.create({
        data: {
          workspaceId: actor.ws,
          username,
          fullName: dto.fullName,
          email,
          role: dto.role,
          siteId: dto.role === 'SITE_ADMIN' ? dto.siteId : dto.siteId ?? null,
          avatarColor: dto.avatarColor ?? 0,
          passwordHash,
          mustChangePassword: false,
          activatedAt: null,          // pending until the activation link is used
        },
        select: { ...PUBLIC_SELECT, email: true, mustChangePassword: true, activatedAt: true },
      });
      await this.audit.log({
        workspaceId: actor.ws, actorId: actor.sub, entityType: 'user', entityId: created.id,
        action: 'create', after: created, ip,
      });
      this.events.emitWorkspace(actor.ws, 'user.updated', { id: created.id, workspaceId: actor.ws });
      const { link, mail } = await this.tokens.sendActivation(
        { id: created.id, email: created.email!, fullName: created.fullName },
        await this.companyName(actor.ws),
      );
      return {
        ...created,
        activation: { link, emailed: mail.delivered, reason: mail.reason },
      };
    } catch (e: any) {
      if (e.code === 'P2002') {
        const target = String((e.meta?.target ?? '')).toLowerCase();
        throw new ConflictException(
          target.includes('email')
            ? 'That email address is already registered'
            : 'Username already exists in this workspace',
        );
      }
      throw e;
    }
  }

  async update(actor: JwtUser, id: string, dto: any, ip?: string) {
    const existing = await this.prisma.user.findFirst({ where: { id, workspaceId: actor.ws, deletedAt: null } });
    if (!existing) return null;
    if (dto.isActive === false && id === actor.sub) {
      throw new BadRequestException('You cannot deactivate your own account.');
    }
    if (dto.role === 'SITE_ADMIN' && !(dto.siteId ?? existing.siteId)) {
      throw new BadRequestException('siteId is required for SITE_ADMIN users');
    }
    let updated;
    try {
      updated = await this.prisma.user.update({
        where: { id },
        data: {
          fullName: dto.fullName,
          email: dto.email ? String(dto.email).trim().toLowerCase() : undefined,
          role: dto.role,
          siteId: dto.siteId, avatarColor: dto.avatarColor, isActive: dto.isActive,
        },
        select: { ...PUBLIC_SELECT, email: true, mustChangePassword: true },
      });
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('That email address is already registered');
      throw e;
    }
    if (dto.isActive === false) {
      await this.auth.revokeAllForUser(id);
      this.events.emitUser(id, 'user.updated', { id, deactivated: true });
    }
    await this.audit.log({
      workspaceId: actor.ws, actorId: actor.sub, entityType: 'user', entityId: id,
      action: 'update', before: existing, after: updated, ip,
    });
    this.events.emitWorkspace(actor.ws, 'user.updated', { id, workspaceId: actor.ws });
    return updated;
  }

  /** Manager-initiated: emails a single-use link instead of handing out a password. */
  async resetPassword(actor: JwtUser, id: string, ip?: string) {
    const existing = await this.prisma.user.findFirst({ where: { id, workspaceId: actor.ws, deletedAt: null } });
    if (!existing) throw new NotFoundException();
    const company = await this.companyName(actor.ws);
    const target = { id: existing.id, email: existing.email!, fullName: existing.fullName };
    const pending = !existing.activatedAt;
    const { link, mail } = pending
      ? await this.tokens.sendActivation(target, company)
      : await this.tokens.sendReset(target, company);
    await this.audit.log({
      workspaceId: actor.ws, actorId: actor.sub, entityType: 'user', entityId: id,
      action: pending ? 'activation-resent' : 'password-reset-link-sent', ip,
    });
    return { id, kind: pending ? 'ACTIVATION' : 'PASSWORD_RESET', link, emailed: mail.delivered, reason: mail.reason };
  }

  /** Explicit resend for a pending invitation. */
  async resendActivation(actor: JwtUser, id: string, ip?: string) {
    const existing = await this.prisma.user.findFirst({ where: { id, workspaceId: actor.ws, deletedAt: null } });
    if (!existing) throw new NotFoundException();
    if (existing.activatedAt) {
      throw new BadRequestException('This account is already activated — send a password reset instead.');
    }
    const { link, mail } = await this.tokens.sendActivation(
      { id: existing.id, email: existing.email!, fullName: existing.fullName },
      await this.companyName(actor.ws),
    );
    await this.audit.log({
      workspaceId: actor.ws, actorId: actor.sub, entityType: 'user', entityId: id,
      action: 'activation-resent', ip,
    });
    return { id, kind: 'ACTIVATION', link, emailed: mail.delivered, reason: mail.reason };
  }

  async softDelete(actor: JwtUser, id: string, ip?: string) {
    const existing = await this.prisma.user.findFirst({ where: { id, workspaceId: actor.ws, deletedAt: null } });
    if (!existing) throw new NotFoundException();
    if (id === actor.sub) throw new BadRequestException('You cannot deactivate your own account.');
    const openTickets = await this.prisma.ticket.count({
      where: { assigneeId: id, deletedAt: null, status: { not: 'DONE' } },
    });
    await this.prisma.user.update({
      where: { id }, data: { isActive: false, deletedAt: new Date() },
    });
    await this.auth.revokeAllForUser(id);
    await this.audit.log({
      workspaceId: actor.ws, actorId: actor.sub, entityType: 'user', entityId: id,
      action: 'delete', before: existing, ip,
    });
    this.events.emitUser(id, 'user.updated', { id, deactivated: true });
    this.events.emitWorkspace(actor.ws, 'user.updated', { id, workspaceId: actor.ws });
    return { ok: true, openTicketsStillAssigned: openTickets };
  }
}
