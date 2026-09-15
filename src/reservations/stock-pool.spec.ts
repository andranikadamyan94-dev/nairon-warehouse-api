import { BadRequestException } from '@nestjs/common';

import { ReservationsService } from './reservations.service';

/**
 * WHICH SHELF DID THE GOODS COME OFF?
 *
 * A reservation raised against a PROJECT sub-warehouse draws from that
 * warehouse's own stock; one without a warehouse draws from the main pool
 * (#1989). The pre-transaction check has always said so. The write did not:
 * it took from `Item` every time, so a project issuance passed the project
 * check and then helped itself to the main pool — the sub's stock never moved
 * and the main pool fell for goods it was not holding.
 *
 * These tests watch the writes rather than the return value, because the bug
 * was invisible from the outside: the call succeeded either way.
 */

type Recorded = { table: string; where: any; data: any };

function harness(opts: {
  warehouseId: number | null;
  mainStock: number;
  projectStock: number;
  requested: number;
  /** already out on live allocations */
  out?: number;
}) {
  const writes: Recorded[] = [];
  const dec = (table: string) => async ({ where, data }: any) => {
    writes.push({ table, where, data });
    // Mirrors the guarded update: it only bites when the row still has enough.
    const have = table === 'warehouseStock' ? opts.projectStock : opts.mainStock;
    const need = where.quantity?.gte ?? 0;
    return { count: have >= need ? 1 : 0 };
  };

  const reservation = {
    id: 1,
    status: 'PENDING',
    quantity: opts.requested,
    warehouseId: opts.warehouseId,
    taskId: null,
    objectId: null,
    item: { id: 7, type: 'CONSUMABLE', quantity: opts.mainStock, unitCost: null },
  };

  const quantities = {
    aggregate: async ({ where }: any) => ({
      _sum: { quantity: where?.releasedAt === null ? (opts.out ?? 0) : 0 },
    }),
  };

  const tx = {
    $queryRawUnsafe: async () => [{ id: 1 }],
    $executeRaw: async () => 0,
    item: {
      updateMany: dec('item'),
      findUnique: async () => ({ quantity: opts.mainStock }),
      update: async () => ({}),
    },
    warehouseStock: {
      updateMany: dec('warehouseStock'),
      findUnique: async () => ({ quantity: opts.projectStock }),
      upsert: async () => ({}),
    },
    resourceReservation: {
      findUnique: async () => ({ quantity: opts.requested }),
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
    reservationAllocation: { ...quantities, create: async () => ({}) },
    resourceReturn: { aggregate: async () => ({ _sum: { quantity: 0 } }) },
    reservationAllocationHistory: { create: async () => ({}) },
    reservationStatusHistory: { create: async () => ({}) },
    inventoryMovement: { create: async () => ({}) },
  };

  const prisma: any = {
    resourceReservation: { findUnique: async () => reservation },
    reservationAllocation: quantities,
    resourceReturn: { aggregate: async () => ({ _sum: { quantity: 0 } }) },
    warehouseStock: { findUnique: async () => ({ quantity: opts.projectStock }) },
    $transaction: async (cb: any) => cb(tx),
  };

  const svc = new ReservationsService(
    prisma,
    { checkAvailability: async () => ({}) } as any,
    { check: async () => {} } as any,
    { reservationApproved: async () => {} } as any,
    {} as any,
    {} as any,
    { pinFor: async () => null } as any,
  );
  // Authorization has its own tests; this file is about which shelf moved.
  (svc as any).assertMay = async () => {};
  (svc as any).currentTaskObjectId = async () => undefined;

  return { svc, writes };
}

const decrements = (writes: Recorded[]) => writes.filter((w) => w.data?.quantity?.decrement !== undefined);

describe('a reservation decrements its OWN stock pool', () => {
  it('no warehouse: the main Item pool moves, and the project shelf is never touched', async () => {
    const { svc, writes } = harness({ warehouseId: null, mainStock: 10, projectStock: 0, requested: 4 });
    await svc.approveConsumable(1, 99, 4);
    const d = decrements(writes);
    expect(d).toHaveLength(1);
    expect(d[0].table).toBe('item');
    expect(d[0].data.quantity.decrement).toBe(4);
    expect(writes.some((w) => w.table === 'warehouseStock')).toBe(false);
  });

  it('a project reservation moves THAT warehouse stock, and the main pool is never touched', async () => {
    const { svc, writes } = harness({ warehouseId: 3, mainStock: 10, projectStock: 6, requested: 4 });
    await svc.approveConsumable(1, 99, 4);
    const d = decrements(writes);
    expect(d).toHaveLength(1);
    expect(d[0].table).toBe('warehouseStock');
    expect(d[0].where.warehouseId).toBe(3);
    expect(d[0].data.quantity.decrement).toBe(4);
    expect(writes.some((w) => w.table === 'item')).toBe(false);
  });

  it('exactly one pool is decremented, never both', async () => {
    for (const warehouseId of [null, 3]) {
      const { svc, writes } = harness({ warehouseId, mainStock: 10, projectStock: 10, requested: 2 });
      await svc.approveConsumable(1, 99, 2);
      expect(decrements(writes)).toHaveLength(1);
    }
  });

  /**
   * The one that matters most. Main has plenty; the project shelf does not.
   * Falling back to main would be silent theft from another pool, and the call
   * would look successful.
   */
  it('an empty project shelf FAILS even when the main pool has enough', async () => {
    const { svc, writes } = harness({ warehouseId: 3, mainStock: 100, projectStock: 1, requested: 4 });
    await expect(svc.approveConsumable(1, 99, 4)).rejects.toBeInstanceOf(BadRequestException);
    expect(writes.some((w) => w.table === 'item')).toBe(false);
  });

  it('an empty main pool fails when there is no project warehouse', async () => {
    const { svc } = harness({ warehouseId: null, mainStock: 1, projectStock: 100, requested: 4 });
    await expect(svc.approveConsumable(1, 99, 4)).rejects.toBeInstanceOf(BadRequestException);
  });
});
