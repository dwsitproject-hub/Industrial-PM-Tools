import { Injectable, Logger, OnApplicationBootstrap, SetMetadata } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma.service';
import { IS_PUBLIC, PERM_KEY, ROLES_KEY } from './auth.types';
import { deployEnv } from './security.config';

export const SERVICE_SCOPED = 'serviceScoped';
/**
 * Marks a route whose authorisation is enforced inside the service rather than by a guard —
 * typically row scoping, where "can you see this ticket" is the same question as "does this
 * ticket exist for you". The reason is recorded so the policy stays readable.
 */
export const ServiceScoped = (reason: string) => SetMetadata(SERVICE_SCOPED, reason);

export const AUTHENTICATED = 'authenticatedOnly';
/**
 * Marks a route where holding a valid token IS the authorisation — self-service endpoints
 * that act only on the caller's own account or session.
 */
export const Authenticated = (reason: string) => SetMetadata(AUTHENTICATED, reason);

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

export interface RoutePolicy {
  method: string;
  path: string;
  controller: string;
  handler: string;
  gate: string;
}

/**
 * AR-07: authorisation used to be part declarative (@RequirePerm/@Roles) and part embedded in
 * service logic, with no way to read the effective policy off the controllers. That is not a
 * vulnerability in itself — both are enforced server-side — but it means a new endpoint can be
 * added with neither, and nothing fails.
 *
 * This walks every registered route at boot and requires each one to declare how it is gated.
 * An undeclared route aborts a production boot and logs loudly everywhere else.
 */
@Injectable()
export class RoutePolicyService implements OnApplicationBootstrap {
  private readonly logger = new Logger('RoutePolicy');
  private routes: RoutePolicy[] = [];

  constructor(
    private discovery: DiscoveryService,
    private scanner: MetadataScanner,
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  /**
   * AR-03: a user with no company is treated as EXTERNAL and therefore sees nothing — the
   * fail-closed direction, chosen because the alternative (treating it as internal) turns a
   * data anomaly into a cross-company disclosure. The trade-off is that such a user is
   * silently locked out, so make the anomaly loud instead of leaving it to a support ticket.
   */
  private async reportUsersWithoutCompany(): Promise<void> {
    try {
      const orphans = await this.prisma.user.count({
        where: { companyId: null, deletedAt: null, isActive: true },
      });
      if (orphans > 0) {
        this.logger.warn(
          `${orphans} active user(s) have no company and will see no records at all. ` +
          'Assign them in Settings -> Users, or run the 20260922_companies migration backfill.',
        );
      }
    } catch {
      // Never let a diagnostic stop the application starting.
    }
  }

  onApplicationBootstrap(): void {
    void this.reportUsersWithoutCompany();
    const ungated: RoutePolicy[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const prefix = Reflect.getMetadata(PATH_METADATA, metatype) || '';
      const proto = Object.getPrototypeOf(instance);

      for (const name of this.scanner.getAllMethodNames(proto)) {
        const handler = proto[name];
        const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler);
        if (httpMethod === undefined) continue;             // not a route
        const sub = Reflect.getMetadata(PATH_METADATA, handler) ?? '';

        const perm = this.reflector.get<[string, string]>(PERM_KEY, handler);
        const roles = this.reflector.get<string[]>(ROLES_KEY, handler);
        const isPublic = this.reflector.get<boolean>(IS_PUBLIC, handler)
          ?? this.reflector.get<boolean>(IS_PUBLIC, metatype);
        const scoped = this.reflector.get<string>(SERVICE_SCOPED, handler);
        const selfOnly = this.reflector.get<string>(AUTHENTICATED, handler);

        let gate = '';
        if (isPublic) gate = 'public';
        else if (perm) gate = `perm:${perm[0]}.${perm[1]}`;
        else if (roles?.length) gate = `role:${roles.join('|')}`;
        else if (scoped) gate = `service-scoped:${scoped}`;
        else if (selfOnly) gate = `authenticated:${selfOnly}`;

        const route: RoutePolicy = {
          method: METHODS[httpMethod] ?? String(httpMethod),
          path: `/${prefix}/${sub}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/',
          controller: metatype.name, handler: name, gate,
        };
        this.routes.push(route);
        if (!gate) ungated.push(route);
      }
    }

    this.routes.sort((a, b) => a.path.localeCompare(b.path));
    this.logger.log(`Authorisation policy: ${this.routes.length} routes, ${ungated.length} undeclared.`);

    if (ungated.length === 0) return;
    for (const r of ungated) {
      this.logger.error(`Route declares no authorisation: ${r.method} ${r.path} (${r.controller}.${r.handler})`);
    }
    if (deployEnv() === 'production') {
      throw new Error(
        `Refusing to start: ${ungated.length} route(s) declare no authorisation. Add @Public(), ` +
        '@RequirePerm(), @Roles() or @ServiceScoped(reason) to each route listed above.',
      );
    }
    this.logger.warn('These routes would abort a DEPLOY_ENV=production boot.');
  }

  /** The effective policy, for the Appendix B inventory and for tests. */
  all(): RoutePolicy[] {
    return [...this.routes];
  }
}
