import { Logger } from '@nestjs/common';
import { UsersPrismaService } from '../users-prisma.service';
import { WAREHOUSE_TYPES, WarehouseNotificationsService } from './notifications.service';
import { StockAlertService } from './stock-alert.service';
import { PurchaseRequisitionsService } from '../../purchase-requisitions/purchase-requisitions.service';
import { ProcurementService } from '../../procurement/procurement.service';
import { ProcurementOrderStatus } from '@prisma/client';
import { CatalogService } from '../../catalog/catalog.service';
import { ReservationsService } from '../../reservations/reservations.service';
import { StockRequestsService } from '../../stock-requests/stock-requests.service';
import { StockTransfersService } from '../../stock-transfers/stock-transfers.service';
import { ResourceReturnsService } from '../../resource-returns/resource-returns.service';
import { AssetCustodyService } from '../../asset-custody/asset-custody.service';
import { ResponsibilitiesService } from '../../responsibilities/responsibilities.service';
import { MaintenanceService } from '../../maintenance/maintenance.service';
import { ReleaseCondition } from '../../asset-custody/dto/asset-custody.dto';

/**
 * Notifications phase 2 (2026-10-06): every warehouse.* event of the contract.
 * Each block checks who is reached (the permission audience IN the record's
 * organisation and/or the named people), the catalog type, that the actor is
 * never told about their own act, and that one act makes one notice per
 * person. The delivery itself (one POST per person, email block) is the
 * WarehouseNotificationsService block at the top.
 */

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

/** Captures what a service asked the hub for, without delivering. */
function notifier() {
  const sent: any[] = [];
  const toUsers: { ids: any[]; n: any }[] = [];
  return {
    sent,
    toUsers,
    send: jest.fn(async (n: any) => {
      sent.push(n);
    }),
    sendToUsers: jest.fn(async (ids: any[], n: any) => {
      toUsers.push({ ids, n });
    }),
    audience: jest.fn(async () => [70, 71]),
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

// ── The hub client: audience + named people, actor dropped, deduped, email block ──

describe('WarehouseNotificationsService · phase 2 audience rules', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INTERNAL_SECRET = 's';
    process.env.HR_SERVICE_URL = 'http://hr.test';
    process.env.FRONTEND_URL = 'https://wh.test';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  function hub(holders: number[]) {
    const users = {
      getNotificationRecipients: jest.fn(async () => holders.map((id) => ({ id }))),
      getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id }))),
    };
    const svc = new WarehouseNotificationsService(users as unknown as UsersPrismaService);
    const bodies: any[] = [];
    svc.http = jest.fn(async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 201 } as any;
    }) as any;
    return { svc, users, bodies };
  }

  it('holders in the organisation + named people, one notice each, never the actor', async () => {
    const { svc, users, bodies } = hub([4, 5, 9]);
    await svc.send({
      type: WAREHOUSE_TYPES.orderFinanceDecided,
      permissions: ['receive_procurement_alerts'],
      entityIds: [7],
      userIds: [5, 12, 12, null],
      actorId: 9,
      title: 't',
      body: 'b',
      path: '/procurement',
    });
    expect(users.getNotificationRecipients).toHaveBeenCalledWith(['receive_procurement_alerts'], [7]);
    expect(bodies.map((b) => b.userId).sort((a, b) => a - b)).toEqual([4, 5, 12]);
    // emailDefault=Y type: the email block rides along (hr-api decides per person).
    expect(bodies[0]).toMatchObject({ type: 'warehouse.order_finance_decided', email: { subject: 't' } });
  });

  it('excludeUserIds: people another notice already reached are skipped', async () => {
    const { svc, bodies } = hub([4, 5]);
    await svc.send({ type: WAREHOUSE_TYPES.requisitionSubmitted, permissions: ['p'], entityIds: [1], excludeUserIds: [4], title: 't', body: 'b' });
    expect(bodies.map((b) => b.userId)).toEqual([5]);
  });

  it('sendToUsers drops the actor; only the actor → nothing sent', async () => {
    const { svc, bodies } = hub([]);
    await svc.sendToUsers([3], { type: WAREHOUSE_TYPES.returnDecided, actorId: 3, title: 't', body: 'b' });
    expect(bodies).toHaveLength(0);
  });

  it('audience() answers the ids a permission audience reaches', async () => {
    const { svc } = hub([4, 5]);
    await expect(svc.audience(['view_catalog_requests'], [2])).resolves.toEqual([4, 5]);
  });
});

// ── Purchase requisitions ──────────────────────────────────────────────────────

describe('purchase requisitions', () => {
  function world(row: Partial<any> = {}) {
    const state: any = {
      id: 5, title: 'Ցեմենտ', status: 'DRAFT', entityId: 7, createdBy: 10, submissionId: null,
      decidedBy: null, reviewedBy: null, rejectionRequestedBy: null, rejectionConfirmedBy: null,
      rejectionReason: null, lines: [{ id: 1, itemId: 3, itemName: 'Ցեմենտ', quantity: 4 }], comments: [], attachments: [], order: null,
      createdAt: new Date(), updatedAt: new Date(),
      ...row,
    };
    const comments: any[] = [];
    const prisma: any = {
      purchaseRequisition: {
        findUnique: jest.fn(async () => ({ ...state })),
        update: jest.fn(async ({ data }: any) => Object.assign(state, data)),
        create: jest.fn(async ({ data }: any) => Object.assign(state, { ...data, lines: state.lines })),
      },
      purchaseRequisitionComment: {
        create: jest.fn(async ({ data }: any) => comments.push(data)),
        findMany: jest.fn(async () => comments),
      },
      procurementOrder: { create: jest.fn(async () => ({ id: 77, status: 'DRAFT' })) },
      procurementOrderItem: { findMany: jest.fn(async () => []) },
      item: { findMany: jest.fn(async () => [{ id: 3, name: 'Ցեմենտ', code: null, unit: null, quantity: 0 }]) },
      resourceReservation: { count: jest.fn(async () => 0) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const users: any = {
      getUserAccessInfo: jest.fn(async () => ({
        isSuperAdmin: false,
        permissionNames: ['create_purchase_requisition', 'approve_purchase_requisition', 'confirm_requisition_rejection', 'manage_procurement'],
      })),
      getUsersByIds: jest.fn(async () => []),
    };
    const n = notifier();
    const svc = new PurchaseRequisitionsService(prisma, users, { upload: () => '/u/x' } as any, n as any);
    return { svc, state, n, comments };
  }

  it('submit → requisition_submitted to approve_purchase_requisition in its organisation, not the requester', async () => {
    const { svc, n } = world();
    await svc.submit(5, 10);
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.requisition_submitted',
      permissions: ['approve_purchase_requisition'],
      entityIds: [7],
      actorId: 10,
      path: '/purchase-requisitions?requisition=5',
    });
  });

  it('create without a caller transaction announces once; inside one, the caller does', async () => {
    const a = world();
    await a.svc.create({ lines: [{ itemId: 3, quantity: 4 }] }, 10, 7);
    expect(a.n.sent.map((s) => s.type)).toEqual(['warehouse.requisition_submitted']);
    const b = world();
    await b.svc.create({ lines: [{ itemId: 3, quantity: 4 }] }, 10, 7, b.svc['prisma'] as any);
    expect(b.n.sent).toHaveLength(0);
    // a draft waits for nobody
    const c = world();
    await c.svc.create({ lines: [{ itemId: 3, quantity: 4 }], draft: true }, 10, 7);
    expect(c.n.sent).toHaveLength(0);
  });

  it('org approval → procurement of the organisation + the requester; a catalog row leaves the submitter to the catalog', async () => {
    const { svc, n } = world({ status: 'PENDING_APPROVAL' });
    await svc.orgApprove(5, 20);
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.requisition_approved',
      permissions: ['manage_procurement'],
      entityIds: [7],
      userIds: [10],
      actorId: 20,
    });
    const cat = world({ status: 'PENDING_APPROVAL', submissionId: 3 });
    await cat.svc.orgApprove(5, 20);
    expect(cat.n.sent[0].userIds).toEqual([]);
  });

  it('a rejection at either stage waits for confirm_requisition_rejection in the organisation', async () => {
    const org = world({ status: 'PENDING_APPROVAL' });
    await org.svc.orgReject(5, 20, 'Թանկ է');
    const proc = world({ status: 'SUBMITTED' });
    await proc.svc.reject(5, 30, 'Չկա');
    for (const [w, actor] of [[org, 20], [proc, 30]] as const) {
      expect(w.n.sent[0]).toMatchObject({
        type: 'warehouse.requisition_rejection_pending',
        permissions: ['confirm_requisition_rejection'],
        entityIds: [7],
        actorId: actor,
      });
    }
  });

  it('confirmed or declined rejection → requester + rejecter, never the confirmer', async () => {
    const c = world({ status: 'REJECTION_PENDING', rejectionStage: 'ORG', rejectionRequestedBy: 20, rejectionReason: 'Թանկ է' });
    await c.svc.confirmRejection(5, 40);
    expect(c.n.sent[0]).toMatchObject({ type: 'warehouse.requisition_rejection_decided', userIds: [10, 20], actorId: 40 });
    expect(c.n.sent[0].body).toContain('Թանկ է');
    const d = world({ status: 'REJECTION_PENDING', rejectionStage: 'ORG', rejectionRequestedBy: 20, rejectionReturnStatus: 'PENDING_APPROVAL' });
    await d.svc.declineRejection(5, 40, 'Պետք է');
    expect(d.n.sent[0]).toMatchObject({ type: 'warehouse.requisition_rejection_decided', userIds: [10, 20], actorId: 40 });
  });

  it('converted to an order → the requester', async () => {
    const { svc, n } = world({ status: 'SUBMITTED' });
    await svc.approve(5, 30);
    expect(n.sent[0]).toMatchObject({ type: 'warehouse.requisition_converted', userIds: [10], actorId: 30 });
    expect(n.sent[0].body).toContain('#77');
  });

  it('a comment: the requester\'s reaches whoever it waits on; anybody else\'s reaches the requester; quiet tells nobody', async () => {
    const mine = world({ status: 'PENDING_APPROVAL' });
    await mine.svc.addComment(5, 10, 'Շտապ է');
    await settle();
    expect(mine.n.sent[0]).toMatchObject({
      type: 'warehouse.requisition_comment',
      permissions: ['approve_purchase_requisition'],
      entityIds: [7],
      actorId: 10,
    });
    const theirs = world({ status: 'IN_REVIEW', reviewedBy: 30 });
    await theirs.svc.addComment(5, 30, 'Ո՞ր մակնիշը');
    await settle();
    expect(theirs.n.sent[0]).toMatchObject({ type: 'warehouse.requisition_comment', actorId: 30 });
    expect(theirs.n.sent[0].userIds).toContain(10);
    const quiet = world({ status: 'PENDING_APPROVAL' });
    await quiet.svc.addComment(5, 10, 'x', undefined, { quiet: true });
    await settle();
    expect(quiet.n.sent).toHaveLength(0);
  });
});

// ── Procurement orders ─────────────────────────────────────────────────────────

describe('procurement orders', () => {
  function world(row: Partial<any> = {}) {
    const state: any = {
      id: 9, status: ProcurementOrderStatus.DRAFT, entityId: 7, createdBy: 11, submittedForApprovalBy: null,
      supplier: { name: 'Մատակարար' }, items: [{ quantity: 2, unitPrice: 50 }], prepaymentAmount: null, payments: [], deliveries: [],
      financeAttempt: 1, ...row,
    };
    const payments: any[] = row.payments ?? [];
    const prisma: any = {
      procurementOrder: {
        findUnique: jest.fn(async () => ({ ...state })),
        update: jest.fn(async ({ data }: any) => Object.assign(state, data)),
      },
      procurementPayment: {
        findFirst: jest.fn(async ({ where }: any) => payments.find((p) => p.financeTransferId === where.financeTransferId) ?? null),
        update: jest.fn(async () => ({})),
      },
    };
    const n = notifier();
    const users: any = { getUserAccessInfo: jest.fn(async () => ({ isSuperAdmin: false, permissionNames: ['approve_purchase_order'] })) };
    const svc = new ProcurementService(prisma, {} as any, {} as any, n as any, users);
    (svc as any).sendToFinance = jest.fn(async () => ({ ...state, status: ProcurementOrderStatus.PENDING_FINANCE_APPROVAL }));
    return { svc, state, n };
  }

  it('sent for approval → approve_purchase_order holders of the order\'s organisation, not the sender', async () => {
    const { svc, n } = world();
    await svc.finalize(9, 11);
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.order_approval_pending',
      permissions: ['approve_purchase_order'],
      entityIds: [7],
      actorId: 11,
    });
  });

  it('approved / sent back → the submitter, with the reason', async () => {
    const a = world({ status: ProcurementOrderStatus.PENDING_APPROVAL, submittedForApprovalBy: 12 });
    await a.svc.approve(9, 50);
    expect(a.n.toUsers[0]).toMatchObject({ ids: [12], n: { type: 'warehouse.order_approval_decided', actorId: 50 } });
    const r = world({ status: ProcurementOrderStatus.PENDING_APPROVAL, submittedForApprovalBy: 12 });
    await r.svc.rejectApproval(9, 50, 'Գինը բարձր է');
    expect(r.n.toUsers[0].n).toMatchObject({ type: 'warehouse.order_approval_decided' });
    expect(r.n.toUsers[0].n.details).toContainEqual({ label: 'Պատճառ', value: 'Գինը բարձր է' });
  });

  it('finance verdict → procurement alerts of the organisation + the submitter, rejection reason included; a retry tells nobody', async () => {
    const { svc, n } = world({ status: ProcurementOrderStatus.PENDING_FINANCE_APPROVAL, submittedForApprovalBy: 12 });
    await svc.financeCallback(9, 'REJECTED', 'Բյուջե չկա');
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.order_finance_decided',
      permissions: ['receive_procurement_alerts', 'manage_warehouse'],
      entityIds: [7],
      userIds: [12],
    });
    expect(n.sent[0].body).toContain('Բյուջե չկա');
    await svc.financeCallback(9, 'REJECTED', 'Բյուջե չկա');
    expect(n.sent).toHaveLength(1);
  });

  it('a price correction (ADJUSTMENT / REFUND) has its own verdict notice', async () => {
    const { svc, n } = world({
      status: ProcurementOrderStatus.RECEIVED,
      payments: [{ id: 1, type: 'ADJUSTMENT', amount: 300, financeTransferId: 55, status: 'PENDING' }],
    });
    await svc.financeCallback(9, 'APPROVED', undefined, 55);
    expect(n.sent[0]).toMatchObject({ type: 'warehouse.order_finance_decided' });
    expect(n.sent[0].body).toContain('ճշգրտում');
  });
});

// ── Catalog ────────────────────────────────────────────────────────────────────

describe('catalog', () => {
  function world(view: Partial<any> = {}) {
    const n = notifier();
    const requisitions: any = { announceSubmitted: jest.fn() };
    const svc = new CatalogService({} as any, {} as any, {} as any, requisitions, {} as any, {} as any, n as any);
    (svc as any).getOne = jest.fn(async () => ({ id: 4, number: 'REQ-1004', createdBy: 10, status: 'IN_PROGRESS', ...view }));
    return { svc, n, requisitions };
  }
  const actor = { userId: 30, isSuperAdmin: false, permissionNames: [] } as any;

  it('checkout → view_catalog_requests of the organisation, shortage named; purchase approvers once, minus the desk', async () => {
    const { svc, n, requisitions } = world();
    (svc as any).announceCheckout(
      { id: 4, number: 'REQ-1004', entityId: 7, createdBy: 10, purpose: 'Շինարարություն', projectName: null },
      [{ itemName: 'Ցեմենտ', quantity: 5, status: 'PENDING' }],
      [{ itemName: 'Աղյուս', quantity: 100 }],
      { id: 8, status: 'PENDING_APPROVAL', entityId: 7 },
    );
    await settle();
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.catalog_request_received',
      permissions: ['view_catalog_requests'],
      entityIds: [7],
      actorId: 10,
      path: '/catalog/requests/4',
    });
    expect(n.sent[0].body).toContain('Պաշարը չի բավարարում՝ Ցեմենտ');
    expect(requisitions.announceSubmitted).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }), 10, [70, 71]);
  });

  it('approved: ready to collect when every live line is ready, else decided; rejected / info → decided; never the approver', async () => {
    const ready = world({ status: 'READY' });
    await (ready.svc as any).announceToSubmitter(4, actor, { kind: 'approved' });
    expect(ready.n.sent[0]).toMatchObject({ type: 'warehouse.catalog_ready', userIds: [10], actorId: 30, path: '/catalog/my-requests/4' });
    const progress = world({ status: 'IN_PROGRESS' });
    await (progress.svc as any).announceToSubmitter(4, actor, { kind: 'approved' });
    expect(progress.n.sent[0].type).toBe('warehouse.catalog_request_decided');
    const rejected = world();
    await (rejected.svc as any).announceToSubmitter(4, actor, { kind: 'rejected', text: 'Չկա' });
    expect(rejected.n.sent[0]).toMatchObject({ type: 'warehouse.catalog_request_decided' });
    expect(rejected.n.sent[0].body).toContain('Չկա');
    const info = world();
    await (info.svc as any).announceToSubmitter(4, actor, { kind: 'info', text: 'Ո՞ր չափսը' });
    expect(info.n.sent[0].body).toContain('Ո՞ր չափսը');
  });
});

// ── Reservations ───────────────────────────────────────────────────────────────

describe('reservations', () => {
  function world() {
    const n = notifier();
    const prisma: any = {
      catalogSubmission: { findUnique: jest.fn(async () => ({ createdBy: 10, number: 'REQ-1004' })) },
      item: { findUnique: jest.fn(async () => ({ name: 'Ցեմենտ' })) },
    };
    const workspaces: any = { partiesOfReservation: jest.fn(async () => ({ requester: 2, stockOwner: 7 })) };
    const svc = new ReservationsService(prisma, {} as any, {} as any, n as any, {} as any, workspaces, {} as any);
    (svc as any).crmTask = jest.fn(async () => ({ projectId: 3, title: 'Հիմք', assignees: [{ id: 21 }, { id: 22 }] }));
    (svc as any).objectCard = jest.fn(async () => ({ code: 'OB-1', name: 'Շենք', responsibleId: 31 }));
    return { svc, n, prisma };
  }
  const text = { task: 'T', object: 'O', catalog: 'C' };

  it('a task row reaches its assignees, linked to the CRM task', async () => {
    const { svc, n } = world();
    await (svc as any).notifyRequesters({ taskId: 5 }, { title: 't', type: WAREHOUSE_TYPES.reservationRejected, text, actorId: 22 });
    expect(n.toUsers[0]).toMatchObject({ ids: [21, 22], n: { type: 'warehouse.reservation_rejected', body: 'T', path: '/assignments/3?task=5', actorId: 22 } });
  });

  it('an object row reaches the responsible, on the CRM object page, with object wording', async () => {
    const { svc, n } = world();
    await (svc as any).notifyRequesters({ objectId: 8 }, { title: 't', type: WAREHOUSE_TYPES.reservationRejected, text });
    expect(n.toUsers[0]).toMatchObject({ ids: [31], n: { body: 'O', path: '/objects/8' } });
  });

  it('a catalog row reaches the submitter: ready → catalog_ready, otherwise catalog_request_decided', async () => {
    const { svc, n } = world();
    await (svc as any).notifyRequesters({ submissionId: 4 }, { title: 't', type: WAREHOUSE_TYPES.reservationApproved, text, ready: true });
    await (svc as any).notifyRequesters({ submissionId: 4 }, { title: 't', type: WAREHOUSE_TYPES.reservationRejected, text });
    expect(n.toUsers.map((u) => [u.ids, u.n.type, u.n.path])).toEqual([
      [[10], 'warehouse.catalog_ready', '/catalog/my-requests/4'],
      [[10], 'warehouse.catalog_request_decided', '/catalog/my-requests/4'],
    ]);
  });

  it('cancelled by the warehouse → the requesting side; by the requester → the stock owner\'s reservation desk', async () => {
    const byWarehouse = world();
    await (byWarehouse.svc as any).announceCancelled(
      { id: 1, itemId: 3, quantity: 2, taskId: 5 }, 90, 'Չկա',
      { userId: 90, isSuperAdmin: false, permissionNames: ['manage_reservations'] },
    );
    expect(byWarehouse.n.toUsers[0]).toMatchObject({ ids: [21, 22], n: { type: 'warehouse.reservation_cancelled', actorId: 90 } });
    expect(byWarehouse.n.sent).toHaveLength(0);
    const byRequester = world();
    await (byRequester.svc as any).announceCancelled(
      { id: 1, itemId: 3, quantity: 2, taskId: 5 }, 21, undefined,
      { userId: 21, isSuperAdmin: false, permissionNames: [] },
    );
    expect(byRequester.n.sent[0]).toMatchObject({
      type: 'warehouse.reservation_cancelled',
      permissions: ['receive_reservation_alerts', 'manage_warehouse'],
      entityIds: [7],
      actorId: 21,
    });
    expect(byRequester.n.toUsers).toHaveLength(0);
  });

  it('back to pending → the stock owner\'s reservation desk', async () => {
    const { svc, n } = world();
    await (svc as any).notifyWarehouseSide([1, 2], { type: WAREHOUSE_TYPES.reservationBackToPending, title: 't', body: 'b', actorId: 21 });
    expect(n.sent[0]).toMatchObject({ type: 'warehouse.reservation_back_to_pending', entityIds: [7, 7], actorId: 21, path: '/reservations' });
  });
});

// ── Stock requests, transfers, returns ─────────────────────────────────────────

describe('stock requests / transfers / returns', () => {
  it('a sub\'s request → main (manage_stock_transfers) in the items\' organisations; the decision → its creator', async () => {
    const n = notifier();
    const prisma: any = {
      warehouse: { findUnique: jest.fn(async () => ({ name: 'Նախագծային 1' })) },
      item: { findMany: jest.fn(async () => [{ category: { entityId: 7 } }, { category: { entityId: 7 } }]) },
      stockRequest: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        findUnique: jest.fn(async () => ({ id: 6, createdBy: 14, warehouseId: 2 })),
      },
    };
    const svc = new StockRequestsService(prisma, {} as any, {} as any, {} as any, n as any);
    svc.announceCreated({ id: 6, warehouseId: 2, items: [{ itemId: 3, quantity: 1 }, { itemId: 4, quantity: 2 }] }, 14);
    await settle();
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.stock_request_created',
      permissions: ['manage_stock_transfers', 'manage_warehouse'],
      entityIds: [7],
      actorId: 14,
    });
    await svc.reject(6, 40, 'Չկա');
    expect(n.toUsers[0]).toMatchObject({ ids: [14], n: { type: 'warehouse.stock_request_decided', actorId: 40 } });
  });

  it('TO_SUB transfer → the sub\'s responsible, not the sender, not somebody already told', async () => {
    const n = notifier();
    const prisma: any = {
      warehouse: { findUnique: jest.fn(async () => ({ id: 2, name: 'Նախագծային 1', type: 'PROJECT', status: 'ACTIVE', responsibleId: 15 })) },
      item: { findMany: jest.fn(async () => [{ id: 3, name: 'Ցեմենտ', type: 'CONSUMABLE' }]) },
      $transaction: jest.fn(async () => ({ id: 33 })),
    };
    const svc = new StockTransfersService(prisma, { check: jest.fn(), checkWarehouse: jest.fn() } as any, n as any);
    await svc.create({ toWarehouseId: 2, items: [{ itemId: 3, quantity: 5 }] }, 40, { notifyExclude: [14] });
    expect(n.toUsers[0]).toMatchObject({
      ids: [15],
      n: { type: 'warehouse.stock_transfer_incoming', actorId: 40, excludeUserIds: [14], path: '/warehouses' },
    });
  });

  it('a return filed → the stock owner\'s returns desk; received / cancelled by the warehouse → the filer', async () => {
    const n = notifier();
    const prisma: any = { resourceReservation: { findUnique: jest.fn(async () => ({ item: { name: 'Ցեմենտ' } })) } };
    const workspaces: any = { partiesOfReservation: jest.fn(async () => ({ requester: 2, stockOwner: 7 })) };
    const svc = new ResourceReturnsService(prisma, {} as any, workspaces, {} as any, n as any);
    (svc as any).announceFiled({ id: 1, reservationId: 9, quantity: 2, notes: null }, 21);
    await settle();
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.return_filed',
      permissions: ['manage_resource_returns', 'manage_warehouse'],
      entityIds: [7],
      actorId: 21,
    });
    (svc as any).announceDecided({ id: 1, quantity: 2, requestedBy: 21, reservation: { item: { name: 'Ցեմենտ' } } }, 40, true);
    expect(n.toUsers[0]).toMatchObject({ ids: [21], n: { type: 'warehouse.return_decided', actorId: 40 } });
  });
});

// ── Assets, responsibility, maintenance ────────────────────────────────────────

describe('assets / responsibility / maintenance', () => {
  it('returned DAMAGED → issue_assets / manage_warehouse of the item\'s organisation; the holder hears when the warehouse closed it', async () => {
    const n = notifier();
    const prisma: any = { itemCategory: { findUnique: jest.fn(async () => ({ entityId: 7 })) } };
    const users: any = { getUsersByIds: jest.fn(async () => [{ id: 21, firstName: 'Ա', lastName: 'Բ' }]) };
    const svc = new AssetCustodyService(prisma, users, n as any, {} as any);
    const custody = { holderUserId: 21, asset: { serialNumber: 'SN1', item: { name: 'Դրել', categoryId: 2 } } };
    await (svc as any).announceRelease(custody, { condition: ReleaseCondition.DAMAGED }, { userId: 40, isSuperAdmin: false, permissions: ['issue_assets'] });
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.asset_returned_damaged',
      permissions: ['issue_assets', 'manage_warehouse'],
      entityIds: [7],
      actorId: 40,
    });
    expect(n.toUsers[0]).toMatchObject({ ids: [21], n: { type: 'warehouse.responsibility_changed', actorId: 40 } });
    // returned OK by the holder themself: nobody
    const quiet = notifier();
    const svc2 = new AssetCustodyService(prisma, users, quiet as any, {} as any);
    await (svc2 as any).announceRelease(custody, { condition: ReleaseCondition.OK }, { userId: 21, isSuperAdmin: false, permissions: [] });
    expect(quiet.sent).toHaveLength(0);
    expect(quiet.toUsers).toHaveLength(0);
  });

  it('responsibility assigned → the new and the previous responsible, each once', async () => {
    const n = notifier();
    const prisma: any = {
      asset: {
        findUnique: jest.fn(async () => ({ id: 3, serialNumber: null, item: { name: 'Դրել' } })),
        update: jest.fn(async () => ({})),
      },
      assetResponsibility: {
        findMany: jest.fn(async () => [{ userId: 21 }]),
        updateMany: jest.fn(async () => ({})),
        create: jest.fn(async () => ({ id: 1 })),
      },
    };
    const svc = new ResponsibilitiesService(prisma, n as any);
    await svc.assign({ assetId: 3, userId: 22 } as any, 40);
    expect(n.toUsers.map((t) => [t.ids, t.n.type, t.n.actorId])).toEqual([
      [[22], 'warehouse.responsibility_changed', 40],
      [[21], 'warehouse.responsibility_changed', 40],
    ]);
  });

  it('maintenance finance verdict → its author + manage_warehouse of the asset\'s organisation, once', async () => {
    const n = notifier();
    const state: any = { id: 4, status: 'PENDING_FINANCE', createdBy: 12, amount: 5000 };
    const prisma: any = {
      maintenanceRecord: {
        findUnique: jest.fn(async () => ({ ...state })),
        update: jest.fn(async ({ data }: any) => Object.assign(state, data, { asset: { serialNumber: null, item: { name: 'Բեռնատար', categoryId: 2 } } })),
      },
      itemCategory: { findUnique: jest.fn(async () => ({ entityId: 7 })) },
    };
    const svc = new MaintenanceService(prisma, {} as any, n as any);
    await svc.financeCallback(4, 'REJECTED', 'Թանկ է');
    await svc.financeCallback(4, 'REJECTED', 'Թանկ է');
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.maintenance_finance_decided',
      permissions: ['manage_warehouse'],
      entityIds: [7],
      userIds: [12],
    });
    expect(n.sent[0].body).toContain('Թանկ է');
  });
});

// ── Low stock per sub-warehouse ────────────────────────────────────────────────

describe('low stock per sub-warehouse', () => {
  it('latches once per breach, tells the sub\'s responsible, names the warehouse, links the item; re-arms on recovery', async () => {
    const n = notifier();
    const row: any = {
      id: 1, quantity: 2, lowStockNotifiedAt: null,
      warehouse: { name: 'Նախագծային 1', responsibleId: 15 },
      item: { id: 3, name: 'Ցեմենտ', code: null, unit: null, minQuantity: 5, category: { entityId: 7 } },
    };
    const prisma: any = {
      warehouseStock: {
        findMany: jest.fn(async () => [{ ...row }]),
        updateMany: jest.fn(async () => {
          if (row.lowStockNotifiedAt) return { count: 0 };
          row.lowStockNotifiedAt = new Date();
          return { count: 1 };
        }),
        update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
      },
    };
    const svc = new StockAlertService(prisma, n as any);
    await (svc as any).evaluateWarehouse(2, [3]);
    await (svc as any).evaluateWarehouse(2, [3]);
    expect(n.toUsers).toHaveLength(1);
    expect(n.toUsers[0]).toMatchObject({ ids: [15], n: { type: 'warehouse.low_stock', path: '/catalog/items/3' } });
    expect(n.toUsers[0].n.body).toContain('Նախագծային 1');
    row.quantity = 10;
    await (svc as any).evaluateWarehouse(2, [3]);
    expect(row.lowStockNotifiedAt).toBeNull();
  });
});
