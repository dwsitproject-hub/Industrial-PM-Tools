import {
  Body, Controller, ConflictException, Delete, Get, NotFoundException,
  Param, Patch, Post, Req,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Request } from 'express';
import { CurrentUser, JwtUser, RequirePerm } from '../common/auth.types';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { ServiceScoped } from '../common/route-policy';

class CreateSiteDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsOptional() @IsInt() @Min(0) @Max(8) color?: number;
}
class UpdateSiteDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(8) color?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Controller('sites')
export class SitesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @ServiceScoped('workspace site names appear in every picker; scoped to the caller workspace')
  @Get()
  async list(@CurrentUser() user: JwtUser) {
    return this.prisma.site.findMany({
      where: { workspaceId: user.ws },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, color: true, isActive: true },
    });
  }

  @RequirePerm('stSites', 'create')
  @Post()
  async create(@CurrentUser() user: JwtUser, @Body() dto: CreateSiteDto, @Req() req: Request) {
    try {
      const site = await this.prisma.site.create({
        data: { workspaceId: user.ws, name: dto.name.trim(), color: dto.color ?? 3 },
      });
      await this.audit.log({
        workspaceId: user.ws, actorId: user.sub, entityType: 'site', entityId: site.id,
        action: 'create', after: site, ip: req.ip,
      });
      return site;
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('A site with this name already exists');
      throw e;
    }
  }

  @RequirePerm('stSites', 'edit')
  @Patch(':id')
  async update(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: UpdateSiteDto, @Req() req: Request) {
    const existing = await this.prisma.site.findFirst({ where: { id, workspaceId: user.ws } });
    if (!existing) throw new NotFoundException();
    try {
      const site = await this.prisma.site.update({
        where: { id },
        data: { name: dto.name?.trim(), color: dto.color, isActive: dto.isActive },
      });
      await this.audit.log({
        workspaceId: user.ws, actorId: user.sub, entityType: 'site', entityId: id,
        action: 'update', before: existing, after: site, ip: req.ip,
      });
      return site;
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('A site with this name already exists');
      throw e;
    }
  }

  @RequirePerm('stSites', 'delete')
  @Delete(':id')
  async remove(@CurrentUser() user: JwtUser, @Param('id') id: string, @Req() req: Request) {
    const existing = await this.prisma.site.findFirst({ where: { id, workspaceId: user.ws } });
    if (!existing) throw new NotFoundException();
    const activeTickets = await this.prisma.ticket.count({
      where: { siteId: id, deletedAt: null, status: { not: 'DONE' } },
    });
    if (activeTickets > 0) {
      throw new ConflictException(`Site has ${activeTickets} active ticket(s). Complete or reassign them first.`);
    }
    const siteUsers = await this.prisma.user.count({ where: { siteId: id, deletedAt: null } });
    if (siteUsers > 0) {
      throw new ConflictException('Site has user accounts attached. Deactivate or reassign them first.');
    }
    await this.prisma.site.delete({ where: { id } });
    await this.audit.log({
      workspaceId: user.ws, actorId: user.sub, entityType: 'site', entityId: id,
      action: 'delete', before: existing, ip: req.ip,
    });
    return { ok: true };
  }
}
