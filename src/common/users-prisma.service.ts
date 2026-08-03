import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class UsersPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ datasources: { db: { url: process.env.USERS_DATABASE_URL } } });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Effective access for a user. Entity is IGNORED: permissions are role-level,
   * so a user's effective set is the union of every permission granted to any of
   * their roles. `entityId` is accepted for signature parity with the other APIs
   * but unused — the warehouse is a single shared physical pool across entities,
   * and `entityId` on a reservation is a reporting label, not a scoping key.
   *
   * isSuperAdmin is derived from role level 0 via a LEFT JOIN, so a super-admin
   * role resolves even when it has no explicit permission grants.
   */
  async getUserAccessInfo(
    userId: number,
    _entityId?: number,
  ): Promise<{ isSuperAdmin: boolean; permissionNames: string[] }> {
    const rows = await this.$queryRaw<{ name: string | null; level: number }[]>`
      SELECT DISTINCT p.name AS "name", r."level" AS "level"
      FROM "UserRole" ur
      JOIN "Role" r ON r.id = ur."roleId"
      LEFT JOIN "RolePermission" rp ON rp."roleId" = r.id
      LEFT JOIN "Permission" p ON p.id = rp."permissionId"
      WHERE ur."userId" = ${userId}
    `;
    const isSuperAdmin = rows.some((r) => Number(r.level) === 0);
    const permissionNames = [
      ...new Set(
        rows.map((r) => r.name).filter((n): n is string => !!n && n !== '_entity_configured_'),
      ),
    ];
    return { isSuperAdmin, permissionNames };
  }

  /**
   * Everyone who holds any of the given permissions, with the contact details
   * needed to notify them. Super-admins (role level 0) are always included —
   * they bypass the permission guard, so they hold every permission in effect.
   *
   * One query: the warehouse reads the shared users DB directly rather than
   * calling auth over HTTP, so there is no per-user round trip.
   */
  /** Contact details for specific users — for notifications aimed at named people. */
  async getUsersByIds(
    ids: number[],
  ): Promise<{ id: number; email: string; firstName: string; lastName: string }[]> {
    if (!ids.length) return [];
    return this.$queryRaw<{ id: number; email: string; firstName: string; lastName: string }[]>`
      SELECT id, email, "firstName", "lastName" FROM "User" WHERE id = ANY(${ids}::int[])
    `;
  }

  async getNotificationRecipients(
    permissions: string[],
  ): Promise<{ id: number; email: string; firstName: string; lastName: string }[]> {
    if (!permissions.length) return [];
    return this.$queryRaw<{ id: number; email: string; firstName: string; lastName: string }[]>`
      SELECT DISTINCT u.id, u.email, u."firstName", u."lastName"
      FROM "User" u
      JOIN "UserRole" ur ON ur."userId" = u.id
      JOIN "Role" r ON r.id = ur."roleId"
      LEFT JOIN "RolePermission" rp ON rp."roleId" = r.id
      LEFT JOIN "Permission" p ON p.id = rp."permissionId"
      WHERE p.name = ANY(${permissions}::text[]) OR r."level" = 0
    `;
  }
}