import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { WarehouseActor } from '../auth/actor';
import { AvailabilityService } from '../availability/availability.service';
import { quantitiesOf } from './quantities';
import { ReservationsService } from './reservations.service';

/**
 * PRE-P4 A4 — A SHORT REQUEST IS MADE, AND WAITS FOR THE WAREHOUSE.
 *
 * The state machine was always this: create() asks the availability check
 * (pool-aware since #1989) and makes a row APPROVED when the stock is there
 * and PENDING when it is not, alerting the people who decide. The race guard
 * inside the transaction then undid it for consumables — it read the MAIN Item
 * quantity whatever the pool, counted every pool's claims, and REFUSED a short
 * request outright. PENDING was unreachable, and a project request was judged
 * against the main shelf.
 *
 * These run the real AvailabilityService and the real create() against one
 * in-memory store, so both measurements — before and inside the transaction —
 * see the same rows.
 */

type Pool = 'MAIN' | 'PROJECT';
const PROJECT_WAREHOUSE = 3;
const START = '2026-10-01T09:00:00.000Z';
const END = '2026-10-10T18:00:00.000Z';

const actor = (over: Partial<WarehouseActor> = {}): WarehouseActor => ({
  userId: 39,
  isSuperAdmin: false,
  isGlobalSuperAdmin: false,
  permissionNames: [],
  home: { wildcard: false, entityIds: [3] },
  declared: null,
  ...over,
});

function world(opts: {
  pool: Pool;
  main: number;
  project?: number | null;
  type?: 'CONSUMABLE' | 'ASSET';
  /** existing claims: [pool, quantity, status] */
  claims?: [Pool, number, string][];
  assets?: { warehouseId: number | null }[];
  requester?: number | null;
}) {
  const state = {
    item: { id: 7, name: 'Cement', type: opts.type ?? 'CONSUMABLE', unit: 'KG', quantity: opts.main, category: { entityId: 1 } },
    stock: opts.project === undefined || opts.project === null ? null : { warehouseId: PROJECT_WAREHOUSE, itemId: 7, quantity: opts.project },
    reservations: [] as any[],
    history: [] as any[],
  };
  let nextId = 500;
  for (const [pool, quantity, status] of opts.claims ?? []) {
    state.reservations.push({
      id: nextId++, itemId: 7, quantity, status, taskId: 900,
      warehouseId: pool === 'PROJECT' ? PROJECT_WAREHOUSE : null,
      startDate: new Date(START), endDate: new Date(END),
    });
  }
  const assets = opts.assets ?? [];
  const stockWrites: string[] = [];

  const matchStatus = (row: any, status: any) =>
    !status ||
    (status.in ? status.in.includes(row.status) : true) && (status.notIn ? !status.notIn.includes(row.status) : true);
  const matchPool = (row: any, where: any) => !('warehouseId' in where) || row.warehouseId === where.warehouseId;
  const rows = (where: any) =>
    state.reservations.filter(
      (r) =>
        r.itemId === where.itemId &&
        matchPool(r, where) &&
        matchStatus(r, where.status) &&
        (!where.taskId?.not || r.taskId !== where.taskId.not),
    );
  const refuse = (what: string) => async () => {
    stockWrites.push(what);
    throw new Error(`creation must not write stock: ${what}`);
  };

  const db: any = {
    item: {
      findMany: async () => [{ id: 7, unit: state.item.unit, type: state.item.type }],
      findUnique: async () => ({ ...state.item }),
      update: refuse('item.update'),
      updateMany: refuse('item.updateMany'),
    },
    warehouseStock: {
      findUnique: async ({ where }: any) =>
        state.stock && where.warehouseId_itemId.warehouseId === state.stock.warehouseId ? { ...state.stock } : null,
      update: refuse('warehouseStock.update'),
      updateMany: refuse('warehouseStock.updateMany'),
      upsert: refuse('warehouseStock.upsert'),
    },
    resourceReservation: {
      aggregate: async ({ where }: any) => ({ _sum: { quantity: rows(where).reduce((s, r) => s + r.quantity, 0) || null } }),
      count: async () => 0,
      create: async ({ data }: any) => {
        const row = { id: nextId++, ...data };
        state.reservations.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => state.reservations.find((r) => r.id === where.id) ?? null,
    },
    reservationAllocation: { aggregate: async () => ({ _sum: { quantity: null } }) },
    resourceReturn: { aggregate: async () => ({ _sum: { quantity: null } }) },
    asset: {
      count: async ({ where }: any) =>
        where.maintenanceRecords
          ? 0
          : assets.filter((a) => !('warehouseId' in where) || a.warehouseId === where.warehouseId).length,
    },
    reservationStatusHistory: { create: async ({ data }: any) => state.history.push(data) },
    inventoryMovement: { create: refuse('inventoryMovement.create') },
    $queryRawUnsafe: async () => [{ id: 7 }],
    $executeRaw: refuse('$executeRaw'),
  };
  db.$transaction = async (fn: (tx: any) => Promise<unknown>) => {
    const snapshot = state.reservations.length;
    try {
      return await fn(db);
    } catch (error) {
      state.reservations.length = snapshot;
      throw error;
    }
  };

  const alerts: any[] = [];
  const svc = new ReservationsService(
    db,
    new AvailabilityService(db),
    { check: async () => {} } as any,
    { send: async (n: any) => alerts.push(n) } as any,
    {} as any,
    {} as any,
    { forRequest: async () => (opts.requester === undefined ? 3 : opts.requester) } as any,
  );
  // Which pool a task draws from is the existing binding (#1989), not A4.
  (svc as any).resolveTaskWarehouse = async () => ({
    warehouseId: opts.pool === 'PROJECT' ? PROJECT_WAREHOUSE : null,
    objectId: null,
  });

  const create = (quantity: number, who: WarehouseActor = actor()) =>
    svc.create(
      { taskId: 100, projectId: 20, startDate: START, endDate: END, resources: [{ itemId: 7, quantity }] } as any,
      39,
      who,
    );
  const stockNow = () => ({ main: state.item.quantity, project: state.stock?.quantity ?? null });
  return { svc, db, state, create, alerts, stockWrites, stockNow };
}

describe('MAIN — stock comes from Item', () => {
  it('A. enough: created APPROVED, no alert, as before', async () => {
    const w = world({ pool: 'MAIN', main: 10 });
    const out = await w.create(5);
    expect(out.created).toHaveLength(1);
    expect(out.created[0].status).toBe('APPROVED');
    expect(out.available).toBe(true);
    expect(w.alerts).toEqual([]);
    expect(w.state.reservations[0]).toMatchObject({ quantity: 5, warehouseId: null, status: 'APPROVED' });
  });

  it('B. short: not refused — created PENDING for a decision, alert sent, stock untouched', async () => {
    const w = world({ pool: 'MAIN', main: 4 });
    const out = await w.create(10);
    expect(out.created[0].status).toBe('PENDING');
    expect(out.available).toBe(false);
    expect(w.state.history[0]).toMatchObject({ toStatus: 'PENDING' });
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].permissions).toEqual(['receive_reservation_alerts', 'manage_warehouse']);
    expect(w.stockNow()).toEqual({ main: 4, project: null });
    expect(w.stockWrites).toEqual([]);
  });

  it('G. a plentiful PROJECT shelf never covers a MAIN request', async () => {
    const w = world({ pool: 'MAIN', main: 2, project: 1000 });
    const out = await w.create(5);
    expect(out.created[0].status).toBe('PENDING');
    expect(w.state.reservations[0].warehouseId).toBeNull();
    expect(w.stockNow()).toEqual({ main: 2, project: 1000 });
  });

  it('claims on the PROJECT shelf do not use up MAIN', async () => {
    const w = world({ pool: 'MAIN', main: 10, project: 10, claims: [['PROJECT', 9, 'APPROVED']] });
    expect((await w.create(8)).created[0].status).toBe('APPROVED');
  });

  it('claims on MAIN do: 10 on the shelf, 7 promised, 5 asked → PENDING', async () => {
    const w = world({ pool: 'MAIN', main: 10, claims: [['MAIN', 7, 'APPROVED']] });
    expect((await w.create(5)).created[0].status).toBe('PENDING');
  });
});

describe('PROJECT — stock comes from WarehouseStock only', () => {
  it('C/F. enough on the project shelf with MAIN at zero: created APPROVED', async () => {
    const w = world({ pool: 'PROJECT', main: 0, project: 10 });
    const out = await w.create(5);
    expect(out.created[0].status).toBe('APPROVED');
    expect(w.state.reservations[0].warehouseId).toBe(PROJECT_WAREHOUSE);
    expect(w.stockNow()).toEqual({ main: 0, project: 10 });
  });

  it('D. short on the project shelf with MAIN at 100: no fallback — PENDING, MAIN untouched', async () => {
    const w = world({ pool: 'PROJECT', main: 100, project: 4 });
    const out = await w.create(10);
    expect(out.created[0].status).toBe('PENDING');
    expect(w.stockNow()).toEqual({ main: 100, project: 4 });
    expect(w.stockWrites).toEqual([]);
  });

  it('E. project shelf at zero (or no row) with MAIN at 100: project-short, never available', async () => {
    for (const project of [0, null]) {
      const w = world({ pool: 'PROJECT', main: 100, project });
      const out = await w.create(1);
      expect(out.created[0].status).toBe('PENDING');
      expect(out.available).toBe(false);
    }
  });

  it('claims on MAIN do not use up the project shelf', async () => {
    const w = world({ pool: 'PROJECT', main: 10, project: 10, claims: [['MAIN', 10, 'APPROVED']] });
    expect((await w.create(10)).created[0].status).toBe('APPROVED');
  });
});

describe('H. fractional amounts follow roundQty on both measurements', () => {
  it.each<Pool>(['MAIN', 'PROJECT'])('%s: 0.3 asked, 0.2 available → PENDING', async (pool) => {
    const w = world({ pool, main: pool === 'MAIN' ? 0.2 : 100, project: pool === 'PROJECT' ? 0.2 : 100 });
    expect((await w.create(0.3)).created[0].status).toBe('PENDING');
  });

  it.each<Pool>(['MAIN', 'PROJECT'])('%s: 0.3 asked, exactly 0.3 available → APPROVED', async (pool) => {
    const w = world({ pool, main: pool === 'MAIN' ? 0.3 : 0, project: pool === 'PROJECT' ? 0.3 : 0 });
    expect((await w.create(0.3)).created[0].status).toBe('APPROVED');
  });

  it.each<Pool>(['MAIN', 'PROJECT'])('%s: 0.5 on the shelf, 0.2 promised, 0.3 asked (float residue) → APPROVED', async (pool) => {
    const w = world({
      pool,
      main: pool === 'MAIN' ? 0.5 : 0,
      project: pool === 'PROJECT' ? 0.5 : 0,
      claims: [[pool, 0.1, 'APPROVED'], [pool, 0.1, 'PENDING']],
    });
    expect((await w.create(0.3)).created[0].status).toBe('APPROVED');
  });
});

describe('I. creating never moves stock', () => {
  it.each<[Pool, number]>([
    ['MAIN', 5],
    ['MAIN', 50],
    ['PROJECT', 5],
    ['PROJECT', 50],
  ])('%s, %p asked', async (pool, quantity) => {
    const w = world({ pool, main: 10, project: 10 });
    await w.create(quantity);
    expect(w.stockNow()).toEqual({ main: 10, project: 10 });
    expect(w.stockWrites).toEqual([]);
  });
});

describe('the race the in-transaction measure closes still decides, now by status', () => {
  it('another request takes the stock between the two measures: this one becomes PENDING, not a refusal and not APPROVED', async () => {
    const w = world({ pool: 'PROJECT', main: 100, project: 5 });
    const realTx = w.db.$transaction;
    w.db.$transaction = async (fn: any) => {
      // Committed by somebody else after the availability check said "free".
      w.state.reservations.push({
        id: 999, itemId: 7, quantity: 5, status: 'APPROVED', taskId: 901,
        warehouseId: PROJECT_WAREHOUSE, startDate: new Date(START), endDate: new Date(END),
      });
      return realTx(fn);
    };
    const out = await w.create(5);
    expect(out.created[0].status).toBe('PENDING');
    expect(out.available).toBe(false);
    expect(w.alerts).toHaveLength(1);
  });
});

describe('J. who may ask is decided exactly as before', () => {
  it('a request with no authoritative requester is refused, nothing created', async () => {
    const w = world({ pool: 'MAIN', main: 100, requester: null });
    await expect(w.create(1)).rejects.toBeInstanceOf(BadRequestException);
    expect(w.state.reservations).toEqual([]);
  });

  it('another company’s work is refused, even when short — nothing created, no alert', async () => {
    const w = world({ pool: 'MAIN', main: 0 });
    const outsider = actor({ userId: 50, home: { wildcard: false, entityIds: [4] } });
    await expect(w.create(1, outsider)).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.state.reservations).toEqual([]);
    expect(w.alerts).toEqual([]);
  });
});

describe('assets keep their contract', () => {
  it('an asset request beyond the units that exist is still refused, as before', async () => {
    const w = world({ pool: 'MAIN', main: 0, type: 'ASSET', assets: [{ warehouseId: null }] });
    await expect(w.create(2)).rejects.toBeInstanceOf(BadRequestException);
    expect(w.state.reservations).toEqual([]);
  });

  it('an asset request within the units is created as before', async () => {
    const w = world({ pool: 'MAIN', main: 0, type: 'ASSET', assets: [{ warehouseId: null }, { warehouseId: null }] });
    expect((await w.create(2)).created[0].status).toBe('APPROVED');
  });
});

describe('a short creation grants nothing at issue time', () => {
  it('a PENDING short request still cannot be issued beyond the shelf, and the measure is unchanged', async () => {
    const w = world({ pool: 'PROJECT', main: 100, project: 4 });
    const out = await w.create(10);
    const id = out.created[0].id;
    const q = await quantitiesOf(w.db, id);
    expect(q).toMatchObject({ requested: 10, issued: 0, outstandingToIssue: 10 });
  });
});
