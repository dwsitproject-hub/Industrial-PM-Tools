import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { EventsGateway } from '../events/events.gateway';
import { JwtUser } from '../common/auth.types';
import { PermissionsService } from '../common/permissions';

@Injectable()
export class KpiService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private events: EventsGateway,
    private permsSvc: PermissionsService,
  ) {}

  /** Full team visibility with kpi.view; own ledger only with kpiMe.view; otherwise no access. */
  private async kpiReach(user: JwtUser): Promise<'full' | 'self'> {
    const perms = await this.permsSvc.get(user.ws, user.role);
    if (perms.pages.kpi.view) return 'full';
    if (perms.pages.kpiMe.view) return 'self';
    throw new ForbiddenException({
      error: 'PermissionDenied',
      message: 'Your role has no KPI access. Ask a manager to adjust it in Settings → Roles.',
    });
  }

  async getSettings(workspaceId: string) {
    const s = await this.prisma.kpiSettings.findUnique({ where: { workspaceId } });
    return s ?? { workspaceId, pointOpening: 10, pointOnTarget: 3, pointMissTarget: -2 };
  }

  async putSettings(user: JwtUser, dto: any, ip?: string) {
    const before = await this.prisma.kpiSettings.findUnique({ where: { workspaceId: user.ws } });
    const s = await this.prisma.kpiSettings.upsert({
      where: { workspaceId: user.ws },
      create: { workspaceId: user.ws, ...dto, updatedById: user.sub },
      update: { ...dto, updatedById: user.sub },
    });
    await this.audit.log({
      workspaceId: user.ws, actorId: user.sub, entityType: 'kpi_settings', entityId: user.ws,
      action: 'update', before, after: s, ip,
    });
    return s;
  }

  /** Members visible on the KPI board: estimators (matches legacy semantics). */
  /**
   * AR-03: the KPI ledger is individual performance data. An external user with kpi.view must
   * never see the organisation's estimators, so the member set is confined to their own
   * company — which in practice means they see only themselves.
   */
  private membersWhere(user: JwtUser) {
    return {
      workspaceId: user.ws, role: 'ESTIMATOR' as const, deletedAt: null,
      ...(user.ext ? { companyId: user.co ?? '00000000-0000-0000-0000-000000000000' } : {}),
    };
  }

  async summary(user: JwtUser, year: number, month: number) {
    const reach = await this.kpiReach(user);
    const members = await this.prisma.user.findMany({
      where: reach === 'full' ? this.membersWhere(user) : { id: user.sub },
      select: { id: true, fullName: true, avatarColor: true, isActive: true },
      orderBy: { fullName: 'asc' },
    });
    const ids = members.map((m) => m.id);
    const [monthEntries, yearEntries] = await Promise.all([
      this.prisma.kpiEntry.groupBy({
        by: ['userId', 'type'],
        where: { workspaceId: user.ws, userId: { in: ids }, year, month },
        _sum: { points: true },
      }),
      this.prisma.kpiEntry.groupBy({
        by: ['userId', 'month'],
        where: { workspaceId: user.ws, userId: { in: ids }, year },
        _sum: { points: true },
      }),
    ]);
    const memberRows = members.map((m) => {
      const rows = monthEntries.filter((e) => e.userId === m.id);
      const get = (t: string) => rows.find((r) => r.type === t)?._sum.points ?? 0;
      const noDeadlineFlagged = 0;
      return {
        ...m,
        total: rows.reduce((s, r) => s + (r._sum.points ?? 0), 0),
        breakdown: { opening: get('OPENING'), auto: get('AUTO') + get('REVERSAL'), manual: get('MANUAL') },
        noDeadlineFlagged,
      };
    }).sort((a, b) => b.total - a.total);
    const monthStrip = Array.from({ length: 12 }, (_, i) => {
      const mo = i + 1;
      const total = yearEntries.filter((e) => e.month === mo).reduce((s, e) => s + (e._sum.points ?? 0), 0);
      return { month: mo, total };
    });
    return { year, month, members: memberRows, monthStrip };
  }

  async entries(user: JwtUser, year: number, month?: number, userId?: string) {
    const reach = await this.kpiReach(user);
    if (reach === 'self' && userId && userId !== user.sub) throw new ForbiddenException();
    const where: any = { workspaceId: user.ws, year };
    if (month) where.month = month;
    where.userId = reach === 'full' ? (userId || undefined) : user.sub;
    // AR-03: full reach means "the whole team", and for an external user the team is their
    // own company. Without this, kpi.view would expose the organisation's performance data.
    if (user.ext) where.user = { companyId: user.co ?? '00000000-0000-0000-0000-000000000000' };
    const rows = await this.prisma.kpiEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, fullName: true, avatarColor: true } } },
      take: 500,
    });
    return rows;
  }

  /** AR-03: refuses to award or adjust points for a member outside the actor's company. */
  private async assertReachable(user: JwtUser, userIds: string[]): Promise<void> {
    if (!user.ext || userIds.length === 0) return;
    const reachable = await this.prisma.user.count({
      where: { id: { in: userIds }, workspaceId: user.ws, companyId: user.co },
    });
    if (reachable !== new Set(userIds).size) {
      throw new ForbiddenException({
        error: 'PermissionDenied', message: 'That member is not in your company.',
      });
    }
  }

  async setOpening(user: JwtUser, dto: { year: number; month: number; items: { userId: string; points: number }[] }, ip?: string) {
    await this.assertReachable(user, dto.items.map((it) => it.userId));
    await this.prisma.$transaction(async (tx) => {
      for (const item of dto.items) {
        await tx.kpiEntry.deleteMany({
          where: { workspaceId: user.ws, userId: item.userId, year: dto.year, month: dto.month, type: 'OPENING' },
        });
        await tx.kpiEntry.create({
          data: {
            workspaceId: user.ws, userId: item.userId, year: dto.year, month: dto.month,
            points: item.points, type: 'OPENING',
            description: `Opening points ${dto.month}/${dto.year}`,
            createdById: user.sub, createdBy: 'Manager',
          },
        });
      }
      await this.audit.log({
        workspaceId: user.ws, actorId: user.sub, entityType: 'kpi_entry', action: 'opening-set',
        after: dto, ip,
      }, tx);
    });
    for (const item of dto.items) {
      this.events.emitWorkspace(user.ws, 'kpi.updated', {
        workspaceId: user.ws, userId: item.userId, year: dto.year, month: dto.month,
      });
    }
    return { ok: true, count: dto.items.length };
  }

  async addManual(user: JwtUser, dto: any, ip?: string) {
    await this.assertReachable(user, [dto.userId]);
    const entry = await this.prisma.kpiEntry.create({
      data: {
        workspaceId: user.ws, userId: dto.userId, year: dto.year, month: dto.month,
        points: dto.points, type: 'MANUAL', description: dto.description,
        createdById: user.sub, createdBy: 'Manager',
      },
      include: { user: { select: { id: true, fullName: true } } },
    });
    await this.audit.log({
      workspaceId: user.ws, actorId: user.sub, entityType: 'kpi_entry', entityId: entry.id,
      action: 'create', after: entry, ip,
    });
    this.events.emitWorkspace(user.ws, 'kpi.updated', {
      workspaceId: user.ws, userId: dto.userId, year: dto.year, month: dto.month,
    });
    return entry;
  }

  async exportCsv(user: JwtUser, year: number): Promise<string> {
    const where: any = { workspaceId: user.ws, year };
    if (user.ext) where.user = { companyId: user.co ?? '00000000-0000-0000-0000-000000000000' };
    const rows = await this.prisma.kpiEntry.findMany({
      where,
      orderBy: [{ month: 'asc' }, { createdAt: 'asc' }],
      include: { user: { select: { fullName: true } } },
    });
    /**
     * PT-F03: a cell beginning with = + - or @ is evaluated as a formula when the file is
     * opened in Excel or Sheets, which turns an exported ticket description into code running
     * on a colleague's machine. Prefixing with an apostrophe makes the spreadsheet treat the
     * value as text; the apostrophe itself is not displayed.
     */
    const esc = (v: unknown) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'member,year,month,type,points,description,ticket_no,created_by,created_at';
    const lines = rows.map((r) => [
      esc(r.user.fullName), r.year, r.month, r.type, r.points,
      esc(r.description), esc(r.ticketNo), esc(r.createdBy), r.createdAt.toISOString(),
    ].join(','));
    return [header, ...lines].join('\n');
  }
}
