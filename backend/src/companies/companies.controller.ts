import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException,
  Get, NotFoundException, Param, Patch, Post, Req,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Request } from 'express';
import { CurrentUser, JwtUser, RequirePerm } from '../common/auth.types';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { ServiceScoped } from '../common/route-policy';

class CreateCompanyDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
}
class UpdateCompanyDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/**
 * AR-03: companies are the tenancy boundary. Exactly one per workspace is INTERNAL — the
 * organisation running EngPro — and its users are unscoped. Every other company is external
 * and its users see only their own records.
 *
 * Note what is deliberately absent: there is no way to create an internal company, to flip a
 * company's internal flag, or to delete one. The organisation is established by the migration
 * and stays fixed, because "which company is us" decides who is unscoped, and an endpoint
 * that can change that is an endpoint that can dissolve the boundary.
 */
@Controller('companies')
export class CompaniesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** External callers may only ever see their own company. */
  private scope(user: JwtUser): any {
    return {
      workspaceId: user.ws,
      ...(user.ext ? { id: user.co ?? '00000000-0000-0000-0000-000000000000' } : {}),
    };
  }

  private assertInternal(user: JwtUser): void {
    if (user.ext) {
      throw new ForbiddenException({
        error: 'PermissionDenied',
        message: 'Only the host organisation can manage companies.',
      });
    }
  }

  @ServiceScoped('external callers see only their own company')
  @Get()
  async list(@CurrentUser() user: JwtUser) {
    const rows = await this.prisma.company.findMany({
      where: this.scope(user),
      orderBy: [{ isInternal: 'desc' }, { name: 'asc' }],
      select: {
        id: true, name: true, isInternal: true, isActive: true, createdAt: true,
        _count: { select: { users: true, tickets: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id, name: r.name, isInternal: r.isInternal, isActive: r.isActive,
      createdAt: r.createdAt, users: r._count.users, tickets: r._count.tickets,
    }));
  }

  @RequirePerm('stCompanies', 'create')
  @Post()
  async create(@CurrentUser() user: JwtUser, @Body() dto: CreateCompanyDto, @Req() req: Request) {
    this.assertInternal(user);
    try {
      const created = await this.prisma.company.create({
        data: { workspaceId: user.ws, name: dto.name.trim(), isInternal: false },
      });
      await this.audit.log({
        workspaceId: user.ws, actorId: user.sub, entityType: 'company', entityId: created.id,
        action: 'create', after: created, ip: req.ip,
      });
      return created;
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('A company with that name already exists');
      throw e;
    }
  }

  @RequirePerm('stCompanies', 'edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: JwtUser, @Param('id') id: string,
    @Body() dto: UpdateCompanyDto, @Req() req: Request,
  ) {
    this.assertInternal(user);
    const existing = await this.prisma.company.findFirst({ where: { id, workspaceId: user.ws } });
    if (!existing) throw new NotFoundException();
    if (existing.isInternal && dto.isActive === false) {
      throw new BadRequestException('The host organisation cannot be deactivated.');
    }
    try {
      const updated = await this.prisma.company.update({
        where: { id },
        data: { name: dto.name?.trim(), isActive: dto.isActive },
      });
      await this.audit.log({
        workspaceId: user.ws, actorId: user.sub, entityType: 'company', entityId: id,
        action: 'update', before: existing, after: updated, ip: req.ip,
      });
      return updated;
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('A company with that name already exists');
      throw e;
    }
  }

  /**
   * Deactivates rather than deletes. The rows a company owns are commercial records, and the
   * foreign keys are RESTRICT precisely so history cannot be dropped by accident.
   */
  @RequirePerm('stCompanies', 'delete')
  @Delete(':id')
  async deactivate(@CurrentUser() user: JwtUser, @Param('id') id: string, @Req() req: Request) {
    this.assertInternal(user);
    const existing = await this.prisma.company.findFirst({ where: { id, workspaceId: user.ws } });
    if (!existing) throw new NotFoundException();
    if (existing.isInternal) throw new BadRequestException('The host organisation cannot be removed.');

    const updated = await this.prisma.company.update({ where: { id }, data: { isActive: false } });
    // Deactivating the company must also close the door: leaving its users able to sign in
    // would make the control cosmetic.
    const { count } = await this.prisma.user.updateMany({
      where: { companyId: id, isActive: true }, data: { isActive: false },
    });
    await this.audit.log({
      workspaceId: user.ws, actorId: user.sub, entityType: 'company', entityId: id,
      action: 'deactivate', before: existing, after: { ...updated, usersDeactivated: count },
      ip: req.ip,
    });
    return { ok: true, usersDeactivated: count };
  }
}
