import { Injectable } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';
import { UsersPrismaService } from '../common/users-prisma.service';
import {
  FileRequester,
  UPLOADS_DIR,
  isStoredName,
  storedNameOf,
  storedPath,
} from '../common/stored-files';

/**
 * Which record a stored receipt belongs to, and whether this person may read
 * it.
 *
 * Two columns hold every uploaded file in this service: a procurement order's
 * own receipt, and the receipt of one delivery against it. Both describe the
 * same order, so both ask the same question.
 *
 * Nonexistent, unreferenced and refused all come back as the same `null`, so
 * the answer never distinguishes them.
 */

/** Reading procurement at all. The 2026-09-01 split keeps this its own domain. */
const READ_PROCUREMENT = ['view_procurement', 'manage_procurement'];

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersPrisma: UsersPrismaService,
  ) {}

  async upload(name: string, who: FileRequester): Promise<string | null> {
    if (!isStoredName(name)) return null;
    const file = storedPath(UPLOADS_DIR, name);
    if (!file) return null;
    if (!(await this.referenced(name))) return null;
    return (await this.mayRead(who)) ? file : null;
  }

  /**
   * Does any record still point at this name?
   *
   * Matched on the suffix rather than the whole value: rows written before the
   * 2026-09 switch to relative paths carry an absolute URL with whatever host
   * wrote them, and the host is not part of the file's identity. The candidate
   * is then confirmed by parsing the stored value, so a name that is merely a
   * prefix of another cannot borrow its record.
   */
  private async referenced(name: string): Promise<boolean> {
    const suffix = { endsWith: `/uploads/${name}` };
    const [orders, deliveries] = await Promise.all([
      this.prisma.procurementOrder.findMany({
        where: { receiptUrl: suffix },
        select: { receiptUrl: true },
      }),
      this.prisma.procurementDelivery.findMany({
        where: { receiptUrl: suffix },
        select: { receiptUrl: true },
      }),
    ]);
    return [...orders, ...deliveries].some((row) => storedNameOf(row.receiptUrl) === name);
  }

  /**
   * May this person read procurement?
   *
   * No workspace term, and that is deliberate rather than an omission: the
   * warehouse has no workspace dimension — proven when reservations were
   * hardened, and the reason warehouse-created transfers reach finance with a
   * null entity. A receipt belongs to an order, an order belongs to the
   * installation's store, and the question is therefore only whether this
   * person may see procurement at all.
   *
   * Read with no entity context (0), so a grant made in any single workspace
   * still counts — the same answer the procurement routes themselves give.
   */
  private async mayRead(who: FileRequester): Promise<boolean> {
    const info = await this.usersPrisma.getUserAccessInfo(who.userId, 0);
    if (info.isSuperAdmin) return true;
    return READ_PROCUREMENT.some((permission) => info.permissionNames.includes(permission));
  }
}
