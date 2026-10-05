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
 * Which record a stored file belongs to, and whether this person may read it.
 *
 * Three columns hold every uploaded file in this service: a procurement
 * order's own receipt, the receipt of one delivery against it, and an
 * attachment on a purchase requisition. The first two describe an order and
 * ask the procurement question; the third describes a requisition, which the
 * people who file, approve and fulfil requisitions may all read.
 *
 * Nonexistent, unreferenced and refused all come back as the same `null`, so
 * the answer never distinguishes them.
 */

type StoredFileKind = 'receipt' | 'requisition-attachment' | 'item-file' | 'catalog-attachment';

/**
 * Reading a catalog submission's attachment (2026-10-01): the requester who
 * filed it (checked by row), the queue, and the people who decide on or buy
 * for it.
 */
const READ_CATALOG = [
  'view_catalog_requests',
  'manage_reservations',
  'manage_warehouse',
  'approve_purchase_requisition',
  'view_procurement',
  'manage_procurement',
];

/**
 * Reading a receipt. Procurement's own people, and — since 2026-09-20 — the
 * people who receive the goods against it: the Receiving page is opened with
 * manage_inventory and shows the receipt link, and manage_warehouse opens
 * every page but procurement's. A receipt is what they check the delivery
 * against, so they read it.
 */
const READ_RECEIPT = ['view_procurement', 'manage_procurement', 'manage_inventory', 'manage_warehouse'];

/**
 * Reading a requisition's attachment: whoever may see requisitions at all.
 * The requester holds create_purchase_requisition (they filed it), the
 * organization's approver approve_purchase_requisition, procurement its own.
 */
const READ_REQUISITION = [
  'view_procurement',
  'manage_procurement',
  'approve_purchase_requisition',
  'create_purchase_requisition',
];

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
    const kind = await this.referenced(name);
    if (!kind) return null;
    return (await this.mayRead(who, kind, name)) ? file : null;
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
  private async referenced(name: string): Promise<StoredFileKind | null> {
    const suffix = { endsWith: `/uploads/${name}` };
    const [orders, deliveries, attachments, images, documents, submissions] = await Promise.all([
      this.prisma.procurementOrder.findMany({
        where: { receiptUrl: suffix },
        select: { receiptUrl: true },
      }),
      this.prisma.procurementDelivery.findMany({
        where: { receiptUrl: suffix },
        select: { receiptUrl: true },
      }),
      this.prisma.purchaseRequisitionAttachment.findMany({
        where: { url: suffix },
        select: { url: true },
      }),
      // Catalog (2026-10-01): an item's gallery image or document.
      this.prisma.itemImage.findMany({ where: { url: suffix }, select: { url: true } }),
      this.prisma.itemDocument.findMany({ where: { url: suffix }, select: { url: true } }),
      // Catalog (2026-10-01): a submission's own attachment.
      this.prisma.catalogSubmission.findMany({ where: { attachmentUrl: suffix }, select: { attachmentUrl: true } }),
    ]);
    if ([...orders, ...deliveries].some((row) => storedNameOf(row.receiptUrl) === name)) return 'receipt';
    // A catalog attachment is also copied onto its requisition for procurement;
    // the submission row is the one that says who filed it, so it decides first.
    if (submissions.some((row) => storedNameOf(row.attachmentUrl) === name)) return 'catalog-attachment';
    if (attachments.some((row) => storedNameOf(row.url) === name)) return 'requisition-attachment';
    if ([...images, ...documents].some((row) => storedNameOf(row.url) === name)) return 'item-file';
    return null;
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
  private async mayRead(who: FileRequester, kind: StoredFileKind, name?: string): Promise<boolean> {
    // An item's picture or manual describes the shared catalogue, which every
    // signed-in person reads (GET /items carries no permission: the CRM task
    // screen and the employee catalog both open it). The controller has
    // already refused anyone without a live credential.
    if (kind === 'item-file') return true;
    if (kind === 'catalog-attachment' && name) {
      // The requester reads their own, whatever their permissions.
      const own = await this.prisma.catalogSubmission.findFirst({
        where: { attachmentUrl: { endsWith: `/uploads/${name}` }, createdBy: who.userId },
        select: { id: true },
      });
      if (own) return true;
    }
    const info = await this.usersPrisma.getUserAccessInfo(who.userId, 0);
    if (info.isSuperAdmin) return true;
    const allowed = kind === 'receipt' ? READ_RECEIPT : kind === 'catalog-attachment' ? READ_CATALOG : READ_REQUISITION;
    return allowed.some((permission) => info.permissionNames.includes(permission));
  }
}
