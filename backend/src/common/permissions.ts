import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { JwtUser } from './auth.types';

/**
 * Configurable RBAC (Settings -> Roles).
 * Resources are the app's pages/tabs; actions are view/create/edit/delete where applicable.
 * MANAGER is locked to full access so the Roles page can never lock everyone out.
 */
export type TicketScope = 'ALL' | 'OWN';
export type PermAction = 'view' | 'create' | 'edit' | 'delete';

export const RESOURCES = [
  'dashboard',    // Dashboard page                       (view)
  'board',        // Kanban board page                    (view)
  'ticketsAll',   // All-tickets list page                (view)
  'ticketsMy',    // My tickets / My site tickets page    (view)
  'tickets',      // Ticket data actions                  (create/edit/delete)
  'kpi',          // Team KPI dashboard                   (view; create=opening+bonus; edit=settings)
  'kpiMe',        // Personal KPI page                    (view)
  'stWorkspace',  // Settings -> Workspace                (view/edit)
  'stUsers',      // Settings -> Users                    (view/create/edit/delete)
  'stSites',      // Settings -> Sites                    (view/create/edit/delete)
  'stCompanies',  // Settings -> Companies                (view/create/edit/delete)
  'stRoles',      // Settings -> Roles                    (view/edit)
  'stAudit',      // Settings -> Audit trail              (view)
] as const;
export type ResourceKey = (typeof RESOURCES)[number];

export const RESOURCE_ACTIONS: Record<ResourceKey, PermAction[]> = {
  dashboard: ['view'],
  board: ['view'],
  ticketsAll: ['view'],
  ticketsMy: ['view'],
  tickets: ['create', 'edit', 'delete'],
  kpi: ['view', 'create', 'edit'],
  kpiMe: ['view'],
  stWorkspace: ['view', 'edit'],
  stUsers: ['view', 'create', 'edit', 'delete'],
  stSites: ['view', 'create', 'edit', 'delete'],
  stCompanies: ['view', 'create', 'edit', 'delete'],
  stRoles: ['view', 'edit'],
  stAudit: ['view'],
};

export type PagePerms = Partial<Record<PermAction, boolean>>;
export interface RolePerms {
  ticketScope: TicketScope;
  pages: Record<ResourceKey, PagePerms>;
}

const on = (...actions: PermAction[]): PagePerms =>
  Object.fromEntries(actions.map((a) => [a, true]));

function emptyPages(): Record<ResourceKey, PagePerms> {
  const pages = {} as Record<ResourceKey, PagePerms>;
  for (const r of RESOURCES) {
    pages[r] = {};
    for (const a of RESOURCE_ACTIONS[r]) pages[r][a] = false;
  }
  return pages;
}

/** Defaults exactly mirror the behaviour shipped (and e2e-tested) before configurable roles. */
export function defaultPerms(role: string): RolePerms {
  const pages = emptyPages();
  const grant = (r: ResourceKey, p: PagePerms) => { pages[r] = { ...pages[r], ...p }; };
  switch (role) {
    case 'MANAGER':
      for (const r of RESOURCES) grant(r, on(...RESOURCE_ACTIONS[r]));
      return { ticketScope: 'ALL', pages };
    case 'ADMIN':
      grant('dashboard', on('view'));
      grant('board', on('view'));
      grant('ticketsAll', on('view'));
      grant('tickets', on('create', 'edit', 'delete'));
      return { ticketScope: 'ALL', pages };
    case 'SITE_ADMIN':
      grant('ticketsMy', on('view'));
      grant('tickets', on('create', 'edit', 'delete')); // edit=deadline only, delete=NEW only (envelope)
      return { ticketScope: 'ALL', pages };             // always hard-limited to their own site
    default: // ESTIMATOR
      grant('board', on('view'));
      grant('ticketsMy', on('view'));
      grant('tickets', on('edit'));                     // edit = status of own assignments (envelope)
      grant('kpiMe', on('view'));
      return { ticketScope: 'ALL', pages };
  }
}

/** Keep only known resources/actions, coerce to booleans; unknown input is dropped. */
export function sanitizePerms(input: any, base: RolePerms): RolePerms {
  const out: RolePerms = JSON.parse(JSON.stringify(base));
  if (input?.ticketScope === 'ALL' || input?.ticketScope === 'OWN') out.ticketScope = input.ticketScope;
  for (const r of RESOURCES) {
    const src = input?.pages?.[r];
    if (!src) continue;
    for (const a of RESOURCE_ACTIONS[r]) {
      if (typeof src[a] === 'boolean') out.pages[r][a] = src[a];
    }
  }
  return out;
}

const CACHE_TTL_MS = 15_000;

@Injectable()
export class PermissionsService {
  private cache = new Map<string, { perms: RolePerms; exp: number }>();

  constructor(private prisma: PrismaService) {}

  async get(workspaceId: string, role: string): Promise<RolePerms> {
    if (role === 'MANAGER') return defaultPerms('MANAGER'); // locked
    const key = `${workspaceId}:${role}`;
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.perms;
    const row = await this.prisma.roleConfig.findUnique({
      where: { workspaceId_role: { workspaceId, role: role as any } },
    });
    const perms = row
      ? sanitizePerms({ ticketScope: row.ticketScope, pages: (row.permissions as any)?.pages }, defaultPerms(role))
      : defaultPerms(role);
    this.cache.set(key, { perms, exp: Date.now() + CACHE_TTL_MS });
    return perms;
  }

  async set(workspaceId: string, role: string, input: any, updatedById: string): Promise<RolePerms> {
    const perms = sanitizePerms(input, defaultPerms(role));
    await this.prisma.roleConfig.upsert({
      where: { workspaceId_role: { workspaceId, role: role as any } },
      create: {
        workspaceId, role: role as any, ticketScope: perms.ticketScope,
        permissions: { pages: perms.pages }, updatedById,
      },
      update: { ticketScope: perms.ticketScope, permissions: { pages: perms.pages }, updatedById },
    });
    this.cache.delete(`${workspaceId}:${role}`);
    return perms;
  }

  async can(user: JwtUser, resource: ResourceKey, action: PermAction): Promise<boolean> {
    const perms = await this.get(user.ws, user.role);
    return perms.pages[resource]?.[action] === true;
  }
}
