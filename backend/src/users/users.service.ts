import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthService } from '../auth/auth.service';
import { EventsGateway } from '../events/events.gateway';
import { JwtUser } from '../common/auth.types';
import { PermissionsService } from '../common/permissions';
import { generateTempPassword } from '../common/util';

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
  ) {}

  async list(user: JwtUser, role?: string, active?: string) {
    const where: any = { workspaceId: user.ws, deletedAt: null };
    if (role) where.role = role;
    if (active === 'true') where.isActive = true;
    if (active === 'false') where.isActive = false;
    if (await this.permsSvc.can(user, 'stUsers', 'view')) {
      const rows = await this.prisma.user.findMany({
        where, orderBy: { fullName: 'asc' },
        select: { ...PUBLIC_SELECT, email: true, mustChangePassword: true, createdAt: true, site: { select: { id: true, name: true } } },
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
    const tempPassword = generateTempPassword();
    const passwordHash = await this.auth.hashPassword(tempPassword);
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
          mustChangePassword: true,
        },
        select: { ...PUBLIC_SELECT, email: true, mustChangePassword: true },
      });
      await this.audit.log({
        workspaceId: actor.ws, actorId: actor.sub, entityType: 'user', entityId: created.id,
        action: 'create', after: created, ip,
      });
      this.events.emitWorkspace(actor.ws, 'user.updated', { id: created.id, workspaceId: actor.ws });
      return { ...created, tempPassword };
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

  async resetPassword(actor: JwtUser, id: string, ip?: string) {
    const existing = await this.prisma.user.findFirst({ where: { id, workspaceId: actor.ws, deletedAt: null } });
    if (!existing) throw new NotFoundException();
    const tempPassword = generateTempPassword();
    const passwordHash = await this.auth.hashPassword(tempPassword);
    await this.prisma.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true } });
    await this.auth.revokeAllForUser(id);
    await this.audit.log({
      workspaceId: actor.ws, actorId: actor.sub, entityType: 'user', entityId: id,
      action: 'password-reset', ip,
    });
    return { id, tempPassword };
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
