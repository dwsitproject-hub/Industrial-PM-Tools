import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface JwtUser {
  sub: string;
  ws: string;
  role: 'MANAGER' | 'ADMIN' | 'SITE_ADMIN' | 'ESTIMATOR';
  siteId?: string | null;
  mcp?: boolean;
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

export const ALLOW_MUST_CHANGE = 'allowMustChange';
export const AllowWhenMustChangePassword = () => SetMetadata(ALLOW_MUST_CHANGE, true);

export const PERM_KEY = 'requiredPerm';
/** Gate a route on the configurable role-permission matrix (Settings -> Roles). */
export const RequirePerm = (resource: string, action: string) => SetMetadata(PERM_KEY, [resource, action]);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): JwtUser => {
  return ctx.switchToHttp().getRequest().user;
});
