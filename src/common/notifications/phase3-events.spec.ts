import { BadRequestException, Logger } from '@nestjs/common';
import { ProcurementOrderStatus } from '@prisma/client';
import { WAREHOUSE_TYPES } from './notifications.service';
import { ProcurementService } from '../../procurement/procurement.service';
import { ItemsService } from '../../items/items.service';
import { AssetCustodyService } from '../../asset-custody/asset-custody.service';
import { AssetsService } from '../../assets/assets.service';
import { ReservationsService } from '../../reservations/reservations.service';
import { CatalogService } from '../../catalog/catalog.service';
import { StockRequestsService } from '../../stock-requests/stock-requests.service';
import { PurchaseRequisitionsService } from '../../purchase-requisitions/purchase-requisitions.service';
import { WarehousesService } from '../../warehouses/warehouses.service';
import { InventoryService } from '../../inventory/inventory.service';
import { InventoryMovementType } from '../../inventory/dto/inventory-movement.dto';
import { WarehouseRemindersService, yerevanDays } from '../../reminders/reminders.service';

/**
 * Notifications phase 3 (2026-10-07): the second-sweep warehouse.* events,
 * the two data fixes (D1 item delete, D2 order delete) and the daily reminder
 * run. Each block checks the recipients, the catalog type, that the actor is
 * never told about their own act and that one act makes one notice per
 * person. Delivery itself (one POST per person, email block) is covered by
 * phase2-events.spec / notifications.service.spec.
 */

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

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

/** Everybody a captured run reached, actor and exclusions applied as the hub would. */
function reached(n: ReturnType<typeof notifier>, holders: number[] = []): number[] {
  const out: number[] = [];
  for (const s of n.sent) {
    const skip = new Set([...(s.excludeUserIds ?? []), ...(s.actorId ? [s.actorId] : [])]);
    out.push(...[...(s.permissions?.length ? holders : []), ...(s.userIds ?? [])].filter((x: any) => x && !skip.has(x)));
  }
  for (const t of n.toUsers) out.push(...t.ids.filter((x: any) => x && x !== t.n.actorId));
  return out;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

const actor = { userId: 40, isSuperAdmin: false, permissionNames: ['manage_items'], home: { wildcard: true, entityIds: [] } } as any;

// ── D1: deleting an item ──────────────────────────────────────────────────────

describe('D1 · deleting an item with open requests or custody is refused', () => {
  function world(opts: { live?: number; custody?: number } = {}) {
    const prisma: any = {
      item: {
        findUnique: jest.fn(async () => ({ id: 3 })),
        findFirst: jest.fn(async () => ({ id: 3, variants: [], images: [], documents: [], attributes: [] })),
        delete: jest.fn(async () => ({ id: 3 })),
      },
      resourceReservation: { count: jest.fn(async () => opts.live ?? 0) },
      assetCustody: { count: jest.fn(async () => opts.custody ?? 0) },
    };
    const svc = new ItemsService(prisma, {} as any, { check: jest.fn() } as any, { of: jest.fn(async () => null) } as any, { remove: jest.fn() } as any);
    (svc as any).detail = jest.fn(async () => ({ id: 3, variants: [], images: [], documents: [] }));
    return { svc, prisma };
  }

  it('live reservations → Armenian 400, nothing deleted', async () => {
    const { svc, prisma } = world({ live: 2 });
    await expect(svc.remove(3, actor)).rejects.toThrow(BadRequestException);
    await expect(svc.remove(3, actor)).rejects.toThrow(/ակտիվ ամրագրումներ \(2\)/);
    expect(prisma.resourceReservation.count).toHaveBeenCalledWith({
      where: { itemId: 3, status: { in: ['PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED'] } },
    });
    expect(prisma.item.delete).not.toHaveBeenCalled();
  });

  it('open custody → Armenian 400, nothing deleted', async () => {
    const { svc, prisma } = world({ custody: 1 });
    await expect(svc.remove(3, actor)).rejects.toThrow(/տրամադրված են պատասխանատուների/);
    expect(prisma.assetCustody.count).toHaveBeenCalledWith({ where: { releasedAt: null, asset: { itemId: 3 } } });
    expect(prisma.item.delete).not.toHaveBeenCalled();
  });

  it('only completed / cancelled history → deleted', async () => {
    const { svc, prisma } = world();
    await svc.remove(3, actor);
    expect(prisma.item.delete).toHaveBeenCalledWith({ where: { id: 3 } });
  });
});

// ── D2 + procurement events ───────────────────────────────────────────────────

describe('procurement · order deleted (D2), placed, price amended', () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  let calls: any[];
  beforeEach(() => {
    process.env.FINANCE_API_URL = 'http://fin.test';
    process.env.FINANCE_SERVICE_URL = 'http://fin.test';
    process.env.INTERNAL_SECRET = 's';
    calls = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ cancelled: [5], skippedCompleted: [] }) } as any;
    }) as any;
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...env };
  });

  function world(row: Partial<any> = {}, reqs: any[] = [{ id: 31, title: 'Ցեմենտ', createdBy: 10 }]) {
    const state: any = {
      id: 9, status: ProcurementOrderStatus.DRAFT, entityId: 7, createdBy: 11, submittedForApprovalBy: 12,
      supplier: { name: 'Մատակարար' }, items: [{ id: 1, itemId: 3, quantity: 2, unitPrice: 50, receivedQuantity: 2, item: { name: 'Ցեմենտ' } }],
      prepaymentAmount: null, payments: [], deliveries: [], ...row,
    };
    const prisma: any = {
      procurementOrder: {
        findUnique: jest.fn(async () => ({ ...state })),
        update: jest.fn(async ({ data }: any) => Object.assign(state, data)),
        delete: jest.fn(async () => ({ id: 9 })),
      },
      purchaseRequisition: { findMany: jest.fn(async () => reqs) },
      procurementOrderItem: { update: jest.fn(async () => ({})) },
      inventoryMovement: { findMany: jest.fn(async () => []) },
      procurementPayment: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const n = notifier();
    const svc = new ProcurementService(prisma, {} as any, {} as any, n as any, {} as any);
    return { svc, prisma, n, state };
  }

  it('an order that reached finance: transfers cancelled by ref BEFORE the delete; submitter + requisition requester told (order_deleted)', async () => {
    const { svc, prisma, n } = world({ status: ProcurementOrderStatus.ORDERED });
    await svc.remove(9, 50);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://fin.test/api/transfer/external/cancel-by-ref');
    expect(calls[0].body.externalRef).toBe('warehouse_procurement:9');
    expect(prisma.procurementOrder.delete).toHaveBeenCalled();
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.order_deleted',
      userIds: [12, 10],
      actorId: 50,
      path: '/purchase-requisitions?requisition=31',
    });
    expect(n.sent[0].permissions).toBeUndefined();
    expect(n.sent[0].body).toContain('#31');
  });

  it('finance refuses → the delete is refused, nobody told', async () => {
    const { svc, prisma, n } = world({ status: ProcurementOrderStatus.PENDING_FINANCE_APPROVAL });
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 })) as any;
    await expect(svc.remove(9, 50)).rejects.toThrow(/finance-api 503/);
    expect(prisma.procurementOrder.delete).not.toHaveBeenCalled();
    expect(n.sent).toHaveLength(0);
  });

  it('a draft that never reached finance: no finance call; the submitter deleting it is not told', async () => {
    const { svc, n } = world({ status: ProcurementOrderStatus.DRAFT, submittedForApprovalBy: null }, []);
    await svc.remove(9, 11);
    expect(calls).toHaveLength(0);
    expect(reached(n)).toEqual([]);
    // a deleted order cannot be opened: the bare list, no id
    expect(n.sent[0].path).toBe('/procurement');
  });

  it('a draft with a live finance payment row still cancels by ref', async () => {
    const { svc } = world({ status: ProcurementOrderStatus.FINANCE_REJECTED, payments: [{ financeTransferId: 4, status: 'PENDING' }] });
    await svc.remove(9, 50);
    expect(calls).toHaveLength(1);
  });

  it('order placed → manage_warehouse of its organisation + the submitter + requisition requesters, never the placer', async () => {
    const { svc, n } = world({ status: ProcurementOrderStatus.FINANCE_APPROVED });
    await svc.confirmOrdered(9, 12);
    await settle();
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.order_placed',
      permissions: ['manage_warehouse'],
      entityIds: [7],
      userIds: [12, 10],
      actorId: 12,
      path: '/procurement?order=9',
    });
    expect(reached(n)).toEqual([10]);
  });

  it('price amended → procurement alerts of the organisation + the submitter, with old → new and the reason', async () => {
    const { svc, n } = world({ status: ProcurementOrderStatus.RECEIVED });
    (svc as any).reconcileWithFinance = jest.fn(async () => ({ action: 'adjusted', delta: 20 }));
    await svc.amend(9, { lines: [{ orderItemId: 1, unitPrice: 60 }], reason: 'Հաշիվ-ապրանքագիր' }, 50);
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.price_amended',
      permissions: ['receive_procurement_alerts', 'manage_warehouse'],
      entityIds: [7],
      userIds: [12],
      actorId: 50,
      path: '/procurement?order=9',
    });
    expect(n.sent[0].body).toContain('Ցեմենտ: 50 → 60');
    expect(n.sent[0].details).toContainEqual({ label: 'Պատճառ', value: 'Հաշիվ-ապրանքագիր' });
  });
});

// ── Asset requests and custody ────────────────────────────────────────────────

describe('asset requests / custody', () => {
  function world(request: Partial<any> = {}, custody: Partial<any> = {}) {
    const n = notifier();
    const prisma: any = {
      assetRequest: {
        findUnique: jest.fn(async () => ({ id: 6, status: 'PENDING', entityId: 7, requestedBy: 20, forUserId: 21, forObjectId: null, quantity: 1, item: { name: 'Նոութբուք' }, custodies: [], ...request })),
        update: jest.fn(async () => ({ id: 6, status: 'CANCELLED' })),
      },
      assetCustody: {
        findUnique: jest.fn(async () => ({ id: 2, holderType: 'USER', holderUserId: 21, assignedBy: 40, acceptedAt: null, releasedAt: null, asset: { serialNumber: 'SN1', item: { name: 'Նոութբուք' } }, ...custody })),
        update: jest.fn(async () => ({ id: 2 })),
      },
    };
    const users: any = { getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id, firstName: 'Ա', lastName: `${id}` }))) };
    const objects: any = { crmObject: jest.fn(async () => ({ code: 'OB-1', name: 'Շենք', responsibleId: 31 })), crmObjectFresh: jest.fn(async () => ({ responsibleId: 31 })) };
    const svc = new AssetCustodyService(prisma, users, n as any, objects);
    return { svc, n };
  }

  it('cancelled while pending → approvers of its organisation (the register) + the beneficiary (their profile); never the requester', async () => {
    const { svc, n } = world();
    await svc.cancel(6, { userId: 20, isSuperAdmin: false, permissions: [] });
    await settle();
    expect(n.toUsers[0]).toMatchObject({ ids: [21, 20], n: { type: 'warehouse.asset_request_cancelled', actorId: 20, path: '/profile?tab=assets' } });
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.asset_request_cancelled',
      permissions: ['approve_asset_requests'],
      entityIds: [7],
      excludeUserIds: [21, 20],
      actorId: 20,
    });
    // one notice each: holders 70/71 + the beneficiary 21; the requester (actor) none
    expect(reached(n, [70, 71, 21]).sort()).toEqual([21, 70, 71]);
  });

  it('cancelled once approved → the issuers', async () => {
    const { svc, n } = world({ status: 'APPROVED' });
    await svc.cancel(6, { userId: 20, isSuperAdmin: false, permissions: [] });
    await settle();
    expect(n.sent[0].permissions).toEqual(['issue_assets']);
  });

  it('receipt confirmed → the issuer, not the holder; an already-confirmed receipt tells nobody', async () => {
    const { svc, n } = world();
    await svc.accept(2, { userId: 21, isSuperAdmin: false, permissions: [] });
    await settle();
    expect(n.toUsers).toHaveLength(1);
    expect(n.toUsers[0]).toMatchObject({ ids: [40], n: { type: 'warehouse.receipt_confirmed', actorId: 21 } });
    const again = world({}, { acceptedAt: new Date() });
    await again.svc.accept(2, { userId: 21, isSuperAdmin: false, permissions: [] });
    await settle();
    expect(again.n.toUsers).toHaveLength(0);
  });
});

describe('assets · status changed while held', () => {
  function world(status = 'AVAILABLE') {
    const n = notifier();
    const prisma: any = {
      asset: {
        findUnique: jest.fn(async () => ({ id: 5, status, serialNumber: 'SN9', item: { name: 'Դրել' } })),
        update: jest.fn(async () => ({ id: 5 })),
        delete: jest.fn(async () => ({ id: 5 })),
      },
      assetCustody: { findMany: jest.fn(async () => [{ holderUserId: 21, holderObjectId: null }, { holderUserId: null, holderObjectId: 8 }]) },
      reservationAllocation: { findMany: jest.fn(async () => [{ reservation: { id: 1, taskId: 5, objectId: null, submissionId: null } }]) },
    };
    const objects: any = { crmObject: jest.fn(async () => ({ responsibleId: 31 })) };
    const reservations: any = { requesterSide: jest.fn(async () => ({ kind: 'task', userIds: [21, 22], path: '/assignments/3?task=5' })) };
    const svc = new AssetsService(prisma, { of: jest.fn(async () => null) } as any, {} as any, n as any, objects, reservations);
    (svc as any).findOne = jest.fn(async () => ({ id: 5 }));
    return { svc, n };
  }

  it('retired → the custody holder, the object\'s responsible, the task\'s people — one notice each, not the actor', async () => {
    const { svc, n } = world();
    await svc.update(5, { status: 'RETIRED' } as any, { ...actor, userId: 22 });
    await settle();
    expect(n.toUsers.every((t) => t.n.type === 'warehouse.asset_status_changed')).toBe(true);
    expect(reached(n).sort()).toEqual([21, 31]);
  });

  it('deleted → the holders are told before the cascade', async () => {
    const { svc, n } = world();
    await svc.remove(5, actor);
    await settle();
    expect(reached(n).sort()).toEqual([21, 22, 31]);
    expect(n.toUsers[0].n.body).toContain('ջնջվել');
  });

  it('another status (or retiring an already-retired asset) → nobody', async () => {
    const a = world();
    await a.svc.update(5, { status: 'DAMAGED' } as any, actor);
    const b = world('RETIRED');
    await b.svc.update(5, { status: 'RETIRED' } as any, actor);
    await settle();
    expect(a.n.toUsers).toHaveLength(0);
    expect(b.n.toUsers).toHaveLength(0);
  });
});

// ── Items: changed under open requests ────────────────────────────────────────

describe('items · changed while requests are open', () => {
  it('quantity / unit / visibility → the requesting side of live reservations, asset and stock requesters; one each, not the editor', async () => {
    const n = notifier();
    const prisma: any = {
      item: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({})) },
      itemAttribute: { deleteMany: jest.fn(), createMany: jest.fn() },
      resourceReservation: { findMany: jest.fn(async () => [{ id: 1, taskId: 5 }, { id: 2, submissionId: 4 }]) },
      assetRequest: { findMany: jest.fn(async () => [{ requestedBy: 25, forUserId: 26 }]) },
      stockRequest: { findMany: jest.fn(async () => [{ createdBy: 21 }, { createdBy: 40 }]) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const reservations: any = {
      requesterSide: jest.fn(async (r: any) =>
        r.taskId ? { kind: 'task', userIds: [21, 22], path: '/assignments/3?task=5' } : { kind: 'catalog', userIds: [10], path: '/goods-requests?tab=mine&id=4' }),
    };
    const svc = new ItemsService(prisma, {} as any, { check: jest.fn() } as any, { of: jest.fn() } as any, {} as any, n as any, reservations);
    (svc as any).findOne = jest.fn(async () => ({ id: 3, name: 'Ցեմենտ', quantity: 10, unit: 'KG', catalogVisible: true, parentItemId: null, variants: [] }));
    (svc as any).detail = jest.fn(async () => ({ id: 3 }));
    (svc as any).assertMayEdit = jest.fn();
    await svc.update(3, { quantity: 4, unit: 'TONNE', catalogVisible: false } as any, actor);
    await settle();
    const ids = reached(n);
    expect(ids.sort((a, b) => a - b)).toEqual([10, 21, 22, 25, 26]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(n.toUsers.every((t) => t.n.type === 'warehouse.item_changed')).toBe(true);
    const body = n.toUsers[0].n.body;
    expect(body).toContain('քանակ՝ 10 → 4');
    expect(body).toContain('կգ → տոննա');
    expect(body).toContain('հանվել է կատալոգից');
    expect(n.toUsers.find((t) => t.ids.includes(10))!.n.path).toBe('/goods-requests?tab=mine&id=4');
  });

  it('an edit of other fields tells nobody', async () => {
    const n = notifier();
    const prisma: any = { item: { update: jest.fn() }, $transaction: jest.fn(async (fn: any) => fn(prisma)) };
    const svc = new ItemsService(prisma, {} as any, { check: jest.fn() } as any, { of: jest.fn() } as any, {} as any, n as any, {} as any);
    (svc as any).findOne = jest.fn(async () => ({ id: 3, name: 'Ցեմենտ', quantity: 10, unit: 'KG', catalogVisible: true, variants: [] }));
    (svc as any).detail = jest.fn(async () => ({ id: 3 }));
    (svc as any).assertMayEdit = jest.fn();
    await svc.update(3, { notes: 'x', quantity: 10, unit: 'KG' } as any, actor);
    await settle();
    expect(n.toUsers).toHaveLength(0);
  });
});

// ── Reservations: partial acceptance, allocation changes, reactivation ────────

describe('reservations · partial acceptance / allocation changed / reactivated', () => {
  function world(res: Partial<any> = {}) {
    const n = notifier();
    const state: any = { id: 1, itemId: 3, quantity: 5, status: 'ALLOCATED', acceptedQuantity: 0, acceptanceComment: null, taskId: 5, item: { name: 'Ցեմենտ', type: 'CONSUMABLE', quantity: 0 }, ...res };
    const prisma: any = {
      resourceReservation: {
        findUnique: jest.fn(async () => ({ ...state })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        update: jest.fn(async () => ({})),
      },
      reservationAllocation: {
        aggregate: jest.fn(async () => ({ _sum: { quantity: 5 } })),
        findUnique: jest.fn(async () => ({ id: 7, reservationId: 1, assetId: 50, quantity: 1, asset: { serialNumber: 'OLD' }, reservation: { ...state, item: { name: 'Դրել', type: 'ASSET' } } })),
        update: jest.fn(async () => ({})),
        count: jest.fn(async () => 0),
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: 8 })),
      },
      reservationAllocationHistory: { create: jest.fn(async () => ({})) },
      reservationStatusHistory: { create: jest.fn(async () => ({})) },
      asset: { findUnique: jest.fn(async () => ({ id: 51, status: 'AVAILABLE', itemId: 3, serialNumber: 'NEW' })) },
      assetCustody: { findFirst: jest.fn(async () => ({ holderType: 'USER', holderUserId: 9 })) },
      maintenanceRecord: { findFirst: jest.fn(async () => null) },
      item: { findUnique: jest.fn(async () => ({ name: 'Ցեմենտ' })) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const users: any = { getUserAccessInfo: jest.fn(async () => ({ isSuperAdmin: true, permissionNames: [] })) };
    const workspaces: any = { partiesOfReservation: jest.fn(async () => ({ requester: 2, stockOwner: 7 })) };
    const svc = new ReservationsService(prisma, {} as any, { check: jest.fn() } as any, n as any, users, workspaces, {} as any);
    (svc as any).crmTask = jest.fn(async () => ({ projectId: 3, title: 'Հիմք', assignees: [{ id: 21 }, { id: 22 }] }));
    (svc as any).assertMay = jest.fn();
    (svc as any).writeStatusHistory = jest.fn();
    (svc as any).reverseCostInfo = jest.fn(async () => ({ objectId: null, unitCost: null }));
    return { svc, n };
  }

  it('accepting less than issued → the stock owner\'s reservation desk, with the comment; a full acceptance tells nobody', async () => {
    const { svc, n } = world();
    await svc.accept(1, 21, 3, 'Երկու պարկ պատռված էր');
    await settle();
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.partial_acceptance',
      permissions: ['receive_reservation_alerts', 'manage_warehouse'],
      entityIds: [7],
      actorId: 21,
      path: '/goods-requests?tab=approve&reservation=1',
    });
    expect(n.sent[0].body).toContain('Երկու պարկ պատռված էր');
    expect(n.sent[0].details).toContainEqual({ label: 'Պատճառ', value: 'Երկու պարկ պատռված էր' });
    const full = world();
    await full.svc.accept(1, 21, 5);
    await settle();
    expect(full.n.sent).toHaveLength(0);
  });

  it('an issued asset swapped → the task\'s assignees (allocation_changed), not the warehouse actor', async () => {
    const { svc, n } = world();
    await svc.reallocate({ allocationId: 7, newAssetId: 51, reason: 'Վնասված' } as any, 40);
    await settle();
    expect(n.toUsers[0]).toMatchObject({ ids: [21, 22], n: { type: 'warehouse.allocation_changed', actorId: 40, path: '/assignments/3?task=5' } });
    expect(n.toUsers[0].n.body).toContain('OLD → NEW');
  });

  it('an issued allocation released → allocation_changed to the requesting side', async () => {
    const { svc, n } = world();
    await svc.releaseAllocation(7, 40, 'Սխալմամբ');
    await settle();
    expect(n.toUsers[0]).toMatchObject({ ids: [21, 22], n: { type: 'warehouse.allocation_changed', actorId: 40 } });
  });

  it('un-cancelled → reservation_reactivated to the requesting side (keeps its own type on a catalog row)', async () => {
    const a = world({ status: 'CANCELLED' });
    await a.svc.uncancel(1, 40);
    await settle();
    expect(a.n.toUsers[0]).toMatchObject({ ids: [21, 22], n: { type: 'warehouse.reservation_reactivated', actorId: 40 } });
    const cat = world({ status: 'CANCELLED', taskId: null, submissionId: 4 });
    (cat.svc as any).prisma.catalogSubmission = { findUnique: jest.fn(async () => ({ createdBy: 10, number: 'REQ-1004' })) };
    await cat.svc.uncancel(1, 40);
    await settle();
    expect(cat.n.toUsers[0]).toMatchObject({ ids: [10], n: { type: 'warehouse.reservation_reactivated', path: '/goods-requests?tab=mine&id=4' } });
  });
});

// ── Catalog: edited / attachment ──────────────────────────────────────────────

describe('catalog · edited by the requester / file attached', () => {
  function world() {
    const n = notifier();
    const prisma: any = {
      resourceReservation: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({})) },
      reservationStatusHistory: { create: jest.fn(async () => ({})) },
      purchaseRequisitionLine: { update: jest.fn(async () => ({})) },
      catalogSubmission: { update: jest.fn(async () => ({})) },
      purchaseRequisition: { update: jest.fn(async () => ({})) },
      purchaseRequisitionAttachment: { create: jest.fn(async () => ({})) },
    };
    const requisitions: any = { cancel: jest.fn(async () => ({})) };
    const reservations: any = { cancel: jest.fn(async () => ({})) };
    const svc = new CatalogService(prisma, {} as any, reservations, requisitions, {} as any, { upload: () => '/u/f' } as any, n as any);
    const loaded = {
      sub: { id: 4, number: 'REQ-1004', entityId: 7, createdBy: 10, purpose: 'Շինարարություն', comment: null, neededBy: new Date('2026-12-01') },
      reservations: [{ id: 1, itemId: 3, quantity: 5, status: 'PENDING', item: { name: 'Ցեմենտ', type: 'CONSUMABLE' } }],
      requisition: { id: 8, status: 'PENDING_APPROVAL', lines: [{ id: 2, itemName: 'Աղյուս', quantity: 100 }] },
    };
    (svc as any).ownEditable = jest.fn(async () => ({ loaded, lines: [{ id: 'r1', itemName: 'Ցեմենտ' }, { id: 'l2', itemName: 'Աղյուս' }] }));
    (svc as any).loadOne = jest.fn(async () => loaded);
    (svc as any).getOne = jest.fn(async () => ({ id: 4 }));
    return { svc, n, requisitions };
  }

  it('edited → the catalog desk of its organisation, the changes named; never the requester', async () => {
    const { svc, n } = world();
    await svc.edit(4, { lines: [{ id: 'r1', quantity: 7 }, { id: 'l2', quantity: 100 }], purpose: 'Նոր նպատակ' } as any, 10, actor);
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.catalog_request_edited',
      permissions: ['view_catalog_requests'],
      entityIds: [7],
      actorId: 10,
      path: '/goods-requests?tab=approve&id=4',
    });
    expect(n.sent[0].body).toContain('Ցեմենտ: 5 → 7');
    expect(n.sent[0].body).toContain('նպատակ');
    expect(n.sent[0].body).not.toContain('Աղյուս');
  });

  it('an edit that changes nothing tells nobody', async () => {
    const { svc, n } = world();
    await svc.edit(4, { lines: [{ id: 'r1', quantity: 5 }] } as any, 10, actor);
    expect(n.sent).toHaveLength(0);
  });

  it('a file attached → request_attachment to the desk', async () => {
    const { svc, n } = world();
    await svc.addAttachment(4, 10, { originalname: 'hashiv.pdf', size: 1, mimetype: 'application/pdf' } as any, actor);
    expect(n.sent[0]).toMatchObject({ type: 'warehouse.request_attachment', permissions: ['view_catalog_requests'], actorId: 10 });
  });

  it('withdrawing the submission cancels its requisition quietly (one notice: the submission\'s)', async () => {
    const { svc, n, requisitions } = world();
    await svc.cancel(4, 10, actor);
    expect(requisitions.cancel).toHaveBeenCalledWith(8, 10, false, { quiet: true });
    expect(n.sent.map((s) => s.type)).toEqual(['warehouse.reservation_cancelled']);
  });
});

// ── Stock requests / requisitions ─────────────────────────────────────────────

describe('stock requests · cancelled', () => {
  it('→ main (manage_stock_transfers) of the items\' organisations; the requester withdrawing is not told, an admin\'s withdrawal tells them', async () => {
    const n = notifier();
    const prisma: any = {
      stockRequest: {
        findUnique: jest.fn(async () => ({ id: 6, status: 'PENDING', createdBy: 14, warehouseId: 2 })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      warehouse: { findUnique: jest.fn(async () => ({ name: 'Նախագծային 1' })) },
      stockRequestItem: { findMany: jest.fn(async () => [{ itemId: 3, quantity: 2, item: { name: 'Ցեմենտ' } }]) },
      item: { findMany: jest.fn(async () => [{ category: { entityId: 7 } }]) },
    };
    const svc = new StockRequestsService(prisma, {} as any, {} as any, {} as any, n as any);
    await svc.cancel(6, 14, false);
    await settle();
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.stock_request_cancelled',
      permissions: ['manage_stock_transfers', 'manage_warehouse'],
      entityIds: [7],
      userIds: [14],
      actorId: 14,
      path: '/stock-requests?request=6',
    });
    expect(n.sent[0].body).toContain('Ցեմենտ × 2');
    expect(reached(n)).toEqual([]);
  });
});

describe('purchase requisitions · cancelled / in review / file', () => {
  function world(row: Partial<any> = {}) {
    const state: any = { id: 5, title: 'Ցեմենտ', status: 'SUBMITTED', entityId: 7, createdBy: 10, decidedBy: 20, reviewedBy: null, lines: [], comments: [], attachments: [], ...row };
    const prisma: any = {
      purchaseRequisition: { findUnique: jest.fn(async () => ({ ...state })), update: jest.fn(async ({ data }: any) => Object.assign(state, data)) },
      purchaseRequisitionComment: { findMany: jest.fn(async () => []) },
      purchaseRequisitionAttachment: { create: jest.fn(async () => ({})) },
    };
    const users: any = { getUserAccessInfo: jest.fn(async () => ({ isSuperAdmin: false, permissionNames: ['manage_procurement'] })), getUsersByIds: jest.fn(async () => []) };
    const n = notifier();
    const svc = new PurchaseRequisitionsService(prisma, users, { upload: () => '/u/x' } as any, n as any);
    (svc as any).findOne = jest.fn(async () => ({ id: 5 }));
    return { svc, n };
  }

  it('withdrawn after submission → procurement of the organisation + whoever acted; not the requester', async () => {
    const { svc, n } = world();
    await svc.cancel(5, 10, false);
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.requisition_cancelled',
      permissions: ['manage_procurement'],
      entityIds: [7],
      userIds: [20, 10],
      actorId: 10,
    });
    const pending = world({ status: 'PENDING_APPROVAL', decidedBy: null });
    await pending.svc.cancel(5, 10, false);
    expect(pending.n.sent[0].permissions).toEqual(['approve_purchase_requisition']);
  });

  it('a draft withdrawn, or a quiet (catalog) withdrawal, tells nobody', async () => {
    const draft = world({ status: 'DRAFT' });
    await draft.svc.cancel(5, 10, false);
    const quiet = world();
    await quiet.svc.cancel(5, 10, false, { quiet: true });
    expect(draft.n.sent).toHaveLength(0);
    expect(quiet.n.sent).toHaveLength(0);
  });

  it('taken into review → the requester (requisition_in_review), not the reviewer', async () => {
    const { svc, n } = world();
    await svc.review(5, 30);
    expect(n.sent[0]).toMatchObject({ type: 'warehouse.requisition_in_review', userIds: [10], actorId: 30, path: '/purchase-requisitions?requisition=5' });
  });

  it('a file → request_attachment, the comment audience', async () => {
    const { svc, n } = world({ status: 'IN_REVIEW', reviewedBy: 30 });
    await svc.addAttachment(5, 30, { originalname: 'a.pdf', size: 1, mimetype: 'application/pdf' } as any, { isSuperAdmin: true, permissionNames: [] } as any);
    await settle();
    expect(n.sent[0]).toMatchObject({ type: 'warehouse.request_attachment', actorId: 30 });
    expect(n.sent[0].userIds).toContain(10);
  });
});

// ── Warehouses / manual stock movements ───────────────────────────────────────

describe('warehouses · responsible / staff / closed', () => {
  it('each person once with their own change; never the editor', async () => {
    const n = notifier();
    const before = { id: 2, name: 'Նախագծային 1', code: 'P1', type: 'PROJECT', status: 'ACTIVE', responsibleId: 15, projects: [], employees: [{ userId: 16 }, { userId: 17 }] };
    const prisma: any = {
      warehouse: {
        findUnique: jest.fn(async () => before),
        update: jest.fn(async () => ({ ...before, status: 'INACTIVE', responsibleId: 18, employees: [{ userId: 17 }, { userId: 19 }, { userId: 40 }] })),
      },
    };
    const svc = new WarehousesService(prisma, {} as any, n as any);
    await svc.update(2, { responsibleId: 18, employeeIds: [17, 19, 40], status: 'INACTIVE' }, 40);
    await settle();
    expect(n.toUsers.every((t) => t.n.type === 'warehouse.warehouse_assignment' && t.ids.length === 1)).toBe(true);
    const by = new Map(n.toUsers.map((t) => [t.ids[0], t.n.body]));
    expect([...by.keys()].sort()).toEqual([15, 16, 17, 18, 19, 40]);
    expect(reached(n).sort()).toEqual([15, 16, 17, 18, 19]);
    expect(by.get(18)).toContain('նշանակվել եք պահեստի պատասխանատու');
    expect(by.get(15)).toContain('այլևս պահեստի պատասխանատուն չեք');
    expect(by.get(16)).toContain('հանվել եք');
    expect(by.get(19)).toContain('ավելացվել եք');
    expect(by.get(17)).toContain('փակվել է');
  });

  it('a save that changes nobody tells nobody', async () => {
    const n = notifier();
    const wh = { id: 2, name: 'Ն', code: 'P1', type: 'PROJECT', status: 'ACTIVE', responsibleId: 15, projects: [], employees: [{ userId: 16 }] };
    const prisma: any = { warehouse: { findUnique: jest.fn(async () => wh), update: jest.fn(async () => wh) } };
    const svc = new WarehousesService(prisma, {} as any, n as any);
    await svc.update(2, { responsibleId: 15, employeeIds: [16], location: 'x' }, 40);
    expect(n.toUsers).toHaveLength(0);
  });
});

describe('inventory · manual movement', () => {
  function world(responsibleId: number | null = 15) {
    const n = notifier();
    const prisma: any = {
      item: { findUnique: jest.fn(async () => ({ id: 3, name: 'Ցեմենտ', type: 'CONSUMABLE', quantity: 10 })), update: jest.fn() },
      inventoryMovement: { create: jest.fn(async () => ({ id: 1 })) },
      warehouse: { findFirst: jest.fn(async () => ({ responsibleId, name: 'Հիմնական' })) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const svc = new InventoryService(prisma, { check: jest.fn() } as any, {} as any, {} as any, n as any);
    return { svc, n };
  }

  it('→ the main warehouse\'s responsible person (stock_adjusted), before → after', async () => {
    const { svc, n } = world();
    await svc.createMovement({ itemId: 3, quantity: 4, type: InventoryMovementType.OUT, notes: 'Խոտան' } as any, 40);
    await settle();
    expect(n.toUsers[0]).toMatchObject({ ids: [15], n: { type: 'warehouse.stock_adjusted', actorId: 40, path: '/movements' } });
    expect(n.toUsers[0].n.body).toContain('10 → 6');
  });

  it('the responsible person adjusting it themself is not told', async () => {
    const { svc, n } = world(40);
    await svc.createMovement({ itemId: 3, quantity: 2, type: InventoryMovementType.ADJUSTMENT } as any, 40);
    await settle();
    expect(reached(n)).toEqual([]);
  });
});

// ── The daily reminder run ────────────────────────────────────────────────────

describe('daily reminders (09:00 Asia/Yerevan)', () => {
  // 2026-10-07 09:00 in Yerevan = 05:00 UTC.
  const now = new Date('2026-10-07T05:00:00Z');
  const days = yerevanDays(now);

  function world(data: { maintenance?: any[]; reservations?: any[]; custody?: any[] } = {}) {
    const n = notifier();
    const markers = new Set<string>();
    const prisma: any = {
      maintenanceRecord: { findMany: jest.fn(async () => data.maintenance ?? []) },
      resourceReservation: { findMany: jest.fn(async () => data.reservations ?? []) },
      assetCustody: { findMany: jest.fn(async () => data.custody ?? []) },
      itemCategory: { findUnique: jest.fn(async () => ({ entityId: 7 })) },
      warehouseReminderMarker: {
        createMany: jest.fn(async ({ data: rows }: any) => {
          const key = `${rows[0].kind}:${rows[0].refId}:${rows[0].day.toISOString()}`;
          if (markers.has(key)) return { count: 0 };
          markers.add(key);
          return { count: 1 };
        }),
      },
    };
    const reservations: any = { requesterSide: jest.fn(async () => ({ kind: 'task', userIds: [21, 22], path: '/assignments/3?task=5', label: 'Հիմք' })) };
    const objects: any = { crmObject: jest.fn(async () => ({ responsibleId: 31 })) };
    const svc = new WarehouseRemindersService(prisma, n as any, reservations, objects);
    return { svc, n, prisma };
  }

  it('the Yerevan day and its boundaries', () => {
    expect(days.day).toBe('2026-10-07');
    expect(days.todayStart.toISOString()).toBe('2026-10-06T20:00:00.000Z');
    expect(days.tomorrowStart.toISOString()).toBe('2026-10-07T20:00:00.000Z');
    expect(days.overdueFloor.toISOString()).toBe('2026-09-29T20:00:00.000Z');
  });

  it('runs at 09:00 Asia/Yerevan', () => {
    const meta = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', WarehouseRemindersService.prototype.daily);
    expect(meta).toMatchObject({ cronTime: '0 9 * * *', timeZone: 'Asia/Yerevan' });
  });

  it('maintenance starting tomorrow → the holder (their page) + manage_maintenance / manage_warehouse of the item\'s organisation, once a day', async () => {
    const rec = {
      id: 4, status: 'FINANCE_APPROVED', startDate: new Date('2026-10-08T06:00:00Z'), endDate: new Date('2026-10-10T06:00:00Z'),
      asset: { serialNumber: 'SN1', responsibleUserId: null, item: { name: 'Բեռնատար', categoryId: 2 }, custodies: [{ holderUserId: 21, holderObjectId: null }] },
    };
    const { svc, n, prisma } = world({ maintenance: [rec] });
    await svc.run(now);
    expect(n.toUsers[0]).toMatchObject({ ids: [21], n: { type: 'warehouse.maintenance_due', path: '/profile?tab=assets' } });
    expect(n.toUsers[0].n.title).toContain('վաղը');
    expect(n.sent[0]).toMatchObject({
      type: 'warehouse.maintenance_due',
      permissions: ['manage_maintenance', 'manage_warehouse'],
      entityIds: [7],
      excludeUserIds: [21],
      path: '/maintenance?maintenance=4',
    });
    // open statuses and the two windows are asked for
    const where = prisma.maintenanceRecord.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['DRAFT', 'PENDING_FINANCE', 'FINANCE_APPROVED', 'IN_PROGRESS']);
    expect(where.OR[0].startDate).toEqual({ gte: days.tomorrowStart, lt: days.dayAfterStart });
    expect(where.OR[1].endDate).toEqual({ lt: days.todayStart, gte: days.overdueFloor });
    // a second run the same day (restart / second replica) sends nothing
    await svc.run(new Date('2026-10-07T08:00:00Z'));
    expect(n.toUsers).toHaveLength(1);
    expect(n.sent).toHaveLength(1);
  });

  it('maintenance overdue and still open → overdue wording', async () => {
    const rec = { id: 5, status: 'IN_PROGRESS', startDate: new Date('2026-09-30T06:00:00Z'), endDate: new Date('2026-10-05T06:00:00Z'), asset: { item: { name: 'Դրել' }, custodies: [] } };
    const { svc, n } = world({ maintenance: [rec] });
    await svc.run(now);
    expect(n.toUsers).toHaveLength(0);
    expect(n.sent[0].title).toBe('Սպասարկման ժամկետն անցել է');
  });

  it('asset due back tomorrow / overdue → the requesting side, once a day; only reservations with an asset still out', async () => {
    const r = { id: 9, endDate: new Date('2026-10-08T10:00:00Z'), taskId: 5, item: { name: 'Դրել' }, allocations: [{ asset: { serialNumber: 'SN1' } }] };
    const late = { ...r, id: 10, endDate: new Date('2026-10-03T10:00:00Z') };
    const { svc, n, prisma } = world({ reservations: [r, late] });
    await svc.run(now);
    await svc.run(now);
    expect(n.toUsers).toHaveLength(2);
    expect(n.toUsers[0]).toMatchObject({ ids: [21, 22], n: { type: 'warehouse.asset_due_back', path: '/assignments/3?task=5' } });
    expect(n.toUsers[0].n.title).toContain('վաղը');
    expect(n.toUsers[1].n.title).toContain('անցել');
    const where = prisma.resourceReservation.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ item: { type: 'ASSET' }, allocations: { some: { releasedAt: null, assetId: { not: null } } } });
    expect(where.OR[1].endDate.gte).toEqual(days.overdueFloor);
  });

  it('receipt unconfirmed after 2 days → the holder, the issuer copied; an object\'s asset → its responsible person', async () => {
    const c1 = { id: 2, holderUserId: 21, holderObjectId: null, assignedBy: 40, assignedAt: new Date('2026-10-04T08:00:00Z'), asset: { item: { name: 'Նոութբուք' } } };
    const c2 = { id: 3, holderUserId: null, holderObjectId: 8, assignedBy: 40, assignedAt: new Date('2026-10-04T08:00:00Z'), asset: { item: { name: 'Գեներատոր' } } };
    const { svc, n, prisma } = world({ custody: [c1, c2] });
    await svc.run(now);
    expect(n.toUsers.map((t) => [t.ids[0], t.n.type, t.n.path])).toEqual([
      [21, 'warehouse.receipt_unconfirmed', '/profile?tab=assets'],
      [40, 'warehouse.receipt_unconfirmed', '/assets?tab=custody'],
      [31, 'warehouse.receipt_unconfirmed', '/objects/8'],
      [40, 'warehouse.receipt_unconfirmed', '/assets?tab=custody'],
    ]);
    const where = prisma.assetCustody.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ releasedAt: null, acceptedAt: null });
    expect(where.assignedAt.lte.toISOString()).toBe('2026-10-05T05:00:00.000Z');
  });

  it('one failing kind does not stop the others', async () => {
    const { svc, n, prisma } = world({ custody: [{ id: 2, holderUserId: 21, assignedBy: null, assignedAt: new Date(), asset: { item: { name: 'X' } } }] });
    prisma.maintenanceRecord.findMany = jest.fn(async () => {
      throw new Error('db down');
    });
    const result = await svc.run(now);
    expect(result).toEqual({ maintenance: 0, dueBack: 0, receipts: 1 });
    expect(n.toUsers).toHaveLength(1);
  });

  it('every phase-3 key is a warehouse.* catalog key', () => {
    for (const k of ['maintenanceDue', 'assetDueBack', 'receiptUnconfirmed', 'orderDeleted', 'priceAmended', 'assetRequestCancelled', 'partialAcceptance',
      'allocationChanged', 'catalogRequestEdited', 'stockRequestCancelled', 'requisitionCancelled', 'assetStatusChanged', 'itemChanged',
      'warehouseAssignment', 'receiptConfirmed', 'requisitionInReview', 'orderPlaced', 'reservationReactivated', 'requestAttachment', 'stockAdjusted'] as const) {
      expect((WAREHOUSE_TYPES as any)[k]).toMatch(/^warehouse\.[a-z_]+$/);
    }
  });
});
