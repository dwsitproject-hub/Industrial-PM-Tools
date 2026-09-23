import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ALLOW_MFA_PENDING, ALLOW_MUST_CHANGE, IS_PUBLIC, PERM_KEY, ROLES_KEY } from './auth.types';
import { MfaService } from '../auth/mfa.service';
import { PermissionsService, PermAction, ResourceKey } from './permissions';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Missing token');
    try {
      // AR-08: only the algorithm we sign with is accepted. Without this the header
      // decides how the token is checked, which is where algorithm-confusion bypasses live.
      req.user = this.jwt.verify(token, {
        secret: process.env.JWT_ACCESS_SECRET,
        algorithms: ['HS256'],
      });
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (!req.user?.mcp) return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_MUST_CHANGE, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (allowed || isPublic) return true;
    throw new ForbiddenException({ error: 'PasswordChangeRequired', message: 'You must change your password first.' });
  }
}

/**
 * AR-04: when MFA_POLICY=required, a role listed in MFA_REQUIRED_ROLES cannot use the
 * application until it holds a second factor. The check reads the mfa claim on the access
 * token rather than the database, so it costs nothing per request; enrolling re-issues the
 * token, which is why /auth/mfa/enable hands back a fresh one.
 */
@Injectable()
export class MfaEnrollmentGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (!req.user) return true;                       // public route, or not authenticated yet
    if (req.user.mfa) return true;                    // already enrolled
    if (!MfaService.isRequiredFor(req.user.role)) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_MFA_PENDING, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    const mustChangeOk = this.reflector.getAllAndOverride<boolean>(ALLOW_MUST_CHANGE, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (allowed || mustChangeOk) return true;

    throw new ForbiddenException({
      error: 'MfaEnrollmentRequired',
      message: 'Your role must use two-factor authentication. Set up an authenticator app to continue.',
    });
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;
    const req = ctx.switchToHttp().getRequest();
    if (!req.user) return false;
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenException({ error: 'RoleNotPermitted', message: 'Your role cannot perform this action.' });
    }
    return true;
  }
}

/** Enforces the configurable role-permission matrix on routes decorated with @RequirePerm. */
@Injectable()
export class PermGuard implements CanActivate {
  constructor(private reflector: Reflector, private perms: PermissionsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<[ResourceKey, PermAction]>(PERM_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (!meta) return true;
    const req = ctx.switchToHttp().getRequest();
    if (!req.user) throw new UnauthorizedException();
    const ok = await this.perms.can(req.user, meta[0], meta[1]);
    if (!ok) {
      throw new ForbiddenException({
        error: 'PermissionDenied',
        message: 'Your role is not permitted to do this. Ask a manager to adjust it in Settings → Roles.',
      });
    }
    return true;
  }
}

/**
 * AR-02: the single rate limiter, applied to EVERY route.
 *
 * Previously only /auth/login and /auth/forgot-password were throttled, so any account —
 * including one belonging to an external company — could page the entire ticket register
 * or hammer search at whatever rate it liked. The bucket key depends on what the route is:
 *
 *   credential routes -> (source IP, email)  so hammering one account cannot lock every
 *                                            user behind the same office NAT out of login
 *   authenticated     -> user id             so one noisy account cannot consume a shared
 *                                            office IP's budget, and bulk harvesting is
 *                                            bounded per account rather than per network
 *   anything else     -> source IP
 *
 * Per-route limits come from @Throttle(); @nestjs/throttler already scopes the counter to
 * the handler, so each endpoint gets its own bucket.
 *
 * Two caveats, both covered at the edge (see frontend/nginx/*.conf):
 *   - storage is per process, so a multi-instance deployment needs a shared store
 *   - this guard runs after JwtAuthGuard, so requests bearing an INVALID token are rejected
 *     before they reach it; nginx limit_req covers that flood.
 */
@Injectable()
export class GlobalThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const path: string = req.originalUrl || req.url || '';
    if (/\/auth\/(login|forgot-password)/.test(path)) {
      return `${req.ip}:${String(req.body?.email || '').toLowerCase()}`;
    }
    if (req.user?.sub) return `u:${req.user.sub}`;
    return `ip:${req.ip}`;
  }
}
