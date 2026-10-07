import { Injectable, Logger } from '@nestjs/common';
import { UsersPrismaService } from '../users-prisma.service';
import { requireInternalSecret } from '../internal-headers';

/** Catalog keys (hr-api notification-types.ts) of the warehouse events — notifications phase 1, 2026-10-06. */
export const WAREHOUSE_TYPES = {
  lowStock: 'warehouse.low_stock',
  /** Waits for a warehouse decision (stock short / conflicting). */
  reservationPending: 'warehouse.reservation_pending',
  /** A new object request that needs no decision. */
  reservationRequested: 'warehouse.reservation_requested',
  reservationApproved: 'warehouse.reservation_approved',
  reservationRejected: 'warehouse.reservation_rejected',
  procurementReceived: 'warehouse.procurement_received',
  procurementPrepaymentExcess: 'warehouse.procurement_prepayment_excess',
  procurementAmountMismatch: 'warehouse.procurement_amount_mismatch',
  procurementEdited: 'warehouse.procurement_edited',
  procurementClosedShort: 'warehouse.procurement_closed_short',
  procurementCancelled: 'warehouse.procurement_cancelled',
  assetRequest: 'warehouse.asset_request_received',
  assetToIssue: 'warehouse.asset_issue_pending',
  assetDecided: 'warehouse.asset_request_decided',
  assetIssued: 'warehouse.asset_issued',
  assetIssuedObject: 'warehouse.asset_issued_object',
  // ── Notifications phase 2 (2026-10-06) ──
  /** Y — a requisition waits for its organisation's approver. */
  requisitionSubmitted: 'warehouse.requisition_submitted',
  requisitionApproved: 'warehouse.requisition_approved',
  /** Y — a rejection waits for confirm_requisition_rejection. */
  requisitionRejectionPending: 'warehouse.requisition_rejection_pending',
  /** Y — the rejection was confirmed or declined. */
  requisitionRejectionDecided: 'warehouse.requisition_rejection_decided',
  requisitionConverted: 'warehouse.requisition_converted',
  requisitionFulfilled: 'warehouse.requisition_fulfilled',
  requisitionComment: 'warehouse.requisition_comment',
  /** Y — an order waits for approve_purchase_order. */
  orderApprovalPending: 'warehouse.order_approval_pending',
  /** Y — the order was approved or sent back. */
  orderApprovalDecided: 'warehouse.order_approval_decided',
  /** Y — finance approved or rejected the order's money. */
  orderFinanceDecided: 'warehouse.order_finance_decided',
  /** Y — a catalog checkout or a reply waits for the catalog desk. */
  catalogRequestReceived: 'warehouse.catalog_request_received',
  /** Y — approved / rejected / information requested. */
  catalogRequestDecided: 'warehouse.catalog_request_decided',
  /** Y — ready to collect. */
  catalogReady: 'warehouse.catalog_ready',
  stockRequestCreated: 'warehouse.stock_request_created',
  stockRequestDecided: 'warehouse.stock_request_decided',
  stockTransferIncoming: 'warehouse.stock_transfer_incoming',
  reservationCancelled: 'warehouse.reservation_cancelled',
  reservationReclaimed: 'warehouse.reservation_reclaimed',
  reservationBackToPending: 'warehouse.reservation_back_to_pending',
  returnFiled: 'warehouse.return_filed',
  returnDecided: 'warehouse.return_decided',
  /** Y — an asset came back damaged or lost. */
  assetReturnedDamaged: 'warehouse.asset_returned_damaged',
  responsibilityChanged: 'warehouse.responsibility_changed',
  maintenanceFinanceDecided: 'warehouse.maintenance_finance_decided',
  // ── Notifications phase 3 (2026-10-07) ──
  /** Y — daily 09:00: maintenance starts tomorrow, or its end date passed and it is still open. */
  maintenanceDue: 'warehouse.maintenance_due',
  /** Y — daily 09:00: a reservation ends tomorrow or is overdue (at most 7 days). */
  assetDueBack: 'warehouse.asset_due_back',
  /** Daily 09:00: an issued asset not confirmed as received after 2 days. */
  receiptUnconfirmed: 'warehouse.receipt_unconfirmed',
  /** Y — a procurement order was deleted (its finance transfers cancelled). */
  orderDeleted: 'warehouse.order_deleted',
  priceAmended: 'warehouse.price_amended',
  assetRequestCancelled: 'warehouse.asset_request_cancelled',
  partialAcceptance: 'warehouse.partial_acceptance',
  allocationChanged: 'warehouse.allocation_changed',
  catalogRequestEdited: 'warehouse.catalog_request_edited',
  stockRequestCancelled: 'warehouse.stock_request_cancelled',
  requisitionCancelled: 'warehouse.requisition_cancelled',
  assetStatusChanged: 'warehouse.asset_status_changed',
  itemChanged: 'warehouse.item_changed',
  warehouseAssignment: 'warehouse.warehouse_assignment',
  receiptConfirmed: 'warehouse.receipt_confirmed',
  requisitionInReview: 'warehouse.requisition_in_review',
  orderPlaced: 'warehouse.order_placed',
  reservationReactivated: 'warehouse.reservation_reactivated',
  requestAttachment: 'warehouse.request_attachment',
  stockAdjusted: 'warehouse.stock_adjusted',
} as const;

/**
 * Where a record lives in the CRM client. hr-api's link map (shared/app-links)
 * sends these first path segments to the CRM app, whatever origin the
 * warehouse prefixed them with.
 */
export const crmLinks = {
  task: (projectId: number | null | undefined, taskId: number) =>
    projectId ? `/assignments/${projectId}?task=${taskId}` : null,
  object: (objectId: number) => `/objects/${objectId}`,
  requisition: (id: number) => `/purchase-requisitions?requisition=${id}`,
};

export interface WarehouseNotification {
  /** Catalog key, `warehouse.<event>`. */
  type: string;
  /** Who to reach: holders of any of these permissions in the record's organisation (see entityIds). */
  permissions?: string[];
  /**
   * The record's organisation(s). Holders count when their role assignment is
   * in that organisation or global (entity 0) and the permission is granted
   * there or globally. A record with no organisation (null) reaches global
   * holders only. Several entries: the union (a reservation spanning items of
   * two organisations).
   */
  entityIds?: (number | null | undefined)[];
  /** Named people reached as well (the requester, the submitter…) — one notice each, deduped with the holders. */
  userIds?: (number | null | undefined)[];
  /** The person whose act this is: never told about their own action. */
  actorId?: number | null;
  /** People another notice about the same act already reached. */
  excludeUserIds?: number[];
  title: string;
  /** Plain text — the bell body and the email's lead line. */
  body: string;
  /** Path within the warehouse client, e.g. "/resources". */
  path?: string;
  /** Detail rows for the email (hr-api renders them). */
  details?: { label: string; value: string }[];
}

/**
 * Warehouse notifications, through hr-api's hub (notifications phase 1,
 * 2026-10-06): POST /notifications/internal per person stores the bell row,
 * pushes, and emails when the type's email channel is on for that person —
 * one message each. The warehouse sends no mail itself any more; there is no
 * SMTP fallback (hr-api unreachable → logged, nothing else).
 *
 * Everything is best-effort and never throws: a notification failure must not
 * roll back or fail the warehouse operation that triggered it. Delivery is also
 * fire-and-forget by design, so callers should NOT await it inside a
 * transaction.
 */
@Injectable()
export class WarehouseNotificationsService {
  private readonly logger = new Logger(WarehouseNotificationsService.name);

  /** The global fetch; replaced in tests. */
  http: typeof fetch = (input, init) => fetch(input, init);

  constructor(private usersPrisma: UsersPrismaService) {}

  /**
   * Resolve recipients — permission holders in the record's organisation plus
   * any named people — drop the actor and anybody excluded, and deliver one
   * notice per person. Never throws.
   */
  async send(n: WarehouseNotification): Promise<void> {
    try {
      const permissions = n.permissions ?? [];
      const holders = permissions.length
        ? await this.usersPrisma.getNotificationRecipients(permissions, n.entityIds ?? [null])
        : [];
      const named = this.cleanIds(n.userIds ?? []);
      const namedFound = named.length ? await this.usersPrisma.getUsersByIds(named) : [];
      const ids = this.withoutSkipped([...holders, ...namedFound].map((r) => r.id), n);
      if (!ids.length) {
        if (permissions.length && !holders.length) {
          this.logger.warn(`No recipients hold [${permissions.join(', ')}] — "${n.title}" not sent`);
        }
        return;
      }
      await this.deliver(ids, n);
    } catch (e: any) {
      this.logger.error(`Notification "${n.title}" failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Who a permission audience reaches — for a caller sending a second,
   * different notice about the same act that must not reach the same people
   * twice (pass the result as excludeUserIds). Never throws; [] on failure.
   */
  async audience(permissions: string[], entityIds: (number | null | undefined)[]): Promise<number[]> {
    try {
      if (!permissions.length) return [];
      return (await this.usersPrisma.getNotificationRecipients(permissions, entityIds)).map((r) => r.id);
    } catch {
      return [];
    }
  }

  private cleanIds(ids: (number | null | undefined)[]): number[] {
    return [...new Set(ids.filter((id): id is number => Number.isInteger(id) && (id as number) > 0))];
  }

  /** One per person; never the actor; never somebody another notice already reached. */
  private withoutSkipped(ids: number[], n: { actorId?: number | null; excludeUserIds?: number[] }): number[] {
    const skip = new Set<number>(n.excludeUserIds ?? []);
    if (n.actorId) skip.add(n.actorId);
    return [...new Set(ids)].filter((id) => !skip.has(id));
  }

  /**
   * Deliver to specific users rather than a permission audience — used for
   * requester-facing alerts, which are routed to the assignees of the linked
   * CRM task (a reservation itself records no requester).
   */
  async sendToUsers(
    userIds: (number | null | undefined)[],
    n: Omit<WarehouseNotification, 'permissions' | 'entityIds' | 'userIds'>,
  ): Promise<void> {
    try {
      const ids = this.withoutSkipped(this.cleanIds(userIds), n);
      if (!ids.length) return;
      const recipients = await this.usersPrisma.getUsersByIds(ids);
      if (!recipients.length) return;
      await this.deliver(recipients.map((r) => r.id), n);
    } catch (e: any) {
      this.logger.error(`Notification "${n.title}" failed: ${e?.message ?? e}`);
    }
  }

  private async deliver(
    userIds: number[],
    n: Pick<WarehouseNotification, 'type' | 'title' | 'body' | 'path' | 'details'>,
  ): Promise<void> {
    const ids = [...new Set(userIds)];
    let secret: string;
    try {
      secret = requireInternalSecret();
    } catch (e: any) {
      // Was swallowed inside Promise.allSettled: nothing sent and nothing said.
      this.logger.error(`"${n.title}" not delivered to ${ids.length} people: ${e?.message ?? e}`);
      return;
    }
    const hrUrl = (process.env.HR_SERVICE_URL || 'http://localhost:3001').replace(/\/$/, '');
    const url = this.clientUrl(n.path);
    const email = { subject: n.title, ...(n.details?.length ? { details: n.details } : {}) };
    const results = await Promise.allSettled(
      ids.map((userId) =>
        this.http(`${hrUrl}/api/notifications/internal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
          body: JSON.stringify({ userId, type: n.type, title: n.title, body: n.body, url, email }),
        }).then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status} for userId ${userId}`);
        }),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      this.logger.error(
        `Notification "${n.title}" failed for ${failed.length}/${ids.length}: ` +
          `${(failed[0] as PromiseRejectedResult).reason?.message}`,
      );
    }
  }

  private clientUrl(path?: string): string {
    const base = (process.env.FRONTEND_URL || 'http://localhost:4003').replace(/\/$/, '');
    return path ? `${base}${path.startsWith('/') ? path : `/${path}`}` : base;
  }
}
