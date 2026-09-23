import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { EventsGateway } from '../events/events.gateway';
import { JwtUser } from '../common/auth.types';
import { PermissionsService, RolePerms } from '../common/permissions';
import { isOverdue, jsonSafe, todayInTz } from '../common/util';
import { CreateTicketDto, ListTicketsQuery, UpdateTicketDto } from './tickets.dto';

const ASSIGNEE_SELECT = { select: { id: true, fullName: true, avatarColor: true, isActive: true } };
const SITE_SELECT = { select: { id: true, name: true, color: true } };

const MANAGER_ADMIN_FIELDS = [
  'name', 'type', 'priority', 'status', 'deadline', 'requestor', 'source',
  'description', 'assigneeId', 'tenderStatus', 'tenderValue',
];

@Injectable()
export class TicketsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private events: EventsGateway,
    private permsSvc: PermissionsService,
  ) {}

  private tz(): string {
    return process.env.WORKSPACE_TZ || 'Asia/Jakarta';
  }

  private permsFor(user: JwtUser): Promise<RolePerms> {
    return this.permsSvc.get(user.ws, user.role);
  }

  /** Ticket pages are gated by the configurable matrix: at least one ticket view must be granted. */
  private ensureTicketView(perms: RolePerms): void {
    const p = perms.pages;
    if (!(p.board.view || p.ticketsAll.view || p.ticketsMy.view)) {
      throw new ForbiddenException({
        error: 'PermissionDenied',
        message: 'Your role has no ticket visibility. Ask a manager to adjust it in Settings → Roles.',
      });
    }
  }

  /**
   * Which fields may THIS user edit on THIS ticket.
   * The per-role envelopes are fixed (PRD 4.3); Settings → Roles turns editing on/off per role.
   */
  editableFields(user: JwtUser, ticket: { assigneeId: string | null; siteId: string | null; status: string }, perms: RolePerms): string[] {
    if (!perms.pages.tickets.edit) return [];
    if (user.role === 'MANAGER' || user.role === 'ADMIN') return MANAGER_ADMIN_FIELDS;
    if (user.role === 'ESTIMATOR' && ticket.assigneeId === user.sub) return ['status'];
    if (user.role === 'SITE_ADMIN' && ticket.siteId && ticket.siteId === user.siteId) return ['deadline'];
    return [];
  }

  private canAddNote(user: JwtUser, ticket: { assigneeId: string | null; siteId: string | null }, perms: RolePerms): boolean {
    if (!perms.pages.tickets.edit) return false;
    if (user.role === 'MANAGER' || user.role === 'ADMIN') return true;
    if (user.role === 'ESTIMATOR') return ticket.assigneeId === user.sub;
    if (user.role === 'SITE_ADMIN') return !!ticket.siteId && ticket.siteId === user.siteId;
    return false;
  }

  private canDelete(user: JwtUser, ticket: { assigneeId: string | null; siteId: string | null; status: string }, perms: RolePerms): { ok: boolean; reason?: string } {
    if (!perms.pages.tickets.delete) return { ok: false, reason: 'Your role cannot delete tickets.' };
    if (user.role === 'MANAGER' || user.role === 'ADMIN') return { ok: true };
    const inReach = user.role === 'SITE_ADMIN'
      ? ticket.siteId === user.siteId
      : ticket.assigneeId === user.sub;
    if (inReach) {
      if (ticket.status === 'NEW') return { ok: true };
      return { ok: false, reason: 'Work has started — add a note or ask the estimation team to put it on Hold instead.' };
    }
    return { ok: false, reason: 'You can only delete your own new tickets.' };
  }

  private scopeWhere(user: JwtUser, perms: RolePerms): any {
    const where: any = { workspaceId: user.ws };
    // AR-03: a user from an external company never sees another company's tickets, whatever
    // their role says. Like the site filter below, this is an identity constraint — it is not
    // configurable in Settings -> Roles and a manager cannot widen it, because the whole point
    // is that no permission mistake can expose one customer's tenders to another.
    if (user.ext) where.companyId = user.co ?? '00000000-0000-0000-0000-000000000000';
    if (user.role === 'SITE_ADMIN') where.siteId = user.siteId; // identity constraint, always on
    if (perms.ticketScope === 'OWN' && user.role !== 'MANAGER') {
      where.AND = [{ OR: [{ assigneeId: user.sub }, { submittedById: user.sub }] }];
    }
    return where;
  }

  async create(user: JwtUser, dto: CreateTicketDto, ip?: string) {
    const tz = this.tz();
    if (dto.deadline < todayInTz(tz) && !dto.allowPast) {
      throw new BadRequestException('Deadline is in the past. Set allowPast=true to register a backdated request.');
    }
    const isSiteAdmin = user.role === 'SITE_ADMIN';
    const data: any = {
      workspaceId: user.ws,
      name: dto.name.trim(),
      type: dto.type,
      priority: dto.priority,
      status: 'NEW',
      deadline: new Date(dto.deadline + 'T00:00:00Z'),
      requestor: dto.requestor || null,
      source: dto.source || null,
      description: dto.description || null,
      submittedById: user.sub,
      assigneeId: isSiteAdmin ? null : dto.assigneeId || null,
      siteId: isSiteAdmin ? user.siteId : dto.siteId || null,
      // Stamped from the authenticated identity, exactly as siteId is for a site admin.
      // Nothing in the request body can influence which company owns the record.
      companyId: user.co ?? null,
    };
    if (data.assigneeId) {
      const assignee = await this.prisma.user.findFirst({
        where: {
          id: data.assigneeId, workspaceId: user.ws, isActive: true, deletedAt: null,
          ...(user.ext ? { companyId: user.co } : {}),
        },
      });
      if (!assignee) throw new BadRequestException('Assignee not found or inactive');
    }

    const ticket = await this.prisma.$transaction(async (tx) => {
      const rows: any[] = await tx.$queryRaw`
        UPDATE workspaces SET ticket_seq = ticket_seq + 1
        WHERE id = ${user.ws}::uuid
        RETURNING ticket_seq, ticket_prefix`;
      const seq = Number(rows[0].ticket_seq);
      const ticketNo = `${rows[0].ticket_prefix}-${String(seq).padStart(3, '0')}`;
      const created = await tx.ticket.create({
        data: { ...data, ticketNo },
        include: { assignee: ASSIGNEE_SELECT, site: SITE_SELECT },
      });
      await this.audit.log({
        workspaceId: user.ws, actorId: user.sub, entityType: 'ticket', entityId: created.id,
        action: 'create', after: created, ip,
      }, tx);
      return created;
    });

    this.events.emitTicket('ticket.created', { id: ticket.id, workspaceId: user.ws, siteId: ticket.siteId, companyId: ticket.companyId });
    return this.decorate(ticket);
  }

  async list(user: JwtUser, q: ListTicketsQuery) {
    const tz = this.tz();
    const perms = await this.permsFor(user);
    this.ensureTicketView(perms);
    const where: any = { ...this.scopeWhere(user, perms), deletedAt: null };
    if (q.includeDeleted === 'true' && user.role === 'MANAGER') delete where.deletedAt;
    if (q.status) where.status = q.status;
    if (q.type) where.type = q.type;
    if (q.priority) where.priority = q.priority;
    if (q.siteId && user.role !== 'SITE_ADMIN') where.siteId = q.siteId;
    if (q.assigneeId === 'unassigned') where.assigneeId = null;
    else if (q.assigneeId === 'me') where.assigneeId = user.sub;
    else if (q.assigneeId) where.assigneeId = q.assigneeId;
    if (q.overdue === 'true') {
      where.status = q.status ? q.status : { not: 'DONE' };
      if (where.status === 'DONE') where.id = '00000000-0000-0000-0000-000000000000';
      where.deadline = { lt: new Date(todayInTz(tz) + 'T00:00:00Z') };
    }
    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { ticketNo: { contains: q.search, mode: 'insensitive' } },
        { requestor: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    const page = q.page || 1;
    const pageSize = q.pageSize || 25;
    const sort = q.sort || '-createdAt';
    const dir = sort.startsWith('-') ? 'desc' : 'asc';
    const field = sort.replace(/^-/, '');

    const [total, items] = await Promise.all([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.findMany({
        where,
        orderBy: { [field]: dir },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          assignee: ASSIGNEE_SELECT,
          site: SITE_SELECT,
          notes: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true, authorLabel: true, createdAt: true } },
          _count: { select: { notes: true } },
        },
      }),
    ]);
    return {
      items: items.map((t) => this.decorate(t)),
      total, page, pageSize,
    };
  }

  async getById(user: JwtUser, id: string) {
    const perms = await this.permsFor(user);
    this.ensureTicketView(perms);
    const ticket = await this.prisma.ticket.findFirst({
      where: { ...this.scopeWhere(user, perms), id, deletedAt: null },
      include: {
        assignee: ASSIGNEE_SELECT,
        site: SITE_SELECT,
        submittedBy: { select: { id: true, fullName: true } },
        notes: { orderBy: { createdAt: 'desc' }, include: { author: { select: { id: true, fullName: true, avatarColor: true } } } },
        kpiEntries: { where: { type: { in: ['AUTO', 'REVERSAL'] } }, select: { type: true, points: true, createdAt: true } },
      },
    });
    if (!ticket) throw new NotFoundException();
    const del = this.canDelete(user, ticket as any, perms);
    return {
      ...this.decorate(ticket),
      permissions: {
        editableFields: this.editableFields(user, ticket as any, perms),
        canAddNote: this.canAddNote(user, ticket as any, perms),
        canDelete: del.ok,
      },
    };
  }

  async update(user: JwtUser, id: string, dto: UpdateTicketDto, ip?: string) {
    const perms = await this.permsFor(user);
    const ticket = await this.prisma.ticket.findFirst({
      where: { ...this.scopeWhere(user, perms), id, deletedAt: null },
    });
    if (!ticket) throw new NotFoundException();

    const requested = Object.keys(dto).filter((k) => k !== 'version' && (dto as any)[k] !== undefined);
    if (requested.length === 0) throw new BadRequestException('No fields to update');
    const editable = this.editableFields(user, ticket as any, perms);
    const denied = requested.filter((f) => !editable.includes(f));
    if (denied.length) {
      throw new ForbiddenException({ error: 'FieldNotPermitted', fields: denied });
    }
    if (dto.assigneeId) {
      const assignee = await this.prisma.user.findFirst({
        where: {
          id: dto.assigneeId, workspaceId: user.ws, deletedAt: null,
          // AR-03: an external user cannot hand their ticket to someone outside their company,
          // which would otherwise leak the record across the boundary.
          ...(user.ext ? { companyId: user.co } : {}),
        },
      });
      if (!assignee) throw new BadRequestException('Assignee not found');
    }
    if ((dto.tenderStatus || dto.tenderValue != null)
        && !['PROJECT_TENDER', 'OPS_TENDER'].includes(dto.type ?? ticket.type)) {
      throw new BadRequestException('Tender fields apply to tender-type tickets only');
    }

    const tz = this.tz();
    const prevStatus = ticket.status;
    const newStatus = dto.status ?? prevStatus;
    const effAssignee = dto.assigneeId !== undefined ? dto.assigneeId : ticket.assigneeId;
    const effDeadline = dto.deadline ? dto.deadline : (ticket.deadline.toISOString().slice(0, 10));

    const result = await this.prisma.$transaction(async (tx) => {
      const data: any = { version: { increment: 1 } };
      for (const f of requested) {
        if (f === 'deadline') data.deadline = new Date(dto.deadline + 'T00:00:00Z');
        else data[f] = (dto as any)[f];
      }
      if (newStatus === 'DONE' && prevStatus !== 'DONE') data.completedAt = new Date();
      if (newStatus !== 'DONE' && prevStatus === 'DONE') data.completedAt = null;

      const count = await tx.ticket.updateMany({
        where: { id, version: dto.version, deletedAt: null },
        data,
      });
      if (count.count === 0) {
        const current = await tx.ticket.findUnique({ where: { id }, select: { version: true } });
        throw new ConflictException({
          error: 'VersionConflict',
          message: 'Ticket was modified by another user.',
          currentVersion: current?.version,
        });
      }

      let kpiAward: any = null;
      // AUTO award on transition into DONE
      if (newStatus === 'DONE' && prevStatus !== 'DONE' && effAssignee) {
        const settings = await tx.kpiSettings.findUnique({ where: { workspaceId: user.ws } });
        const cfg = settings ?? { pointOnTarget: 3, pointMissTarget: -2 };
        const onTime = todayInTz(tz) <= effDeadline;
        const points = onTime ? cfg.pointOnTarget : cfg.pointMissTarget;
        const now = new Date();
        const priorAuto = await tx.kpiEntry.aggregate({
          where: { OR: [{ ticketId: id }, { ticketNo: ticket.ticketNo, ticketId: null }], type: { in: ['AUTO', 'REVERSAL'] } },
          _sum: { points: true },
        });
        const priorSum = priorAuto._sum.points ?? 0;
        const anyAuto = await tx.kpiEntry.count({ where: { ticketId: id, type: 'AUTO' } });
        if (priorSum === 0) {
          try {
            await tx.kpiEntry.create({
              data: {
                workspaceId: user.ws,
                userId: effAssignee,
                month: now.getMonth() + 1,
                year: now.getFullYear(),
                points,
                type: 'AUTO',
                description: `${onTime ? 'On target' : 'Missed deadline'} — ${ticket.ticketNo} ${ticket.name}`,
                // partial unique index allows one AUTO per ticket_id; re-awards keep the label only
                ticketId: anyAuto === 0 ? id : null,
                ticketNo: ticket.ticketNo,
                createdBy: 'System',
              },
            });
            kpiAward = { type: 'AUTO', points, reason: onTime ? 'ON_TARGET' : 'MISSED_DEADLINE' };
          } catch (e: any) {
            if (e.code !== 'P2002') throw e; // concurrent duplicate award: engine said no — fine
          }
        }
      }
      // REVERSAL on leaving DONE
      if (prevStatus === 'DONE' && newStatus !== 'DONE') {
        const sum = await tx.kpiEntry.aggregate({
          where: { OR: [{ ticketId: id }, { ticketNo: ticket.ticketNo, ticketId: null }], type: { in: ['AUTO', 'REVERSAL'] } },
          _sum: { points: true },
        });
        const total = sum._sum.points ?? 0;
        if (total !== 0 && ticket.assigneeId) {
          const now = new Date();
          await tx.kpiEntry.create({
            data: {
              workspaceId: user.ws,
              userId: ticket.assigneeId,
              month: now.getMonth() + 1,
              year: now.getFullYear(),
              points: -total,
              type: 'REVERSAL',
              description: `Reversal — reopened ${ticket.ticketNo}`,
              ticketNo: ticket.ticketNo,
              createdBy: 'System',
            },
          });
          kpiAward = { type: 'REVERSAL', points: -total };
        }
      }

      const updated = await tx.ticket.findUnique({
        where: { id },
        include: { assignee: ASSIGNEE_SELECT, site: SITE_SELECT },
      });
      await this.audit.log({
        workspaceId: user.ws, actorId: user.sub, entityType: 'ticket', entityId: id,
        action: 'update', before: ticket, after: jsonSafe({ ...dto }), ip,
      }, tx);
      return { updated, kpiAward };
    });

    this.events.emitTicket('ticket.updated', {
      id, workspaceId: user.ws, siteId: result.updated!.siteId,
      companyId: result.updated!.companyId, changed: requested,
    });
    if (result.kpiAward && effAssignee) {
      this.events.emitWorkspace(user.ws, 'kpi.updated', {
        workspaceId: user.ws, userId: effAssignee,
        year: new Date().getFullYear(), month: new Date().getMonth() + 1,
      });
    }
    return { ...this.decorate(result.updated), kpiAward: result.kpiAward };
  }

  async softDelete(user: JwtUser, id: string, ip?: string) {
    const perms = await this.permsFor(user);
    const ticket = await this.prisma.ticket.findFirst({
      where: { ...this.scopeWhere(user, perms), id, deletedAt: null },
    });
    if (!ticket) throw new NotFoundException();
    const del = this.canDelete(user, ticket as any, perms);
    if (!del.ok) throw new ForbiddenException({ error: 'DeleteNotPermitted', message: del.reason });
    await this.prisma.ticket.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log({
      workspaceId: user.ws, actorId: user.sub, entityType: 'ticket', entityId: id,
      action: 'delete', before: ticket, ip,
    });
    this.events.emitTicket('ticket.deleted', { id, workspaceId: user.ws, siteId: ticket.siteId, companyId: ticket.companyId });
    return { ok: true };
  }

  async restore(user: JwtUser, id: string, ip?: string) {
    const perms = await this.permsFor(user);
    // The row scope matters as much as the permission: restore previously searched the whole
    // workspace, so a site admin could resurrect another site's ticket by id. Scope it the way
    // every other ticket route is scoped, and answer 404 rather than 403 so the existence of
    // an out-of-reach ticket is not disclosed.
    const ticket = await this.prisma.ticket.findFirst({
      where: { ...this.scopeWhere(user, perms), id, deletedAt: { not: null } },
    });
    if (!ticket) throw new NotFoundException();
    if (!perms.pages.tickets.delete) {
      throw new ForbiddenException({
        error: 'RestoreNotPermitted', message: 'Your role cannot restore deleted tickets.',
      });
    }
    if (user.role !== 'MANAGER' && user.role !== 'ADMIN') {
      const inReach = user.role === 'SITE_ADMIN'
        ? ticket.siteId === user.siteId
        : ticket.assigneeId === user.sub || ticket.submittedById === user.sub;
      if (!inReach) {
        throw new ForbiddenException({
          error: 'RestoreNotPermitted', message: 'You can only restore your own tickets.',
        });
      }
    }
    await this.prisma.ticket.update({ where: { id }, data: { deletedAt: null } });
    await this.audit.log({
      workspaceId: user.ws, actorId: user.sub, entityType: 'ticket', entityId: id,
      action: 'restore', ip,
    });
    this.events.emitTicket('ticket.restored', { id, workspaceId: user.ws, siteId: ticket.siteId, companyId: ticket.companyId });
    return { ok: true };
  }

  async stats(user: JwtUser) {
    const tz = this.tz();
    const perms = await this.permsFor(user);
    this.ensureTicketView(perms);
    const where: any = { ...this.scopeWhere(user, perms), deletedAt: null };
    const todayUtc = new Date(todayInTz(tz) + 'T00:00:00Z');
    const [total, done, overdue, unassigned, byStatus, byType, workloadRaw, users] = await Promise.all([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.count({ where: { ...where, status: 'DONE' } }),
      this.prisma.ticket.count({ where: { ...where, status: { not: 'DONE' }, deadline: { lt: todayUtc } } }),
      this.prisma.ticket.count({ where: { ...where, assigneeId: null, status: { not: 'DONE' } } }),
      this.prisma.ticket.groupBy({ by: ['status'], where, _count: true }),
      this.prisma.ticket.groupBy({ by: ['type'], where, _count: true }),
      this.prisma.ticket.groupBy({ by: ['assigneeId', 'status'], where: { ...where, assigneeId: { not: null } }, _count: true }),
      this.prisma.user.findMany({
        where: { workspaceId: user.ws, deletedAt: null, role: { in: ['ESTIMATOR', 'ADMIN'] } },
        select: { id: true, fullName: true, avatarColor: true, role: true, isActive: true },
      }),
    ]);
    const workload = users
      .filter((u) => u.role === 'ESTIMATOR' || workloadRaw.some((w) => w.assigneeId === u.id))
      .map((u) => {
        const mine = workloadRaw.filter((w) => w.assigneeId === u.id);
        const doneCount = mine.filter((w) => w.status === 'DONE').reduce((s, w) => s + (w._count as number), 0);
        const totalCount = mine.reduce((s, w) => s + (w._count as number), 0);
        return { userId: u.id, fullName: u.fullName, avatarColor: u.avatarColor, isActive: u.isActive, active: totalCount - doneCount, done: doneCount };
      });
    return {
      total, done,
      completionRate: total ? Math.round((done / total) * 100) / 100 : 0,
      overdue, unassigned,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count])),
      byType: Object.fromEntries(byType.map((r) => [r.type, r._count])),
      workload,
    };
  }

  async addNote(user: JwtUser, ticketId: string, content: string, ip?: string) {
    const perms = await this.permsFor(user);
    const ticket = await this.prisma.ticket.findFirst({
      where: { ...this.scopeWhere(user, perms), id: ticketId, deletedAt: null },
    });
    if (!ticket) throw new NotFoundException();
    if (!this.canAddNote(user, ticket as any, perms)) {
      throw new ForbiddenException({ error: 'NoteNotPermitted', message: 'You cannot add notes to this ticket.' });
    }
    const author = await this.prisma.user.findUnique({ where: { id: user.sub }, select: { fullName: true } });
    const note = await this.prisma.ticketNote.create({
      data: {
        ticketId,
        authorId: user.sub,
        authorLabel: author?.fullName || 'Unknown',
        content,
        statusAtTime: ticket.status,
      },
      include: { author: { select: { id: true, fullName: true, avatarColor: true } } },
    });
    await this.audit.log({
      workspaceId: user.ws, actorId: user.sub, entityType: 'note', entityId: note.id,
      action: 'create', after: { ticketId, content }, ip,
    });
    this.events.emitTicket('note.created', { id: ticketId, workspaceId: user.ws, siteId: ticket.siteId, companyId: ticket.companyId });
    return note;
  }

  async listNotes(user: JwtUser, ticketId: string) {
    const perms = await this.permsFor(user);
    this.ensureTicketView(perms);
    const ticket = await this.prisma.ticket.findFirst({
      where: { ...this.scopeWhere(user, perms), id: ticketId, deletedAt: null }, select: { id: true },
    });
    if (!ticket) throw new NotFoundException();
    return this.prisma.ticketNote.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'desc' },
      include: { author: { select: { id: true, fullName: true, avatarColor: true } } },
    });
  }

  private decorate(t: any) {
    if (!t) return t;
    const tz = this.tz();
    const { _count, notes, kpiEntries, ...rest } = t;
    return {
      ...rest,
      deadline: t.deadline instanceof Date ? t.deadline.toISOString().slice(0, 10) : t.deadline,
      tenderValue: t.tenderValue != null ? Number(t.tenderValue) : null,
      isOverdue: isOverdue(t.deadline, t.status, tz),
      lastNote: notes && notes.length && _count !== undefined ? notes[0] : undefined,
      notes: _count === undefined ? notes : undefined,
      noteCount: _count ? _count.notes : undefined,
      kpiNet: kpiEntries ? kpiEntries.reduce((s: number, e: any) => s + e.points, 0) : undefined,
    };
  }
}
