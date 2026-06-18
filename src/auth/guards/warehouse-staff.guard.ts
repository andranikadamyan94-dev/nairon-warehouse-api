import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { UsersPrismaService } from '../../common/users-prisma.service';

const WAREHOUSE_PERMISSIONS = [
  'manage_warehouse',
  'manage_reservations',
  'view_reservations',
];

@Injectable()
export class WarehouseStaffGuard implements CanActivate {
  constructor(private usersPrisma: UsersPrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest().user;
    if (!user) throw new ForbiddenException('Access denied');

    if (user.isAdmin) return true;

    const { isSuperAdmin, permissionNames } = await this.usersPrisma.getUserAccessInfo(user.id);
    if (isSuperAdmin) return true;

    if (!WAREHOUSE_PERMISSIONS.some((p) => permissionNames.includes(p))) {
      throw new ForbiddenException('Warehouse staff access required');
    }
    return true;
  }
}
