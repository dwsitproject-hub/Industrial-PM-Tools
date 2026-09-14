import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, JwtUser, RequirePerm } from '../common/auth.types';
import { PrismaService } from '../prisma.service';

@Controller('audit')
export class AuditController {
  constructor(private prisma: PrismaService) {}

  @RequirePerm('stAudit', 'view')
  @Get()
  async list(
    @CurrentUser() user: JwtUser,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('action') action?: string,
    @Query('page') page?: string,
  ) {
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    const pageSize = 50;
    const where: any = { workspaceId: user.ws };
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    if (action) where.action = action;
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * pageSize,
        take: pageSize,
        include: { actor: { select: { id: true, fullName: true } } },
      }),
    ]);
    return {
      total, page: p, pageSize,
      items: rows.map((r) => ({ ...r, id: Number(r.id) })),
    };
  }
}
