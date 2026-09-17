import { BadRequestException } from '@nestjs/common';

import { roundQty } from '../common/quantity';
import { quantitiesOf } from './quantities';
import { ReservationsService } from './reservations.service';

/**
 * PRE-P4 A3 — A FRACTIONAL REMAINDER CAN BE ISSUED.
 *
 * Fractional issuance arrived 2026-09-15 (0.3 kg is a valid issue) and every
 * quantity was put through roundQty — except the over-issue guard inside the
 * issuing transaction, which added two rounded numbers and compared the raw
 * sum. 0.2 + 0.1 is 0.30000000000000004 in double precision, which is "more
 * than 0.3", so the last 0.1 of a 0.3 kg request could never be handed out.
 *
 * The earlier suite issued in one step or in whole units, so it never took the
 * second fractional step. These do, several times over, against a store that
 * keeps state between calls: stock really moves, allocations accumulate,
 * returns count as issued, stored quantities are settled to three decimals as
 * the raw SQL does, and a transaction that throws leaves nothing behind.
 */

type Pool = 'MAIN' | 'PROJECT';

function store(opts: {
  pool: Pool;
  requested: number;
  mainStock?: number;
  projectStock?: number;
  /** live allocations already out */
  out?: number[];
  /** returns already RECEIVED (still count as issued) */
  received?: number[];
}) {
  const state = {
    status: 'APPROVED',
    main: opts.mainStock ?? 100,
    project: opts.projectStock ?? 100,
    allocations: (opts.out ?? []).map((quantity) => ({ quantity, releasedAt: null as Date | null })),
    returns: (opts.received ?? []).map((quantity) => ({ quantity, status: 'RECEIVED' })),
    decrements: [] as { pool: Pool; amount: number }[],
  };
  const warehouseId = opts.pool === 'PROJECT' ? 3 : null;
  /** Something another caller commits while this one holds no lock yet. */
  let beforeLock: (() => void) | null = null;

  const sum = (rows: { quantity: number }[]) => rows.reduce((s, r) => s + r.quantity, 0);
  const round3 = (n: number) => Math.round(n * 1000) / 1000; // ROUND(numeric, 3)

  const db: any = {
    resourceReservation: {
      findUnique: async ({ select }: any) =>
        select
          ? { quantity: opts.requested }
          : {
              id: 1,
              status: state.status,
              quantity: opts.requested,
              warehouseId,
              taskId: null,
              objectId: null,
              item: { id: 7, name: 'Cement', type: 'CONSUMABLE', quantity: state.main, unitCost: null },
            },
      update: async ({ data }: any) => {
        if (data.status) state.status = data.status;
        return {};
      },
    },
    reservationAllocation: {
      aggregate: async ({ where }: any) => ({
        _sum: { quantity: where.releasedAt === null ? sum(state.allocations.filter((a) => a.releasedAt === null)) : 0 },
      }),
      create: async ({ data }: any) => {
        state.allocations.push({ quantity: data.quantity, releasedAt: null });
        return {};
      },
    },
    resourceReturn: {
      aggregate: async ({ where }: any) => ({
        _sum: { quantity: sum(state.returns.filter((r) => r.status === where.status)) },
      }),
    },
    warehouseStock: {
      findUnique: async () => ({ quantity: state.project }),
      updateMany: async ({ where, data }: any) => {
        if (state.project < where.quantity.gte) return { count: 0 };
        state.project -= data.quantity.decrement;
        state.decrements.push({ pool: 'PROJECT', amount: data.quantity.decrement });
        return { count: 1 };
      },
    },
    item: {
      findUnique: async () => ({ quantity: state.main }),
      updateMany: async ({ where, data }: any) => {
        if (state.main < where.quantity.gte) return { count: 0 };
        state.main -= data.quantity.decrement;
        state.decrements.push({ pool: 'MAIN', amount: data.quantity.decrement });
        return { count: 1 };
      },
    },
    reservationAllocationHistory: { create: async () => ({}) },
    reservationStatusHistory: { create: async () => ({}) },
    inventoryMovement: { create: async () => ({}) },
    $queryRawUnsafe: async () => [{ id: 1 }],
    $executeRawUnsafe: async () => 0,
    $executeRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('"WarehouseStock"')) state.project = round3(state.project);
      else if (sql.includes('"Item"')) state.main = round3(state.main);
      return 0;
    },
  };
  db.$transaction = async (fn: (tx: any) => Promise<unknown>) => {
    // Another caller's committed work, landing after this caller's pre-check
    // and before its transaction takes the locks. It is not rolled back.
    beforeLock?.();
    beforeLock = null;
    const snapshot = JSON.parse(JSON.stringify(state));
    try {
      return await fn(db);
    } catch (error) {
      Object.assign(state, snapshot);
      throw error;
    }
  };

  const svc = new ReservationsService(
    db,
    { checkAvailability: async () => ({}) } as any,
    { check: async () => {} } as any,
    { reservationApproved: async () => {} } as any,
    {} as any,
    {} as any,
    { pinFor: async () => null } as any,
  );
  // Authorization has its own suites (two-party, Warehouse V1 contract).
  (svc as any).assertMay = async () => {};
  (svc as any).currentTaskObjectId = async () => undefined;
  const notices: { label: string; value: string }[][] = [];
  (svc as any).notifyRequesters = async (_r: unknown, _t: string, _b: string, fields: any[]) => {
    notices.push(fields);
  };

  const issue = (quantity?: number) => svc.approveConsumable(1, 99, quantity as number);
  const measure = () => quantitiesOf(db, 1);
  const onNextLock = (fn: () => void) => {
    beforeLock = fn;
  };
  return { svc, state, issue, measure, notices, onNextLock };
}

const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(BadRequestException);

describe.each<Pool>(['MAIN', 'PROJECT'])('%s pool — fractional remainders', (pool) => {
  const other = (s: { main: number; project: number }) => (pool === 'MAIN' ? s.project : s.main);
  const own = (s: { main: number; project: number }) => (pool === 'MAIN' ? s.main : s.project);

  it('A. 0.3 requested: 0.2 then 0.1 are both issued, and exactly 0.3 is out', async () => {
    const w = store({ pool, requested: 0.3 });
    await w.issue(0.2);
    await expect(w.issue(0.1)).resolves.toEqual({ success: true });
    const q = await w.measure();
    expect(q.issued).toBe(0.3);
    expect(q.outstandingToIssue).toBe(0);
    expect(w.state.status).toBe('ALLOCATED');
    expect(own(w.state)).toBe(99.7);
    expect(other(w.state)).toBe(100);
  });

  it('B. 0.3 requested: 0.1, then "the rest" without a quantity', async () => {
    const w = store({ pool, requested: 0.3 });
    await w.issue(0.1);
    await expect(w.issue()).resolves.toEqual({ success: true });
    expect(w.state.decrements.map((d) => d.amount)).toEqual([0.1, 0.2]);
    expect((await w.measure()).issued).toBe(0.3);
    expect(w.state.status).toBe('ALLOCATED');
  });

  it('A/B. three tenths, one at a time', async () => {
    const w = store({ pool, requested: 0.3 });
    for (let i = 0; i < 3; i++) await w.issue(0.1);
    expect((await w.measure()).issued).toBe(0.3);
    expect(w.state.status).toBe('ALLOCATED');
    await refused(w.issue(0.001));
  });

  it('C. 9.8 requested, 0.1 issued: 9.7 remains — in the measure and in the notice — and can be issued', async () => {
    const w = store({ pool, requested: 9.8 });
    await w.issue(0.1);
    expect((await w.measure()).outstandingToIssue).toBe(9.7);
    expect(w.state.status).toBe('PARTIALLY_ALLOCATED');
    expect(w.notices[0]).toContainEqual({ label: 'Մնացորդ', value: '9.7' });
    await expect(w.issue(9.7)).resolves.toEqual({ success: true });
    expect((await w.measure()).issued).toBe(9.8);
    expect(w.state.status).toBe('ALLOCATED');
  });

  it('D. at the precision boundary the roundQty contract holds: 1.005 as 0.335 × 3', async () => {
    const w = store({ pool, requested: 1.005 });
    for (let i = 0; i < 3; i++) await w.issue(0.335);
    const q = await w.measure();
    expect(q.issued).toBe(1.005);
    expect(q.outstandingToIssue).toBe(0);
    await refused(w.issue(0.001));
  });

  it('D. the smallest step the warehouse measures (0.001) is issuable to the last unit', async () => {
    const w = store({ pool, requested: 0.003 });
    for (let i = 0; i < 3; i++) await w.issue(0.001);
    expect((await w.measure()).issued).toBe(0.003);
    await refused(w.issue(0.001));
  });

  it('D. below the precision rounds to nothing and is refused as not positive, as before', async () => {
    const w = store({ pool, requested: 1 });
    await refused(w.issue(0.0004));
    expect(w.state.decrements).toEqual([]);
  });

  it('E. a real over-issue is still refused: 0.3 requested, 0.2 out, 0.11 asked', async () => {
    const w = store({ pool, requested: 0.3 });
    await w.issue(0.2);
    await refused(w.issue(0.11));
    expect((await w.measure()).issued).toBe(0.2);
    expect(own(w.state)).toBe(99.8);
  });

  it('E. by a single thousandth, too', async () => {
    const w = store({ pool, requested: 0.3 });
    await w.issue(0.2);
    await refused(w.issue(0.101));
  });

  it('F. whole quantities are unchanged: 10 as 4 + 6, and nothing more', async () => {
    const w = store({ pool, requested: 10 });
    await w.issue(4);
    expect(w.state.status).toBe('PARTIALLY_ALLOCATED');
    await w.issue(6);
    expect(w.state.status).toBe('ALLOCATED');
    expect((await w.measure()).issued).toBe(10);
    await refused(w.issue(1));
    expect(own(w.state)).toBe(90);
    expect(other(w.state)).toBe(100);
  });
});

describe('the guard inside the transaction — the one A3 was about', () => {
  /*
   * The pre-check before the transaction reads outstanding already rounded,
   * so a sequential 0.2 + 0.1 never reached the raw sum there. The in-tx guard
   * is what a concurrent issuer meets, and it re-measures after taking the
   * lock. These drive it directly by landing another allocation in between.
   */
  it.each<Pool>(['MAIN', 'PROJECT'])('%s: a concurrent 0.1 landing first still lets this 0.1 complete 0.3', async (pool) => {
    const w = store({ pool, requested: 0.3, out: [0.1] });
    w.onNextLock(() => w.state.allocations.push({ quantity: 0.1, releasedAt: null }));
    await expect(w.issue(0.1)).resolves.toEqual({ success: true });
    expect(roundQty(w.state.allocations.reduce((s, a) => s + a.quantity, 0))).toBe(0.3);
  });

  it.each<Pool>(['MAIN', 'PROJECT'])('%s: a concurrent issue that uses up the remainder refuses this one, and its stock move is undone', async (pool) => {
    const w = store({ pool, requested: 0.3, out: [0.1] });
    w.onNextLock(() => w.state.allocations.push({ quantity: 0.2, releasedAt: null }));
    await refused(w.issue(0.1));
    expect(w.state.decrements).toEqual([]);
    expect(pool === 'MAIN' ? w.state.main : w.state.project).toBe(100);
    expect(w.state.allocations.map((a) => a.quantity)).toEqual([0.1, 0.2]);
  });
});

describe('returns still count as issued', () => {
  it('0.3 requested, 0.2 issued of which 0.1 came back: only 0.1 more may go out', async () => {
    // Receiving a return reduces the allocation it came from and records the
    // return as RECEIVED; issued = out + returned stays 0.2.
    const w = store({ pool: 'MAIN', requested: 0.3, out: [0.1], received: [0.1] });
    expect((await w.measure()).issued).toBe(0.2);
    await refused(w.issue(0.2));
    await expect(w.issue(0.1)).resolves.toEqual({ success: true });
    expect((await w.measure()).issued).toBe(0.3);
    await refused(w.issue(0.001));
  });
});

describe('no PROJECT → MAIN fallback, fractional', () => {
  it('a project shelf short by a fraction refuses even with the main pool full, and main never moves', async () => {
    const w = store({ pool: 'PROJECT', requested: 0.3, projectStock: 0.25, mainStock: 100 });
    await w.issue(0.2);
    expect(w.state.project).toBe(0.05);
    await refused(w.issue(0.1));
    expect(w.state.main).toBe(100);
    expect(w.state.decrements.every((d) => d.pool === 'PROJECT')).toBe(true);
  });
});
