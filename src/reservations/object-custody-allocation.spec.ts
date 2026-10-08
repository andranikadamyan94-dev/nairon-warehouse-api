import { BadRequestException } from '@nestjs/common';

import { AssetCustodyService } from '../asset-custody/asset-custody.service';
import { ReservationsService } from './reservations.service';

/**
 * Object custody on equipment hand-out (owner 2026-10-08).
 *
 * A unit allocated to a reservation that carries an object (an object's own
 * row, no task) is handed to the OBJECT in the custody register exactly as
 * the old object asset-request hand-over put it there: holderType OBJECT,
 * the object as origin, receipt still unconfirmed (the responsible person
 * confirms), whoever held it released, the asset's responsible mirror
 * cleared. A task's row keeps its rule (the unit must already have a
 * responsible person; custody untouched). Releasing the allocation —
 * cancel, reject, release by hand, reallocate — closes the object's custody
 * row the allocation made, and a replacement unit goes to the object in turn.
 *
 * Direct supplies and the deprecated object request also file a catalog
 * submission now, so the object page reads one list.
 */

const OBJECT = 600;
const KEEPER = 40;
const START = new Date('2026-10-08T08:00:00.000Z');
const END = new Date('2026-10-20T08:00:00.000Z');

function world(opts: { taskId?: number | null; objectId?: number | null; holder?: 'USER' | 'OBJECT' | null } = {}) {
  const reservation: any = {
    id: 50, itemId: 7, quantity: 1, status: 'APPROVED', taskId: opts.taskId ?? null, objectId: opts.objectId ?? null,
    projectName: 'P', startDate: START, endDate: END, warehouseId: null, submissionId: 55,
    item: { id: 7, type: 'ASSET', name: 'Գեներատոր', quantity: 0 },
  };
  const asset: any = { id: 101, itemId: 7, status: 'AVAILABLE', warehouseId: null, responsibleUserId: opts.holder === 'USER' ? 3 : null };
  const custodyRows: any[] = opts.holder ? [{ id: 900, assetId: 101, holderType: opts.holder, holderUserId: opts.holder === 'USER' ? 3 : null, releasedAt: null }] : [];
  const allocations: any[] = [];
  const db: any = {
    resourceReservation: {
      findUnique: jest.fn(async () => ({ ...reservation })),
      update: jest.fn(async ({ data }: any) => Object.assign(reservation, data)),
    },
    asset: { findUnique: jest.fn(async () => ({ ...asset })), update: jest.fn(async ({ data }: any) => Object.assign(asset, data)) },
    assetCustody: {
      findFirst: jest.fn(async ({ where }: any) => custodyRows.find((c) => c.assetId === where.assetId && c.releasedAt === null) ?? null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const c of custodyRows) {
          if (c.assetId !== where.assetId || c.releasedAt !== null) continue;
          if (where.reservationId != null && c.reservationId !== where.reservationId) continue;
          if (where.holderType && c.holderType !== where.holderType) continue;
          Object.assign(c, data);
          count++;
        }
        return { count };
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 901 + custodyRows.length, releasedAt: null, ...data };
        custodyRows.push(row);
        return row;
      }),
    },
    reservationAllocation: {
      count: jest.fn(async () => allocations.filter((a) => !a.releasedAt).length),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => allocations.filter((a) => !a.releasedAt)),
      findUnique: jest.fn(async ({ where }: any) => {
        const a = allocations.find((x) => x.id === where.id);
        return a ? { ...a, reservation: { ...reservation }, asset: { ...asset } } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 700 + allocations.length, releasedAt: null, quantity: null, ...data };
        allocations.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(allocations.find((a) => a.id === where.id), data)),
    },
    reservationAllocationHistory: { create: jest.fn(async () => undefined) },
    reservationStatusHistory: { create: jest.fn(async () => undefined) },
    maintenanceRecord: { findFirst: jest.fn(async () => null) },
    item: { findUnique: jest.fn(async () => reservation.item) },
  };
  db.$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(db);
  const custody = new AssetCustodyService(db, {} as any, {} as any, {} as any);
  const svc = new ReservationsService(db, {} as any, {} as any, { send: async () => undefined } as any, {} as any, {} as any, {} as any, custody);
  (svc as any).assertMay = jest.fn(async () => undefined);
  (svc as any).assertCanCancel = jest.fn(async () => ({ reservation: { ...reservation } }));
  (svc as any).notifyRequesters = jest.fn(async () => undefined);
  return { svc, db, reservation, asset, custodyRows, allocations };
}

describe('allocating a unit to an object’s row', () => {
  it('hands the unit to the object: the person’s custody closes, an OBJECT row opens awaiting receipt, the asset’s responsible mirror clears', async () => {
    const w = world({ objectId: OBJECT, holder: 'USER' });
    await w.svc.allocate({ allocations: [{ reservationId: 50, assetId: 101 }] }, KEEPER, { quiet: true });
    expect(w.allocations).toHaveLength(1);
    const person = w.custodyRows.find((c) => c.holderType === 'USER');
    expect(person.releasedAt).toBeInstanceOf(Date);
    expect(person.releasedBy).toBe(KEEPER);
    const object = w.custodyRows.find((c) => c.holderType === 'OBJECT');
    expect(object).toMatchObject({ assetId: 101, holderObjectId: OBJECT, originObjectId: OBJECT, reservationId: 50, assignedBy: KEEPER, acceptedAt: null, via: 'TASK_ALLOCATION' });
    expect(w.asset.responsibleUserId).toBeNull();
    expect(w.reservation.status).toBe('ALLOCATED');
  });

  it('a unit nobody holds goes to the object too — the object’s row does not demand a responsible person', async () => {
    const w = world({ objectId: OBJECT, holder: null });
    await expect(w.svc.allocate({ allocations: [{ reservationId: 50, assetId: 101 }] }, KEEPER, { quiet: true })).resolves.toEqual({ success: true });
    expect(w.custodyRows).toHaveLength(1);
    expect(w.custodyRows[0]).toMatchObject({ holderType: 'OBJECT', holderObjectId: OBJECT, acceptedAt: null });
  });

  it('a task’s row keeps its rule: the unit must have a responsible person, and custody is left as it is', async () => {
    const refused = world({ taskId: 900, objectId: OBJECT, holder: null });
    await expect(refused.svc.allocate({ allocations: [{ reservationId: 50, assetId: 101 }] }, KEEPER, { quiet: true })).rejects.toBeInstanceOf(BadRequestException);
    const w = world({ taskId: 900, objectId: OBJECT, holder: 'USER' });
    await w.svc.allocate({ allocations: [{ reservationId: 50, assetId: 101 }] }, KEEPER, { quiet: true });
    expect(w.custodyRows).toHaveLength(1);
    expect(w.custodyRows[0]).toMatchObject({ holderType: 'USER', releasedAt: null });
    expect(w.asset.responsibleUserId).toBe(3);
  });
});

describe('releasing the allocation closes the object’s custody row', () => {
  const allocated = async (over: Parameters<typeof world>[0] = {}) => {
    const w = world({ objectId: OBJECT, holder: 'USER', ...over });
    await w.svc.allocate({ allocations: [{ reservationId: 50, assetId: 101 }] }, KEEPER, { quiet: true });
    return w;
  };
  const objectRow = (w: ReturnType<typeof world>) => w.custodyRows.find((c) => c.holderType === 'OBJECT');

  it('cancel', async () => {
    const w = await allocated();
    await w.svc.cancel(50, KEEPER, 'այլևս պետք չէ', undefined, { quiet: true });
    expect(objectRow(w)).toMatchObject({ releasedAt: expect.any(Date), releasedBy: KEEPER, releaseCondition: 'OK' });
  });

  it('reject', async () => {
    const w = await allocated();
    await w.svc.reject(50, KEEPER, 'մերժված', undefined, { quiet: true });
    expect(objectRow(w)).toMatchObject({ releasedAt: expect.any(Date), releasedBy: KEEPER });
  });

  it('release by hand', async () => {
    const w = await allocated();
    await w.svc.releaseAllocation(w.allocations[0].id, KEEPER, 'վերադարձ');
    expect(objectRow(w)).toMatchObject({ releasedAt: expect.any(Date), releasedBy: KEEPER });
  });

  it('reallocate: the first unit’s row closes, the replacement goes to the object', async () => {
    const w = await allocated();
    w.db.asset.findUnique = jest.fn(async ({ where }: any) => ({ id: where.id, itemId: 7, status: 'AVAILABLE', warehouseId: null }));
    await w.svc.reallocate({ allocationId: w.allocations[0].id, newAssetId: 102, reason: 'փոխարինում' } as any, KEEPER);
    const rows = w.custodyRows.filter((c) => c.holderType === 'OBJECT');
    expect(rows).toHaveLength(2);
    expect(rows.find((c) => c.assetId === 101)).toMatchObject({ releasedAt: expect.any(Date) });
    expect(rows.find((c) => c.assetId === 102)).toMatchObject({ holderObjectId: OBJECT, reservationId: 50, releasedAt: null, acceptedAt: null });
  });

  it('a row the allocation did not make (a direct issue to the object) is not touched by a release', async () => {
    const w = await allocated();
    w.custodyRows.push({ id: 950, assetId: 101, holderType: 'OBJECT', holderObjectId: OBJECT, reservationId: null, releasedAt: null });
    await w.svc.cancel(50, KEEPER, undefined, undefined, { quiet: true });
    expect(w.custodyRows.find((c) => c.id === 950).releasedAt).toBeNull();
  });
});

describe('object rows the warehouse makes without a checkout file a catalog submission', () => {
  const CARD = { id: OBJECT, code: 'O-600', name: 'Արաբկիր', projectId: 20, projectName: 'Բնակելի շենք', entityId: 1, responsibleId: 32 };
  function supplyWorld() {
    const subs: any[] = [];
    const rows: any[] = [];
    const db: any = {
      item: { findMany: jest.fn(async () => [{ id: 7, type: 'CONSUMABLE', name: 'Ցեմենտ' }]) },
      $queryRaw: jest.fn(async () => [{ nextval: 1077 }]),
      catalogSubmission: { create: jest.fn(async ({ data }: any) => { const s = { id: 300 + subs.length, ...data }; subs.push(s); return { id: s.id, number: s.number }; }) },
      resourceReservation: { create: jest.fn(async ({ data }: any) => { const r = { id: 700 + rows.length, ...data }; rows.push(r); return r; }) },
      reservationStatusHistory: { create: jest.fn(async () => undefined) },
    };
    db.$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(db);
    const svc = new ReservationsService(db, {} as any, {} as any, { send: jest.fn(async () => undefined) } as any, {} as any, {} as any, { forRequest: async () => 5 } as any);
    (svc as any).objectCard = jest.fn(async () => CARD);
    (svc as any).objectWarehouse = jest.fn(async () => null);
    (svc as any).stillReservable = jest.fn(async () => true);
    return { svc, subs, rows };
  }

  it('a direct supply: the keeper’s submission «Պահեստից՝ առանց հայտի», the rows pointing at it', async () => {
    const w = supplyWorld();
    const out = await w.svc.createForObject(OBJECT, [{ itemId: 7, quantity: 2 }], KEEPER, { asWarehouse: true });
    expect(w.subs).toHaveLength(1);
    expect(w.subs[0]).toMatchObject({ number: 'REQ-1077', createdBy: KEEPER, objectId: OBJECT, projectId: 20, projectName: 'Բնակելի շենք', entityId: 1, purpose: 'Պահեստից՝ առանց հայտի' });
    expect(w.rows[0]).toMatchObject({ objectId: OBJECT, submissionId: 300, status: 'APPROVED' });
    expect(out.submission).toEqual({ id: 300, number: 'REQ-1077' });
  });

  it('the deprecated object request: the responsible person’s submission with their note as the purpose', async () => {
    const w = supplyWorld();
    await w.svc.createForObject(OBJECT, [{ itemId: 7, quantity: 1 }], 32, { note: ' Հիմքի համար ' });
    expect(w.subs[0]).toMatchObject({ createdBy: 32, purpose: 'Հիմքի համար' });
    const plain = supplyWorld();
    await plain.svc.createForObject(OBJECT, [{ itemId: 7, quantity: 1 }], 32, {});
    expect(plain.subs[0].purpose).toBe('Պահեստային հայտ (մինչև կատալոգը)');
  });
});
