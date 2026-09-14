import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Request } from 'express';
import { CurrentUser, JwtUser, Public, RequirePerm } from '../common/auth.types';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';

class UpdateWorkspaceDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) company?: string;
  @IsOptional() @IsString() @MaxLength(160) subtitle?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z0-9]{2,6}$/) ticketPrefix?: string;
}

@Controller('workspace')
export class WorkspaceController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Public branding for the login screen (company name only — no sensitive data). */
  @Public()
  @Get()
  async get() {
    const ws = await this.prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!ws) return { company: 'EngPro', subtitle: null, ticketPrefix: 'EST' };
    return { id: ws.id, company: ws.company, subtitle: ws.subtitle, ticketPrefix: ws.ticketPrefix, timezone: ws.timezone };
  }

  @RequirePerm('stWorkspace', 'edit')
  @Patch()
  async update(@CurrentUser() user: JwtUser, @Body() dto: UpdateWorkspaceDto, @Req() req: Request) {
    const before = await this.prisma.workspace.findUnique({ where: { id: user.ws } });
    const ws = await this.prisma.workspace.update({
      where: { id: user.ws },
      data: { company: dto.company, subtitle: dto.subtitle, ticketPrefix: dto.ticketPrefix },
    });
    await this.audit.log({
      workspaceId: user.ws, actorId: user.sub, entityType: 'workspace', entityId: user.ws,
      action: 'update',
      before: { company: before?.company, subtitle: before?.subtitle, ticketPrefix: before?.ticketPrefix },
      after: { company: ws.company, subtitle: ws.subtitle, ticketPrefix: ws.ticketPrefix },
      ip: req.ip,
    });
    return { id: ws.id, company: ws.company, subtitle: ws.subtitle, ticketPrefix: ws.ticketPrefix, timezone: ws.timezone };
  }
}
