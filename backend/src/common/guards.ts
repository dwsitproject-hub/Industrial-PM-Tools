import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ALLOW_MUST_CHANGE, IS_PUBLIC, PERM_KEY, ROLES_KEY } from './auth.types';
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
      req.user = this.jwt.verify(token, { secret: process.env.JWT_ACCESS_SECRET });
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

/** Login throttle keyed by IP + username so one hammered account cannot lock out the office IP. */
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return `${req.ip}:${(req.body?.username || '').toLowerCase()}`;
  }
}
