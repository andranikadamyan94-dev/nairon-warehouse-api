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
 * Route-level permission check. Relies on the global AuthGuard having set
 * request.user. `manage_warehouse` acts as the warehouse super-permission
 * and satisfies any requirement.
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

    const user = context.switchToHttp().getRequest().user;
    if (!user) throw new ForbiddenException('Access denied');
    if (user.isAdmin) return true;

    const { isSuperAdmin, permissionNames } = await this.usersPrisma.getUserAccessInfo(user.id);
    if (isSuperAdmin) return true;
    if (permissionNames.includes('manage_warehouse')) return true;

    if (!required.some((p) => permissionNames.includes(p))) {
      throw new ForbiddenException('Insufficient warehouse permissions');
    }
    return true;
  }
}
