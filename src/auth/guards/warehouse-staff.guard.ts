import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

const WAREHOUSE_PERMISSIONS = [
  'manage_warehouse',
  'manage_reservations',
  'view_reservations',
];

@Injectable()
export class WarehouseStaffGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user;
    if (!user) throw new ForbiddenException('Access denied');

    if (user.isAdmin) return true;

    const userPermissions: string[] = (user.roles ?? []).flatMap((r: any) =>
      (r.role?.permissions ?? []).map((p: any) => p.permission?.name ?? p.name).filter(Boolean),
    );

    const hasAccess = WAREHOUSE_PERMISSIONS.some((p) => userPermissions.includes(p));
    if (!hasAccess) throw new ForbiddenException('Warehouse staff access required');
    return true;
  }
}
