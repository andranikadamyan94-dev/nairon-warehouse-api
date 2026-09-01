import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UsersPrismaService } from '../../common/users-prisma.service';

export const PERMISSIONS_KEY = 'permissions';
export const Permissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Procurement is its own domain of responsibility (2026-09-01 split): the
 * warehouse super-permission deliberately does NOT satisfy routes that only
 * procurement rights may open. Everything else it still covers.
 */
const PROCUREMENT_ONLY = new Set(['view_procurement', 'manage_procurement']);

/**
 * Route-level permission check. Relies on the global AuthGuard having set
 * request.user. `manage_warehouse` acts as the warehouse super-permission
 * and satisfies any requirement — except procurement-only routes (see above).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private usersPrisma: UsersPrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) throw new ForbiddenException('Access denied');
    const { isSuperAdmin, permissionNames } = await this.usersPrisma.getUserAccessInfo(user.id);
    // Handlers with creator-or-admin rules (e.g. procurement cancel) read this.
    request.isSuperAdmin = isSuperAdmin;
    if (isSuperAdmin) return true;
    const procurementOnly = required.every((p) => PROCUREMENT_ONLY.has(p));
    if (!procurementOnly && permissionNames.includes('manage_warehouse')) return true;

    if (!required.some((p) => permissionNames.includes(p))) {
      throw new ForbiddenException('Insufficient warehouse permissions');
    }
    return true;
  }
}
