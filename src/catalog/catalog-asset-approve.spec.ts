import { BadRequestException, Logger } from '@nestjs/common';

import { CatalogService } from './catalog.service';
import { UNDECIDED_IN_STOCK, UNDECIDED_SHORT, availableForLine, ownClaim, stockLineLabel } from './catalog.rules';

/**
 * REQ-1015 (2026-10-07): approving an asset line on the catalog request page
 * used to be a silent no-op — checkout already writes an in-stock asset line
 * APPROVED, the approval only moved PENDING → APPROVED, and the requester was
 * told "approved" while the line stayed undecided. Now the approver picks the
 * free units and they are handed out through the Reservations page's own
 * allocation; nothing moved means no success and no notice.
 */

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

const START = new Date('2026-10-07T00:00:00.000Z');

function asset(overrides: Partial<any> = {}) {
  return {
    id: 11, submissionId: 4, itemId: 7, quantity: 1, status: 'APPROVED', startDate: START, endDate: null, warehouseId: null,
    item: { id: 7, name: 'MacBook Pro', unit: 'հատ', code: null, variantLabel: null, type: 'ASSET' },
    allocations: [], statusHistory: [], ...overrides,
  };
}
function consumable(overrides: Partial<any> = {}) {
  return {
    id: 12, submissionId: 4, itemId: 8, quantity: 5, status: 'APPROVED', startDate: START, endDate: null, warehouseId: null,
    item: { id: 8, name: 'A4 թուղթ', unit: 'տուփ', code: null, variantLabel: null, type: 'CONSUMABLE' },
    allocations: [], statusHistory: [], ...overrides,
  };
}

/** Free units of item 7 as GET /assets/available lists them. */
const FREE_UNITS = [
  { id: 101, itemId: 7, serialNumber: 'MBP-001', status: 'AVAILABLE', warehouseId: null, notes: null, responsibleName: 'Արամ Պետրոսյան' },
  { id: 102, itemId: 7, serialNumber: 'MBP-002', status: 'AVAILABLE', warehouseId: null, notes: 'քերծվածք', responsibleName: 'Արամ Պետրոսյան' },
  { id: 103, itemId: 7, serialNumber: 'MBP-003', status: 'IN_MAINTENANCE', warehouseId: null, notes: null, responsibleName: null },
];

function world(reservations: any[] = [asset(), consumable()], units: any[] = FREE_UNITS) {
  const sub = { id: 4, number: 'REQ-1015', createdBy: 10, entityId: 2, purpose: 'p', neededBy: START, createdAt: START, cancelledAt: null, infoRequestAt: null, reminders: [] };
  const prisma: any = {
    catalogSubmission: { findMany: jest.fn(async () => [{ ...sub }]), update: jest.fn() },
    resourceReservation: { findMany: jest.fn(async () => reservations), update: jest.fn(async () => ({})) },
    purchaseRequisition: { findMany: jest.fn(async () => []) },
    reservationStatusHistory: { create: jest.fn(async () => ({})) },
    warehouse: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (x: any) => x),
  };
  const users: any = {
    getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id, firstName: 'Ա', lastName: 'Բ' }))),
    getUserAccessInfo: jest.fn(async () => ({ isSuperAdmin: false, permissionNames: [] })),
  };
  const reservationsSvc: any = {
    allocate: jest.fn(async () => ({ success: true })),
    reject: jest.fn(async () => ({})),
    approveConsumable: jest.fn(async () => ({})),
  };
  const sent: any[] = [];
  const n: any = { send: jest.fn(async (x: any) => void sent.push(x)), audience: jest.fn(async () => []) };
  const assets: any = {
    getAvailableAssets: jest.fn(async (q: any) => units.filter((u) => u.itemId === q.itemId)),
  };
  const svc = new CatalogService(prisma, users, reservationsSvc, {} as any, {} as any, {} as any, n, assets);
  (svc as any).directory = jest.fn(async () => ({ unitOf: new Map(), entityName: new Map() }));
  (svc as any).freeStock = jest.fn(async () => new Map([[7, 0], [8, 0]]));
  return { svc, prisma, reservationsSvc, assets, sent };
}

const DESK = { userId: 30, isSuperAdmin: false, permissionNames: ['manage_reservations', 'view_catalog_requests'] } as any;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PATCH /catalog/submissions/:id/approve — asset lines (REQ-1015)', () => {
  it('approving an asset line hands out exactly the picked unit through the Reservations allocation', async () => {
    const w = world();
    await w.svc.approve(4, { lines: [{ id: 'r11', approvedQuantity: 1, assetIds: [102] }] }, 30, DESK);
    expect(w.reservationsSvc.allocate).toHaveBeenCalledWith({ allocations: [{ reservationId: 11, assetId: 102 }] }, 30, { quiet: true });
    // The list is the Reservations page's own, in the line's window and pool context.
    expect(w.assets.getAvailableAssets).toHaveBeenCalledWith(expect.objectContaining({ itemId: 7, reservationId: 11 }));
    await flush();
    expect(w.sent).toHaveLength(1);
  });

  it('a full approve of two units allocates both picks', async () => {
    const w = world([asset({ quantity: 2 })]);
    await w.svc.approve(4, { lines: [{ id: 'r11', approvedQuantity: 2, assetIds: [101, 102] }] }, 30, DESK);
    expect(w.reservationsSvc.allocate).toHaveBeenCalledWith(
      { allocations: [{ reservationId: 11, assetId: 101 }, { reservationId: 11, assetId: 102 }] }, 30, { quiet: true },
    );
  });

  it('refuses a unit that is not free (in maintenance) — nothing moves, nobody is told', async () => {
    const w = world();
    await expect(
      w.svc.approve(4, { lines: [{ id: 'r12', approvedQuantity: 0 }, { id: 'r11', approvedQuantity: 1, assetIds: [103] }] }, 30, DESK),
    ).rejects.toThrow(/#103-ը ազատ չէ/);
    expect(w.reservationsSvc.allocate).not.toHaveBeenCalled();
    expect(w.reservationsSvc.reject).not.toHaveBeenCalled();
    await flush();
    expect(w.sent).toHaveLength(0);
  });

  it('refuses a unit of another item', async () => {
    const w = world([asset()], [...FREE_UNITS, { id: 201, itemId: 9, serialNumber: 'DELL-1', status: 'AVAILABLE', warehouseId: null }]);
    await expect(w.svc.approve(4, { lines: [{ id: 'r11', approvedQuantity: 1, assetIds: [201] }] }, 30, DESK)).rejects.toThrow(BadRequestException);
    expect(w.reservationsSvc.allocate).not.toHaveBeenCalled();
  });

  it('an asset approve without picks is refused, not a silent success with an "approved" notice', async () => {
    const w = world([asset()]);
    await expect(w.svc.approve(4, { lines: [{ id: 'r11', approvedQuantity: 1 }] }, 30, DESK)).rejects.toThrow(/ընտրեք 1 միավոր/);
    await flush();
    expect(w.sent).toHaveLength(0);
    expect(w.prisma.resourceReservation.update).not.toHaveBeenCalled();
  });

  it('no free unit: «Ազատ միավոր չկա», nothing changes', async () => {
    const w = world([asset()], []);
    await expect(w.svc.approve(4, { lines: [{ id: 'r11', approvedQuantity: 1, assetIds: [101] }] }, 30, DESK)).rejects.toThrow(/Ազատ միավոր չկա/);
    await flush();
    expect(w.sent).toHaveLength(0);
  });

  it('the same unit picked twice is refused', async () => {
    const w = world([asset({ quantity: 2 })]);
    await expect(w.svc.approve(4, { lines: [{ id: 'r11', approvedQuantity: 2, assetIds: [101, 101] }] }, 30, DESK)).rejects.toThrow(/երկու անգամ/);
  });

  it('REQ-1015 shape: consumable 0 + the MacBook unit → consumable rejected, unit handed out', async () => {
    const w = world();
    await w.svc.approve(4, { lines: [{ id: 'r12', approvedQuantity: 0 }, { id: 'r11', approvedQuantity: 1, assetIds: [101] }] }, 30, DESK);
    expect(w.reservationsSvc.reject).toHaveBeenCalledWith(12, 30, expect.any(String), DESK, { quiet: true });
    expect(w.reservationsSvc.allocate).toHaveBeenCalledWith({ allocations: [{ reservationId: 11, assetId: 101 }] }, 30, { quiet: true });
    expect(w.reservationsSvc.approveConsumable).not.toHaveBeenCalled();
  });

  it('a partial asset approve lowers the line to the picked count before allocating', async () => {
    const w = world([asset({ quantity: 2 })]);
    await w.svc.approve(4, { lines: [{ id: 'r11', approvedQuantity: 1, assetIds: [101] }] }, 30, DESK);
    expect(w.prisma.resourceReservation.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { quantity: 1 } });
    expect(w.reservationsSvc.allocate).toHaveBeenCalledWith({ allocations: [{ reservationId: 11, assetId: 101 }] }, 30, { quiet: true });
  });

  it('lines left out of the call are left alone (the dialog sends only what changed)', async () => {
    const w = world();
    await w.svc.approve(4, { lines: [{ id: 'r12', approvedQuantity: 0 }] }, 30, DESK);
    expect(w.reservationsSvc.reject).toHaveBeenCalledTimes(1);
    expect(w.reservationsSvc.allocate).not.toHaveBeenCalled();
    expect(w.reservationsSvc.approveConsumable).not.toHaveBeenCalled();
  });

  it('GET …/lines/:lineId/units lists the free units only, with the main warehouse named', async () => {
    const w = world();
    const res = await w.svc.unitsForLine(4, 'r11', DESK);
    expect(res.units.map((u: any) => u.id)).toEqual([101, 102]);
    expect(res.units[0]).toMatchObject({ serialNumber: 'MBP-001', warehouseName: 'Գլխավոր պահեստ', responsibleName: 'Արամ Պետրոսյան' });
    await expect(w.svc.unitsForLine(4, 'r12', DESK)).rejects.toThrow(BadRequestException);
  });

  it('units already on the line are not offered again', async () => {
    const w = world([asset({ quantity: 2, status: 'PARTIALLY_ALLOCATED', allocations: [{ quantity: 1, assetId: 101 }] })]);
    const res = await w.svc.unitsForLine(4, 'r11', DESK);
    expect(res.units.map((u: any) => u.id)).toEqual([102]);
    expect(res.issued).toBe(1);
  });
});

describe('the «Հասանելի» column and the undecided label (REQ-1015 fixes 3 and 4)', () => {
  it('ownClaim mirrors the free-stock count', () => {
    expect(ownClaim({ type: 'ASSET', status: 'APPROVED', quantity: 1, warehouseId: null })).toBe(1);
    expect(ownClaim({ type: 'ASSET', status: 'ALLOCATED', quantity: 2, warehouseId: null })).toBe(2);
    expect(ownClaim({ type: 'ASSET', status: 'APPROVED', quantity: 1, warehouseId: 3 })).toBe(0);
    expect(ownClaim({ type: 'CONSUMABLE', status: 'PENDING', quantity: 5, warehouseId: null })).toBe(5);
    expect(ownClaim({ type: 'CONSUMABLE', status: 'PARTIALLY_ALLOCATED', quantity: 5, warehouseId: null })).toBe(0);
    expect(ownClaim({ type: 'CONSUMABLE', status: 'APPROVED', quantity: 5, endDate: new Date('2020-01-01') })).toBe(0);
  });

  it('a line promised its own stock does not read 0', () => {
    // One MacBook on the shelf, claimed by this very line: free = 1 - 1 = 0.
    expect(availableForLine(0, 1)).toBe(1);
    // Oversubscribed: shelf 3, this line 5, another claim 2 → raw free -4, the line sees 1.
    expect(availableForLine(-4, 5)).toBe(1);
    expect(availableForLine(-9, 5)).toBe(0);
  });

  it('undecided lines read «Սպասում է որոշման» with the shelf, decided lines their real state', () => {
    expect(stockLineLabel('PENDING', 1, 1, 'Հասանելի')).toBe(UNDECIDED_IN_STOCK);
    expect(stockLineLabel('PENDING', 1, 2, 'Հասանելի')).toBe(UNDECIDED_SHORT);
    expect(stockLineLabel('READY', 0, 1, 'Հատկացված')).toBe('Հատկացված');
  });

  it('the request page shows the asset line as available to itself, labelled undecided', async () => {
    const w = world();
    const view = await w.svc.getOne(4, DESK);
    const mac = view.lines.find((l) => l.id === 'r11')!;
    expect(mac.inStock).toBe(1);
    expect(mac.isAsset).toBe(true);
    expect(mac.statusLabel).toBe(UNDECIDED_IN_STOCK);
    expect(view.status).toBe('SUBMITTED');
  });

  it('the asset claim count is kept to the main pool, like the consumable one', async () => {
    const w = world();
    const prisma = w.prisma;
    prisma.item = { findMany: jest.fn(async () => [{ id: 7, type: 'ASSET', quantity: 0 }]) };
    prisma.asset = { groupBy: jest.fn(async () => [{ itemId: 7, _count: { id: 1 } }]) };
    prisma.resourceReservation.groupBy = jest.fn(async () => []);
    const real = Object.getPrototypeOf(w.svc).freeStock.bind(w.svc);
    await real([7]);
    const claimQuery = prisma.resourceReservation.groupBy.mock.calls[0][0];
    expect(claimQuery.where.warehouseId).toBeNull();
  });
});
