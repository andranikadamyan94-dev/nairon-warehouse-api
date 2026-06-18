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

  async getUserAccessInfo(userId: number): Promise<{ isSuperAdmin: boolean; permissionNames: string[] }> {
    const rows = await this.$queryRaw<{ name: string; level: number }[]>`
      SELECT DISTINCT p.name, r.level
      FROM "UserRole" ur
      JOIN "Role" r ON r.id = ur."roleId"
      JOIN "RolePermission" rp ON rp."roleId" = r.id
      JOIN "Permission" p ON p.id = rp."permissionId"
      WHERE ur."userId" = ${userId}
    `;
    return {
      isSuperAdmin: rows.some((r) => r.level === 0),
      permissionNames: rows.map((r) => r.name),
    };
  }
}