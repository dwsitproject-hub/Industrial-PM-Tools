import { BadRequestException, Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, JwtUser, RequirePerm } from '../common/auth.types';
import { PermissionsService, RESOURCE_ACTIONS, defaultPerms } from '../common/permissions';
import { AuditService } from '../common/audit.service';
import { EventsGateway } from '../events/events.gateway';
import { Authenticated } from '../common/route-policy';

const CONFIGURABLE_ROLES = ['ADMIN', 'SITE_ADMIN', 'ESTIMATOR'];
const ALL_ROLES = ['MANAGER', ...CONFIGURABLE_ROLES];

@Controller('roles')
export class RolesController {
  constructor(
    private perms: PermissionsService,
    private audit: AuditService,
    private events: EventsGateway,
  ) {}

  /** The caller's own effective permissions — powers navigation and UI gating. */
  @Authenticated('returns the caller own effective permissions')
  @Get('me')
  async me(@CurrentUser() user: JwtUser) {
    const perms = await this.perms.get(user.ws, user.role);
    return { role: user.role, locked: user.role === 'MANAGER', ...perms };
  }

  /** Metadata for the Roles editor: which actions exist per resource. */
  @RequirePerm('stRoles', 'view')
  @Get('meta')
  meta() {
    return { resources: RESOURCE_ACTIONS, configurableRoles: CONFIGURABLE_ROLES };
  }

  @RequirePerm('stRoles', 'view')
  @Get()
  async all(@CurrentUser() user: JwtUser) {
    const out: any[] = [];
    for (const role of ALL_ROLES) {
      const perms = await this.perms.get(user.ws, role);
      out.push({ role, locked: role === 'MANAGER', ...perms });
    }
    return out;
  }

  @RequirePerm('stRoles', 'edit')
  @Put(':role')
  async update(
    @CurrentUser() user: JwtUser,
    @Param('role') role: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    if (role === 'MANAGER') {
      throw new BadRequestException('The Manager role is locked to full access and cannot be changed.');
    }
    if (!CONFIGURABLE_ROLES.includes(role)) throw new BadRequestException('Unknown role');
    const before = await this.perms.get(user.ws, role);
    const saved = await this.perms.set(user.ws, role, body, user.sub);
    await this.audit.log({
      workspaceId: user.ws, actorId: user.sub, entityType: 'role_config', entityId: null,
      action: 'update', before: { role, ...before }, after: { role, ...saved }, ip: req.ip,
    });
    this.events.emitWorkspace(user.ws, 'roles.updated', { workspaceId: user.ws, role });
    return { role, locked: false, ...saved };
  }

  /** Restore a role to its shipped defaults. */
  @RequirePerm('stRoles', 'edit')
  @Put(':role/reset')
  async reset(@CurrentUser() user: JwtUser, @Param('role') role: string, @Req() req: Request) {
    if (!CONFIGURABLE_ROLES.includes(role)) throw new BadRequestException('Unknown role');
    const saved = await this.perms.set(user.ws, role, defaultPerms(role), user.sub);
    await this.audit.log({
      workspaceId: user.ws, actorId: user.sub, entityType: 'role_config', entityId: null,
      action: 'reset', after: { role, ...saved }, ip: req.ip,
    });
    this.events.emitWorkspace(user.ws, 'roles.updated', { workspaceId: user.ws, role });
    return { role, locked: false, ...saved };
  }
}
