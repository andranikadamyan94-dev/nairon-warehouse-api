import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';

import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { CatalogController } from './catalog.controller';
import { CatalogService, QUEUE_VIEWER_PERMISSIONS } from './catalog.service';

/**
 * The one queue (owner 2026-10-08): «Հաստատում» holds every request —
 * catalog, object, task, direct supply — and the keeper's physical actions
 * live inside it. This spec holds the keeper half: who opens the queue, the
 * two new filters and «Տրված», what a stock line now carries, and
 * «Տրամադրել» per line (PATCH …/lines/:lineId/issue) — the consumable
 * quantity (partial allowed) and the unit picker — through the same service
 * calls the catalog's approve makes, by the same rights.
 */

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const KEEPER = 40; // manage_reservations
const WATCHER = 41; // view_reservations only
const DESK = 42; // view_catalog_requests
const PERMS: Record<number, string[]> = {
  [KEEPER]: ['page_warehouse', 'manage_reservations'],
  [WATCHER]: ['page_warehouse', 'view_reservations'],
  [DESK]: ['page_warehouse', 'view_catalog_requests'],
};
const actor = (userId: number): any => ({
  userId,
  isSuperAdmin: false,
  isGlobalSuperAdmin: false,
  readOnly: false,
  permissionNames: PERMS[userId] ?? [],
  home: { wildcard: false, entityIds: [1] },
  declared: 1,
});

const at = (s: string) => new Date(s);

/** Three requests: a catalog one with a consumable + an asset line, an object one handed out and unconfirmed, a direct supply. */
function world() {
  const subs: any[] = [
    { id: 1, number: 'REQ-1001', createdBy: 7, entityId: 1, objectId: null, taskId: null, projectId: null, purpose: 'Գրասենյակ', neededBy: at('2099-12-01'), createdAt: at('2026-10-08T08:00:00Z'), cancelledAt: null, reminders: [] },
    { id: 2, number: 'REQ-1002', createdBy: 8, entityId: 1, objectId: 600, taskId: null, projectId: 20, purpose: 'Օբյեկտի հայտ', neededBy: at('2099-12-01'), createdAt: at('2026-10-08T09:00:00Z'), cancelledAt: null, reminders: [] },
    { id: 3, number: 'REQ-1003', createdBy: KEEPER, entityId: 1, objectId: 600, taskId: null, projectId: 20, purpose: 'Պահեստից՝ առանց հայտի', neededBy: at('2099-12-01'), createdAt: at('2026-10-08T10:00:00Z'), cancelledAt: null, reminders: [] },
    { id: 4, number: 'REQ-1004', createdBy: 9, entityId: 1, objectId: 600, taskId: 500, projectId: 20, purpose: 'Առաջադրանքի հայտ', neededBy: at('2099-12-01'), createdAt: at('2026-10-08T11:00:00Z'), cancelledAt: null, reminders: [] },
  ];
  const rows: any[] = [
    // REQ-1001: 10 kg of cement asked, 4 handed out so far, none confirmed; one generator unit asked, none out.
    { id: 700, submissionId: 1, itemId: 7, quantity: 10, status: 'PARTIALLY_ALLOCATED', acceptedQuantity: 0, warehouseId: null, warehouse: null, startDate: at('2026-10-08'), endDate: at('2099-12-01'),
      item: { id: 7, name: 'Ցեմենտ', unit: 'KG', code: 'C-7', variantLabel: null, type: 'CONSUMABLE' },
      allocations: [{ id: 90, quantity: 4, assetId: null, asset: null }],
      allocationHistory: [{ performedAt: at('2026-10-08T12:00:00Z'), action: 'ALLOCATED', performedBy: KEEPER, notes: null, asset: null }],
      statusHistory: [{ performedAt: at('2026-10-08T08:00:00Z'), fromStatus: null, toStatus: 'APPROVED', performedBy: 7, reason: 'Կատալոգի հարցում REQ-1001' }, { performedAt: at('2026-10-08T12:00:00Z'), fromStatus: 'APPROVED', toStatus: 'PARTIALLY_ALLOCATED', performedBy: KEEPER, reason: null }] },
    { id: 701, submissionId: 1, itemId: 9, quantity: 2, status: 'APPROVED', acceptedQuantity: 0, warehouseId: null, warehouse: null, startDate: at('2026-10-08'), endDate: at('2099-12-01'),
      item: { id: 9, name: 'Գեներատոր', unit: 'PIECE', code: 'G-9', variantLabel: null, type: 'ASSET' }, allocations: [], allocationHistory: [], statusHistory: [] },
    // REQ-1002: object row, 5 handed out, 2 confirmed → 3 reclaimable; a requisition was raised for it.
    { id: 702, submissionId: 2, itemId: 7, quantity: 5, status: 'ALLOCATED', acceptedQuantity: 2, warehouseId: 3, warehouse: { id: 3, name: 'Արաբկիր' }, startDate: at('2026-10-08'), endDate: at('2099-12-01'),
      item: { id: 7, name: 'Ցեմենտ', unit: 'KG', code: 'C-7', variantLabel: null, type: 'CONSUMABLE' }, allocations: [{ id: 91, quantity: 5, assetId: null, asset: null }], allocationHistory: [], statusHistory: [] },
    // REQ-1003: direct supply, fully confirmed.
    { id: 703, submissionId: 3, itemId: 7, quantity: 1, status: 'COMPLETED', acceptedQuantity: 1, warehouseId: null, warehouse: null, startDate: at('2026-10-08'), endDate: at('2099-12-01'),
      item: { id: 7, name: 'Ցեմենտ', unit: 'KG', code: 'C-7', variantLabel: null, type: 'CONSUMABLE' }, allocations: [{ id: 92, quantity: 1, assetId: null, asset: null }], allocationHistory: [],
      statusHistory: [{ performedAt: at('2026-10-08T10:00:00Z'), fromStatus: null, toStatus: 'APPROVED', performedBy: KEEPER, reason: 'Պահեստը տրամադրում է օբյեկտին' }] },
    // REQ-1004: task row, waiting.
    { id: 704, submissionId: 4, itemId: 7, quantity: 2, status: 'PENDING', acceptedQuantity: 0, warehouseId: null, warehouse: null, startDate: at('2026-10-08'), endDate: at('2099-12-01'),
      item: { id: 7, name: 'Ցեմենտ', unit: 'KG', code: 'C-7', variantLabel: null, type: 'CONSUMABLE' }, allocations: [], allocationHistory: [], statusHistory: [] },
  ];
  const prisma: any = {
    catalogSubmission: {
      findMany: jest.fn(async ({ where }: any) => subs.filter((s) => (where?.id != null ? s.id === where.id : true))),
      findUnique: jest.fn(async ({ where }: any) => subs.find((s) => s.id === where.id) ?? null),
    },
    // The submissions' rows by submissionId; the pool's other live claims (poolFree) — none here.
    resourceReservation: { findMany: jest.fn(async ({ where }: any) => (where?.submissionId ? rows.filter((r) => where.submissionId.in.includes(r.submissionId)) : [])) },
    purchaseRequisition: { findMany: jest.fn(async () => []) },
    warehouseStock: { findMany: jest.fn(async () => [{ warehouseId: 3, itemId: 7, quantity: 20 }]) },
    asset: { groupBy: jest.fn(async () => []) },
  };
  const users: any = {
    getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id, firstName: 'Ա', lastName: `${id}` }))),
    getUserAccessInfo: jest.fn(async (userId: number) => ({ isSuperAdmin: false, permissionNames: PERMS[userId] ?? [] })),
  };
  const reservations: any = {
    approveConsumable: jest.fn(async () => undefined),
    allocate: jest.fn(async () => undefined),
    requisitionsFor: jest.fn(async () => new Map([[702, { id: 300, lineId: 1, status: 'PENDING_APPROVAL' }]])),
    taskCard: jest.fn(async (id: number) => ({ id, title: 'Հիմքի բետոնացում', projectId: 20, objectId: 600, createdById: 9, people: [] })),
  };
  const assets: any = {
    getAvailableAssets: jest.fn(async () => [{ id: 11, itemId: 9, status: 'AVAILABLE', serialNumber: 'GEN-1', warehouseId: null }, { id: 12, itemId: 9, status: 'AVAILABLE', serialNumber: 'GEN-2', warehouseId: null }]),
  };
  const notifications = { send: jest.fn(async (_n: any) => undefined), audience: jest.fn(async () => []) };
  const svc = new CatalogService(prisma, users, reservations, {} as any, {} as any, {} as any, notifications as any, assets, undefined);
  (svc as any).directory = jest.fn(async () => ({ unitOf: new Map(), entityName: new Map() }));
  // Main pool: 7 → 6 kg free raw (own claims added back per line), 9 → 1 unit raw.
  (svc as any).freeStock = jest.fn(async () => new Map([[7, 6], [9, 1]]));
  const controller = new CatalogController(svc);
  return { svc, controller, prisma, reservations, assets, notifications };
}

describe('who opens the queue', () => {
  it('GET /catalog/submissions is guarded by the desk right OR the keepers’ reservation rights (alert holders included)', () => {
    expect(QUEUE_VIEWER_PERMISSIONS).toEqual(['view_catalog_requests', 'view_reservations', 'manage_reservations', 'receive_reservation_alerts']);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, CatalogController.prototype.queue)).toEqual(QUEUE_VIEWER_PERMISSIONS);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, CatalogController.prototype.issue)).toEqual(['manage_reservations']);
  });

  it('a keeper and a watcher read any request; a watcher may not hand out (403) nor remind (desk only, 403)', async () => {
    const w = world();
    await expect(w.svc.getOne(1, actor(KEEPER))).resolves.toMatchObject({ number: 'REQ-1001' });
    await expect(w.svc.getOne(1, actor(WATCHER))).resolves.toMatchObject({ number: 'REQ-1001' });
    await expect(w.svc.issueLine(1, 'r700', { quantity: 1 }, WATCHER, actor(WATCHER))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.remind(1, actor(WATCHER))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.remind(1, actor(KEEPER))).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.reservations.approveConsumable).not.toHaveBeenCalled();
  });
});

describe('what a stock line carries for the keeper', () => {
  it('pool, free-for-this-line, outstanding, reclaimable, live allocations, the two histories, the requisition; purchase lines the empty shape', async () => {
    const w = world();
    const view = await w.svc.getOne(1, actor(KEEPER));
    const cement = view.lines.find((l) => l.id === 'r700')!;
    expect(cement).toMatchObject({ warehouse: null, outstandingQuantity: 6, reclaimableQuantity: 4, issuedQuantity: 4, requisition: null });
    // PARTIALLY_ALLOCATED is not a live claim in freeStock's count: the raw figure stands.
    expect(cement.freeQuantity).toBe(6);
    expect(cement.allocations).toEqual([{ id: 90, assetId: null, serialNumber: null, quantity: 4 }]);
    expect(cement.allocationHistory).toEqual([{ at: '2026-10-08T12:00:00.000Z', action: 'ALLOCATED', by: { id: KEEPER, name: `Ա ${KEEPER}` }, serialNumber: null, notes: null }]);
    expect(cement.statusHistory.map((h) => [h.from, h.to])).toEqual([[null, 'APPROVED'], ['APPROVED', 'PARTIALLY_ALLOCATED']]);
    const gen = view.lines.find((l) => l.id === 'r701')!;
    // APPROVED asset row: its own claim (2) is added back to the raw 1.
    expect(gen).toMatchObject({ isAsset: true, freeQuantity: 3, outstandingQuantity: 2, reclaimableQuantity: 0 });
    const object = await w.svc.getOne(2, actor(KEEPER));
    const line = object.lines[0];
    expect(line.warehouse).toEqual({ id: 3, name: 'Արաբկիր' });
    // The sub-warehouse pool: 20 on that shelf, no other live claim (ALLOCATED is not one) → 20.
    expect(line.freeQuantity).toBe(20);
    expect(line).toMatchObject({ reclaimableQuantity: 3, outstandingQuantity: 0, requisition: { id: 300, status: 'PENDING_APPROVAL' } });
  });

  it('source: catalog / object / direct / task — and «Տրված» (status=ISSUED) is "handed out, not yet confirmed"', async () => {
    const w = world();
    const all = await w.svc.queue({}, actor(KEEPER));
    expect(Object.fromEntries(all.items.map((v) => [v.number, v.source]))).toEqual({ 'REQ-1001': 'CATALOG', 'REQ-1002': 'OBJECT', 'REQ-1003': 'DIRECT', 'REQ-1004': 'TASK' });
    const issued = await w.svc.queue({ status: 'ISSUED' }, actor(KEEPER));
    expect(issued.items.map((v) => v.number).sort()).toEqual(['REQ-1001', 'REQ-1002']);
    for (const [source, expected] of [['OBJECT', ['REQ-1002']], ['TASK', ['REQ-1004']], ['DIRECT', ['REQ-1003']], ['CATALOG', ['REQ-1001']]] as const) {
      const r = await w.svc.queue({ source }, actor(KEEPER));
      expect(r.items.map((v) => v.number)).toEqual(expected);
    }
  });

  it('the warehouse filter: main = requests with a row drawn from the main pool, a sub = rows drawn from it', async () => {
    const w = world();
    await w.svc.queue({ warehouseId: 'main' }, actor(KEEPER));
    expect(w.prisma.catalogSubmission.findMany.mock.calls.at(-1)[0].where).toEqual({ reservations: { some: { warehouseId: null } } });
    await w.svc.queue({ warehouseId: '3' }, actor(KEEPER));
    expect(w.prisma.catalogSubmission.findMany.mock.calls.at(-1)[0].where).toEqual({ reservations: { some: { warehouseId: 3 } } });
    await w.svc.queue({}, actor(KEEPER));
    expect(w.prisma.catalogSubmission.findMany.mock.calls.at(-1)[0].where).toEqual({});
  });
});

describe('«Տրամադրել» per line from the queue', () => {
  it('a consumable: the asked quantity goes out through approveConsumable, quiet; the submitter is told once', async () => {
    const w = world();
    const view = await w.controller.issue(1, 'r700', { quantity: 2.5 }, KEEPER, actor(KEEPER));
    expect(w.reservations.approveConsumable).toHaveBeenCalledWith(700, KEEPER, 2.5, expect.objectContaining({ userId: KEEPER }), { quiet: true });
    expect(view.number).toBe('REQ-1001');
    await new Promise((r) => setImmediate(r));
    expect(w.notifications.send).toHaveBeenCalledTimes(1);
    expect(w.notifications.send.mock.calls[0][0]).toMatchObject({ userIds: [7], path: '/goods-requests?tab=mine&id=1' });
  });

  it('no quantity = everything outstanding; more than outstanding, zero, or a line already handed out in full → 400, nothing moves', async () => {
    const w = world();
    await w.svc.issueLine(1, 'r700', {}, KEEPER, actor(KEEPER));
    expect(w.reservations.approveConsumable).toHaveBeenLastCalledWith(700, KEEPER, 6, expect.anything(), { quiet: true });
    w.reservations.approveConsumable.mockClear();
    await expect(w.svc.issueLine(1, 'r700', { quantity: 7 }, KEEPER, actor(KEEPER))).rejects.toThrow('գերազանցում է չտրամադրված մնացորդը');
    await expect(w.svc.issueLine(1, 'r700', { quantity: 0 }, KEEPER, actor(KEEPER))).rejects.toBeInstanceOf(BadRequestException);
    await expect(w.svc.issueLine(2, 'r702', { quantity: 1 }, KEEPER, actor(KEEPER))).rejects.toThrow('կարգավիճակում է');
    await expect(w.svc.issueLine(3, 'r703', { quantity: 1 }, KEEPER, actor(KEEPER))).rejects.toBeInstanceOf(BadRequestException);
    await expect(w.svc.issueLine(1, 'l5', { quantity: 1 }, KEEPER, actor(KEEPER))).rejects.toMatchObject({ status: 404 });
    expect(w.reservations.approveConsumable).not.toHaveBeenCalled();
  });

  it('an asset line: the picked units go out through allocate (fewer than asked is fine); a unit that is not free, a duplicate, too many, or none → 400', async () => {
    const w = world();
    await w.svc.issueLine(1, 'r701', { assetIds: [11] }, KEEPER, actor(KEEPER));
    expect(w.reservations.allocate).toHaveBeenCalledWith({ allocations: [{ reservationId: 701, assetId: 11 }] }, KEEPER, { quiet: true });
    expect(w.assets.getAvailableAssets).toHaveBeenCalledWith(expect.objectContaining({ itemId: 9, reservationId: 701 }));
    w.reservations.allocate.mockClear();
    await expect(w.svc.issueLine(1, 'r701', { assetIds: [13] }, KEEPER, actor(KEEPER))).rejects.toThrow('ազատ չէ');
    await expect(w.svc.issueLine(1, 'r701', { assetIds: [11, 11] }, KEEPER, actor(KEEPER))).rejects.toThrow('երկու անգամ');
    await expect(w.svc.issueLine(1, 'r701', { assetIds: [11, 12, 13] }, KEEPER, actor(KEEPER))).rejects.toThrow('առավելագույնը 2');
    await expect(w.svc.issueLine(1, 'r701', {} as any, KEEPER, actor(KEEPER))).rejects.toThrow('ընտրեք տրվող միավորները');
    expect(w.reservations.allocate).not.toHaveBeenCalled();
  });
});
