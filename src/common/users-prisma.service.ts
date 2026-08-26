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
   * Deactivated user ids, cached briefly.
   *
   * Tokens are signed for 30 days and there is no session store, so a
   * deactivated person's existing token stays cryptographically valid — the
   * guards have to ask. Reading the whole set once per TTL keeps that to one
   * small query per service rather than one per request.
   *
   * The staleness is deliberately one-directional. A cache miss is trusted, so
   * deactivating takes up to the TTL to bite. A cache *hit* is re-checked
   * against the row before anyone is refused, which costs one query for the
   * rare deactivated caller and means reactivating takes effect at once —
   * otherwise someone told they were back would keep getting 401s for another
   * half minute and be bounced to the login screen.
   */
  private deactivated: { ids: Set<number>; expiresAt: number } | null = null;

  async isDeactivated(userId: number): Promise<boolean> {
    const now = Date.now();
    if (!this.deactivated || now >= this.deactivated.expiresAt) {
      const rows = await this.$queryRaw<{ id: number }[]>`
        SELECT id FROM "User" WHERE "deactivatedAt" IS NOT NULL
      `;
      this.deactivated = {
        ids: new Set(rows.map((r) => Number(r.id))),
        expiresAt: now + 30_000,
      };
      return this.deactivated.ids.has(userId);
    }
    if (!this.deactivated.ids.has(userId)) return false;

    const [row] = await this.$queryRaw<{ deactivatedAt: Date | null }[]>`
      SELECT "deactivatedAt" FROM "User" WHERE id = ${userId}
    `;
    if (row && row.deactivatedAt === null) {
      this.deactivated.ids.delete(userId);
      return false;
    }
    return true;
  }

  /**
   * Queried directly rather than through the guard cache above: that one
   * trades staleness for speed on a per-request hot path, which is the wrong
   * trade here. A list is a page load, and someone offboarded a moment ago
   * must already be gone from it.
   *
   * Drops deactivated people from a set of ids. For lists of *people* — a
   * picker, a directory, a roster. Lists of *records* keep them: preserving
   * that history is the whole reason deactivation exists.
   */
  async filterActive(ids: number[]): Promise<number[]> {
    if (!ids.length) return ids;
    const rows = await this.$queryRaw<{ id: number }[]>`
      SELECT id FROM "User"
      WHERE id = ANY(${ids}::int[]) AND "deactivatedAt" IS NULL
    `;
    const active = new Set(rows.map((r) => Number(r.id)));
    return ids.filter((id) => active.has(id));
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
    entityId = 0,
    targetDepartmentIds?: number[],
  ): Promise<{ isSuperAdmin: boolean; isGlobalSuperAdmin: boolean; permissionNames: string[] }> {
    // Context-aware resolution. An assignment applies when its entity matches
    // the entity in play (assignment entityId 0 = every entity; request
    // entityId 0 = no entity context, everything counts) and, for
    // people-targeted actions, when the role's department contains the target
    // (role departmentId NULL = org-wide; no department context = all roles).
    // Grants are additive per entity: a RolePermission row counts when its
    // own entity matches the context (0 on either side = everywhere).
    // isSuperAdmin roles are super admins WITHIN their assignment's entity
    // scope: a wildcard assignment (entityId 0) makes them global; a
    // scoped one grants admin only in that entity. Department
    // scoping never applies to super-admin roles.
    const hasDeptCtx = targetDepartmentIds !== undefined;
    const deptIds = targetDepartmentIds && targetDepartmentIds.length ? targetDepartmentIds : [-1];
    const rows = await this.$queryRaw<{ name: string | null; isSuperAdmin: boolean; urEntityId: number }[]>`
      SELECT DISTINCT p.name AS "name", r."isSuperAdmin" AS "isSuperAdmin", ur."entityId" AS "urEntityId"
      FROM "UserRole" ur
      JOIN "Role" r ON r.id = ur."roleId"
      LEFT JOIN "RolePermission" rp ON rp."roleId" = r.id
        AND (rp."entityId" = 0 OR ${entityId} = 0 OR rp."entityId" = ${entityId})
      LEFT JOIN "Permission" p ON p.id = rp."permissionId"
      WHERE ur."userId" = ${userId}
        AND (${entityId} = 0 OR ur."entityId" = 0 OR ur."entityId" = ${entityId})
        AND (
          r."isSuperAdmin" = true
          OR ${hasDeptCtx} = false OR r."departmentId" IS NULL OR r."departmentId" = ANY(${deptIds}::int[])
        )
    `;
    const isSuperAdmin = rows.some((r) => r.isSuperAdmin === true);
    const isGlobalSuperAdmin = rows.some(
      (r) => r.isSuperAdmin === true && Number(r.urEntityId) === 0,
    );
    const permissionNames = [
      ...new Set(
        rows.map((r) => r.name).filter((n): n is string => !!n && n !== '_entity_configured_'),
      ),
    ];
    return { isSuperAdmin, isGlobalSuperAdmin, permissionNames };
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
      WHERE p.name = ANY(${permissions}::text[]) OR r."isSuperAdmin" = true
    `;
  }
}
