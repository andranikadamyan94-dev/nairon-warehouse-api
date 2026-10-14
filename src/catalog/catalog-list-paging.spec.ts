import { Logger } from '@nestjs/common';

import { CatalogService } from './catalog.service';
import { DIRECT_SUPPLY_PURPOSE, SUBMISSION_SOURCES, SUBMISSION_STATUSES } from './catalog.rules';

/**
 * The queue and «Իմ հարցումները» page in the database (performance audit
 * 2026-10-13, W2). The contract is that nothing on screen changes: for every
 * filter, sort and page the new path must answer exactly what the old one
 * did — build every submission's view, filter it, slice 20. The old path is
 * kept below, verbatim, as the reference; both run on one generated fixture
 * of 92 submissions covering every line status, requisition status, cancel /
 * info-request flag, source, warehouse, organization, unit and creation-time
 * ties.
 */

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

const PAGE = 20;
const USERS = [7, 8, 9, 40];
// Pairs of submissions share a timestamp, so the id decides their order.
const day = (n: number) => new Date(Date.UTC(2026, 8, 1 + Math.floor(n / 3), 8 + (n % 2)));
const STOCK = ['PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED', 'COMPLETED', 'REJECTED', 'CANCELLED'];
const REQ = ['DRAFT', 'PENDING_APPROVAL', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'FULFILLED', 'REJECTION_PENDING', 'REJECTED', 'CANCELLED'];
const ITEMS = [
  { id: 7, name: 'Ցեմենտ', unit: 'KG', code: 'C-7', variantLabel: null, type: 'CONSUMABLE' },
  { id: 9, name: 'Գեներատոր', unit: 'PIECE', code: 'G-9', variantLabel: null, type: 'ASSET' },
  { id: 11, name: 'Ավազ', unit: 'KG', code: 'S-11', variantLabel: null, type: 'CONSUMABLE' },
];

function fixture() {
  // mulberry32: a fixed seed, so the fixture is the same on every run.
  let seed = 0x2a2a2a2a;
  const r = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const subs: any[] = [];
  const rows: any[] = [];
  const reqs: any[] = [];
  let rowId = 1000;
  let lineId = 1;
  for (let i = 1; i <= 90; i++) {
    const objectId = r(3) === 0 ? null : 600 + r(2);
    const taskId = objectId && r(3) === 0 ? 500 + r(3) : null;
    const direct = !!objectId && !taskId && r(4) === 0;
    subs.push({
      id: i,
      number: `REQ-${1000 + i}`,
      createdBy: USERS[r(USERS.length)],
      entityId: 1 + r(2),
      objectId,
      taskId,
      projectId: objectId ? 20 : null,
      projectName: r(2) ? `Նախագիծ ${r(5)}` : null,
      costCenter: r(4) === 0 ? 'Գրասենյակ' : null,
      purpose: direct && r(2) ? DIRECT_SUPPLY_PURPOSE : ['Շինարարություն', 'Վերանորոգում', 'Գրասենյակ'][r(3)],
      neededBy: new Date('2099-12-01'),
      comment: null,
      attachmentUrl: null,
      infoRequestText: null,
      infoRequestBy: null,
      infoRequestAt: r(9) === 0 ? day(i) : null,
      lastReminderAt: null,
      lastReminderBy: null,
      reminders: [],
      cancelledAt: r(12) === 0 ? day(i) : null,
      createdAt: day(i),
    });
    const nRows = r(4);
    for (let k = 0; k < nRows; k++) {
      const status = STOCK[r(STOCK.length)];
      const item = ITEMS[r(ITEMS.length)];
      const issued = ['PARTIALLY_ALLOCATED', 'ALLOCATED', 'COMPLETED'].includes(status) || (status === 'APPROVED' && r(2)) ? 1 + r(4) : 0;
      const warehouseId = r(3) === 0 ? 3 : null;
      rows.push({
        id: rowId++,
        submissionId: i,
        itemId: item.id,
        quantity: 5,
        status,
        acceptedQuantity: issued ? r(issued + 1) : 0,
        warehouseId,
        warehouse: warehouseId ? { id: 3, name: 'Արաբկիր' } : null,
        startDate: day(i),
        endDate: new Date('2099-12-01'),
        item,
        allocations: issued ? [{ id: rowId * 10, quantity: issued, assetId: null, asset: null }] : [],
        allocationHistory: [],
        statusHistory: [
          {
            performedAt: day(i),
            fromStatus: null,
            toStatus: 'APPROVED',
            performedBy: 40,
            reason: direct && r(5) ? 'Պահեստը տրամադրում է օբյեկտին' : 'Կատալոգի հարցում',
          },
        ],
      });
    }
    if (nRows === 0 || r(3) === 0) {
      const status = REQ[r(REQ.length)];
      reqs.push({
        id: 300 + i,
        submissionId: i,
        status,
        decidedAt: null,
        decidedBy: null,
        reviewedAt: null,
        reviewedBy: null,
        rejectionRequestedAt: null,
        rejectionRequestedBy: null,
        rejectionReason: null,
        comments: [],
        lines: [{ id: lineId++, itemId: r(2) ? 7 : null, itemName: r(2) ? 'Ցեմենտ' : 'Նոր դուռ', quantity: 2, unit: 'PIECE', code: null, item: null }],
      });
    }
  }
  // Two ready to collect: every live line handed out in full.
  for (const i of [91, 92]) {
    subs.push({ ...subs[0], id: i, number: `REQ-${1000 + i}`, createdBy: USERS[i % 4], objectId: null, taskId: null, cancelledAt: null, infoRequestAt: null, createdAt: day(i) });
    rows.push({ ...rows[0], id: rowId++, submissionId: i, status: 'ALLOCATED', acceptedQuantity: 0, allocations: [{ id: rowId * 10, quantity: 5, assetId: null, asset: null }] });
  }
  return { subs, rows, reqs };
}

/** Prisma, in memory: exactly the where / orderBy / skip / take shapes the two paths use. */
function memoryPrisma(data: ReturnType<typeof fixture>) {
  const matches = (s: any, where: any): boolean => {
    if (!where) return true;
    if (where.id != null) {
      if (typeof where.id === 'object' && Array.isArray(where.id.in)) {
        if (!where.id.in.includes(s.id)) return false;
      } else if (s.id !== where.id) return false;
    }
    if (where.createdBy != null && s.createdBy !== where.createdBy) return false;
    if (where.entityId != null && s.entityId !== where.entityId) return false;
    if (where.reservations?.some) {
      const wh = where.reservations.some.warehouseId;
      if (!data.rows.some((r) => r.submissionId === s.id && r.warehouseId === wh)) return false;
    }
    if (where.requisitions?.some) {
      const some = where.requisitions.some;
      if (!data.reqs.some((r) => r.submissionId === s.id && some.status.in.includes(r.status) && r.lines.length > 0)) return false;
    }
    if (where.createdAt?.gte && s.createdAt < where.createdAt.gte) return false;
    if (where.createdAt?.lt && s.createdAt >= where.createdAt.lt) return false;
    return true;
  };
  const sortSubs = (list: any[], orderBy: any) => {
    const keys = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...list].sort((a, b) => {
      for (const k of keys) {
        const [f, dir] = Object.entries(k)[0] as [string, string];
        const d = +a[f] - +b[f];
        if (d) return dir === 'asc' ? d : -d;
      }
      return 0;
    });
  };
  const byId = (a: any, b: any) => a.id - b.id;
  return {
    catalogSubmission: {
      findMany: jest.fn(async (args: any) => {
        let list = sortSubs(data.subs.filter((s) => matches(s, args.where)), args.orderBy);
        if (args.skip) list = list.slice(args.skip);
        if (args.take != null) list = list.slice(0, args.take);
        return list;
      }),
      count: jest.fn(async (args: any) => data.subs.filter((s) => matches(s, args.where)).length),
    },
    resourceReservation: {
      findMany: jest.fn(async (args: any) => {
        const w = args.where ?? {};
        if (w.submissionId?.in) return data.rows.filter((r) => w.submissionId.in.includes(r.submissionId)).sort(byId);
        if (w.id?.in) return data.rows.filter((r) => w.id.in.includes(r.id)).sort(byId);
        return []; // poolFree's other live claims: none
      }),
      groupBy: jest.fn(async () => []),
    },
    purchaseRequisition: {
      findMany: jest.fn(async (args: any) => data.reqs.filter((r) => args.where.submissionId.in.includes(r.submissionId)).sort(byId)),
    },
    warehouseStock: {
      findMany: jest.fn(async () => [
        { warehouseId: 3, itemId: 7, quantity: 20 },
        { warehouseId: 3, itemId: 11, quantity: 4 },
      ]),
    },
    asset: { groupBy: jest.fn(async () => []) },
    item: { findMany: jest.fn(async () => []) },
  };
}

function world() {
  const data = fixture();
  const prisma: any = memoryPrisma(data);
  const NAMES: Record<number, [string, string]> = {
    7: ['Անի', 'Հակոբյան'],
    8: ['Արամ', 'Սարգսյան'],
    9: ['Մարիամ', 'Գրիգորյան'],
    40: ['Պահեստապետ', 'Պողոսյան'],
  };
  const users: any = {
    getUsersByIds: jest.fn(async (ids: number[]) =>
      ids.filter((id) => NAMES[id]).map((id) => ({ id, firstName: NAMES[id][0], lastName: NAMES[id][1], email: '' })),
    ),
  };
  const reservations: any = {
    requisitionsFor: jest.fn(
      async (ids: number[]) => new Map(ids.filter((id) => id % 5 === 0).map((id) => [id, { id: id + 1, status: 'PENDING_APPROVAL' }])),
    ),
    taskCard: jest.fn(async (id: number) => ({ id, title: `Առաջադրանք ${id}`, projectId: 20, objectId: 600, createdById: 9, people: [] })),
  };
  const objects: any = {
    crmObjectsCovering: jest.fn(async () => [
      { id: 600, code: 'O-600', name: 'Արաբկիր' },
      { id: 601, code: 'O-601', name: 'Կենտրոն' },
    ]),
  };
  const svc = new CatalogService(prisma, users, reservations, {} as any, {} as any, {} as any, undefined as any, undefined as any, objects);
  (svc as any).freeStock = jest.fn(async (ids: number[]) => new Map(ids.map((id) => [id, id % 4])));
  const UNIT: Record<number, number> = { 7: 1, 8: 1, 9: 2, 40: 3 };
  (svc as any).directory = jest.fn(async () => ({
    unitOf: new Map(Object.entries(UNIT).map(([u, unitId]) => [Number(u), { unitId, unitName: `Բաժին ${unitId}`, entityId: 1 }])),
    entityName: new Map([
      [1, 'Նաիրոն'],
      [2, 'Այլ'],
    ]),
  }));
  return { svc, prisma, data };
}

// ── The old path, verbatim (catalog.service.ts before 2026-10-13) ───────────

// size: the fixed 20 of the old path, or (page-size checks below) the size the screen asked for.
const oldPageOf = (all: any[], query: any, size = PAGE) => {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  return { items: all.slice((page - 1) * size, page * size), total: all.length };
};
async function oldMine(svc: any, userId: number, query: any, size = PAGE) {
  const all = await svc.views({ createdBy: userId }, userId);
  return oldPageOf(svc.filterViews(all, query), query, size);
}
async function oldQueue(svc: any, query: any, viewerId: number, size = PAGE) {
  const where: any = {};
  if (Number(query.entityId) > 0) where.entityId = Number(query.entityId);
  if (Number(query.requesterId) > 0) where.createdBy = Number(query.requesterId);
  if (query.warehouseId === 'main') where.reservations = { some: { warehouseId: null } };
  else if (Number(query.warehouseId) > 0) where.reservations = { some: { warehouseId: Number(query.warehouseId) } };
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: svc.dayOf(query.from, 'x') } : {}),
      ...(query.to ? { lt: new Date(svc.dayOf(query.to, 'x').getTime() + 86_400_000) } : {}),
    };
  }
  let all = await svc.views(where, viewerId);
  if (Number(query.unitId) > 0) {
    const dir = await svc.directory();
    all = all.filter((v: any) => dir.unitOf.get(v.createdBy)?.unitId === Number(query.unitId));
  }
  if (query.sort === 'oldest') all = [...all].reverse();
  return oldPageOf(svc.filterViews(all, query), query, size);
}

// ── The queries ─────────────────────────────────────────────────────────────

const FILTERS: Record<string, string | undefined>[] = [
  {},
  ...SUBMISSION_STATUSES.map((status) => ({ status })),
  { status: 'ISSUED' },
  { status: 'issued' },
  { status: 'NOT_A_STATUS' },
  ...SUBMISSION_SOURCES.map((source) => ({ source })),
  { kind: 'STOCK' },
  { kind: 'PURCHASE' },
  { kind: 'NEW' },
  { kind: 'other' },
  { q: 'ցեմենտ' },
  { q: 'REQ-104' },
  { q: 'Արաբկիր' },
  { q: 'O-601' },
  { q: 'Անի Հակ' },
  { q: 'նախագիծ 3' },
  { q: 'գրասենյակ' },
  { q: 'նոր դուռ' },
  { q: '   ' },
  { status: 'IN_PROGRESS', kind: 'STOCK', q: 'ավազ' },
  { source: 'OBJECT', status: 'SUBMITTED' },
];
const QUEUE_ONLY: Record<string, string | undefined>[] = [
  { sort: 'oldest' },
  { sort: 'oldest', status: 'READY' },
  { unitId: '1' },
  { unitId: '2', q: 'ցեմ' },
  { unitId: '3', sort: 'oldest' },
  { entityId: '2' },
  { requesterId: '8' },
  { requesterId: '8', status: 'CANCELLED' },
  { warehouseId: 'main' },
  { warehouseId: '3' },
  { warehouseId: '3', sort: 'oldest', source: 'DIRECT' },
  { from: '2026-09-05', to: '2026-09-20' },
  { from: '2026-09-10' },
  { to: '2026-09-12', status: 'COMPLETED' },
];
const PAGES = ['1', '2', '3', '5', undefined, '0', 'x'];
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

describe('queue and «Իմ հարցումները» — the database-paged path answers exactly what the old one did', () => {
  it('the queue: every filter × sort × page', async () => {
    const { svc } = world();
    let compared = 0;
    for (const f of [...FILTERS, ...QUEUE_ONLY]) {
      for (const page of PAGES) {
        const query = { ...f, page };
        const expected = await oldQueue(svc, query, 40);
        const actual = await svc.queue(query, { userId: 40 } as any);
        expect({ query, result: plain(actual) }).toEqual({ query, result: plain(expected) });
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(300);
  });

  it('«Իմ հարցումները»: every filter × page, for each requester', async () => {
    const { svc } = world();
    for (const userId of USERS) {
      for (const f of FILTERS) {
        for (const page of PAGES) {
          const query = { ...f, page };
          const expected = await oldMine(svc, userId, query);
          const actual = await svc.mine(userId, query);
          expect({ userId, query, result: plain(actual) }).toEqual({ userId, query, result: plain(expected) });
        }
      }
    }
  });

  it('a rejection awaiting confirmation is under «Սպասում է հաստատման», never «Մերժված» (2026-10-15)', async () => {
    const { svc } = world();
    const all: any[] = (await Promise.all(USERS.map((u) => (svc as any).views({ createdBy: u }, u)))).flat();
    const awaiting = all.filter((v) => v.status === 'REJECTED' && v.rejectionAwaitsConfirmation).map((v) => v.id).sort();
    const final = all.filter((v) => v.status === 'REJECTED' && !v.rejectionAwaitsConfirmation).map((v) => v.id).sort();
    expect(awaiting.length).toBeGreaterThan(0);
    expect(final.length).toBeGreaterThan(0);
    const tab = async (status: string) =>
      (await Promise.all(USERS.map((u) => svc.mine(u, { status, pageSize: '100' })))).flatMap((p: any) => p.items.map((v: any) => v.id));
    const rejected = await tab('REJECTED');
    const waiting = await tab('SUBMITTED');
    expect([...rejected].sort()).toEqual(final);
    for (const id of awaiting) expect(waiting).toContain(id);
    for (const v of all.filter((x) => x.status === 'SUBMITTED')) expect(waiting).toContain(v.id);
  });

  it('the fixture is not trivial: pages fill, every status and source occurs', async () => {
    const { svc } = world();
    const all = await (svc as any).views({}, 40);
    expect(all.length).toBe(92);
    for (const s of SUBMISSION_STATUSES) expect([s, all.some((v: any) => v.status === s)]).toEqual([s, true]);
    for (const s of SUBMISSION_SOURCES) expect([s, all.some((v: any) => v.source === s)]).toEqual([s, true]);
    expect(all.some((v: any) => v.lines.some((l: any) => l.reclaimableQuantity > 0))).toBe(true);
    expect(all.filter((v: any) => v.lines.some((l: any) => l.kind === 'STOCK')).length).toBeGreaterThan(40);
    expect(all.some((v: any) => v.lines.some((l: any) => l.kind === 'NEW'))).toBe(true);
  });

  it('without a filter that needs a built view, only the page is read: the page by skip/take, the total by count', async () => {
    const { svc, prisma } = world();
    const res = await svc.queue({ page: '2' }, { userId: 40 } as any);
    expect(res.items).toHaveLength(PAGE);
    expect(res.total).toBe(92);
    expect(prisma.catalogSubmission.count).toHaveBeenCalledTimes(1);
    const loads = prisma.catalogSubmission.findMany.mock.calls.map((c: any[]) => c[0]);
    expect(loads[0]).toMatchObject({ skip: PAGE, take: PAGE, select: { id: true } });
    expect(loads[1].where).toEqual({ id: { in: res.items.map((v) => v.id) } });
  });

  it('«Գնման հաստատում» (status=PURCHASE_APPROVAL, 2026-10-12) in the database answers what the built views say', async () => {
    const { svc, prisma } = world();
    // The reference: every view, kept where a purchase line awaits the organisation or a rejection's confirmation.
    const awaiting = (v: any) => v.lines.some((l: any) => l.kind !== 'STOCK' && ['PENDING_APPROVAL', 'REJECTION_PENDING'].includes(l.status));
    for (const f of [{}, { q: 'ցեմենտ' }, { sort: 'oldest' }, { unitId: '1' }, { entityId: '2' }, { kind: 'NEW' }]) {
      for (const page of ['1', '2']) {
        const query = { ...f, page, pageSize: '10' };
        const all = await oldQueue(svc, { ...query, status: undefined, page: '1' }, 40, 10000);
        const kept = all.items.filter(awaiting);
        const expected = { items: kept.slice((Number(page) - 1) * 10, Number(page) * 10), total: kept.length };
        const actual = await svc.queue({ ...query, status: 'PURCHASE_APPROVAL' }, { userId: 40 } as any);
        expect({ query, result: plain(actual) }).toEqual({ query, result: plain(expected) });
      }
    }
    expect((await svc.queue({ status: 'purchase_approval' }, { userId: 40 } as any)).total).toBeGreaterThan(3);
    // No filter that needs a built view: the total is a count, not a light pass.
    prisma.purchaseRequisition.findMany.mockClear();
    await svc.queue({ status: 'PURCHASE_APPROVAL' }, { userId: 40 } as any);
    expect(prisma.purchaseRequisition.findMany).toHaveBeenCalledTimes(1);
  });

  it('with a filter, the full views (histories, stock, CRM task titles) are built for the page only', async () => {
    const { svc } = world();
    const views = jest.spyOn(svc as any, 'views');
    const res = await svc.queue({ status: 'SUBMITTED' }, { userId: 40 } as any);
    expect(views).toHaveBeenCalledTimes(1);
    expect((views.mock.calls[0][0] as any).id.in).toEqual(res.items.map((v) => v.id));
  });
});

// ── Page sizes (B1, 2026-10-13) ─────────────────────────────────────────────
// The screens send pageSize 10 / 20 / 50; the server used to ignore it and
// always cut 20 (a 10-row page showed rows again on the next one and left
// empty pages at the end). Reference: the old path, sliced at the asked size.

const SIZES: [string | undefined, number][] = [
  ['10', 10], ['20', 20], ['50', 50], [undefined, 20], ['100', 50], ['0', 20], ['x', 20], ['7', 7],
];

describe('queue and «Իմ հարցումները» — the page size the screen sends', () => {
  it('the queue: filter × sort × page × pageSize', async () => {
    const { svc } = world();
    const filters = [{}, { status: 'SUBMITTED' }, { q: 'ցեմենտ' }, { sort: 'oldest' }, { unitId: '1' }, { warehouseId: '3', sort: 'oldest' }, { requesterId: '8' }];
    for (const f of filters) {
      for (const [pageSize, size] of SIZES) {
        for (const page of ['1', '2', '3', undefined]) {
          const query = { ...f, page, pageSize };
          const expected = await oldQueue(svc, query, 40, size);
          const actual = await svc.queue(query, { userId: 40 } as any);
          expect({ query, result: plain(actual) }).toEqual({ query, result: plain(expected) });
        }
      }
    }
  });

  it('«Իմ հարցումները»: filter × page × pageSize, for each requester', async () => {
    const { svc } = world();
    for (const userId of USERS) {
      for (const f of [{}, { status: 'IN_PROGRESS' }, { kind: 'STOCK' }]) {
        for (const [pageSize, size] of SIZES) {
          for (const page of ['1', '2']) {
            const query = { ...f, page, pageSize };
            const expected = await oldMine(svc, userId, query, size);
            const actual = await svc.mine(userId, query);
            expect({ userId, query, result: plain(actual) }).toEqual({ userId, query, result: plain(expected) });
          }
        }
      }
    }
  });

  it('pages of 10 walk the whole list once: no repeated rows, no empty last page', async () => {
    const { svc } = world();
    for (const f of [{}, { status: 'SUBMITTED' }]) {
      const first = await svc.queue({ ...f, page: '1', pageSize: '10' }, { userId: 40 } as any);
      const seen: number[] = [];
      for (let p = 1; p <= Math.ceil(first.total / 10); p++) {
        const res = await svc.queue({ ...f, page: String(p), pageSize: '10' }, { userId: 40 } as any);
        expect(res.items.length).toBeGreaterThan(0);
        expect(res.items.length).toBeLessThanOrEqual(10);
        seen.push(...res.items.map((v) => v.id));
      }
      expect(seen).toHaveLength(first.total);
      expect(new Set(seen).size).toBe(first.total);
    }
  });

  it('the database path reads exactly the asked page', async () => {
    const { svc, prisma } = world();
    await svc.queue({ page: '2', pageSize: '50' }, { userId: 40 } as any);
    expect(prisma.catalogSubmission.findMany.mock.calls[0][0]).toMatchObject({ skip: 50, take: 50 });
  });
});
