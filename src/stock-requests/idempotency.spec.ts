import { BadRequestException, ConflictException } from '@nestjs/common';

import { OperationsService } from '../common/operations/operations.service';
import { WarehousesService } from '../warehouses/warehouses.service';
import { StockRequestsController } from './stock-requests.controller';
import { StockRequestsService } from './stock-requests.service';

/**
 * POST /stock-requests with an `Idempotency-Key` — "ask main for this, once".
 *
 * A confirmation retried after its answer went missing, a proxy that repeats a
 * 502, a second click: each would otherwise file a second request for the same
 * stock. These run the real controller, the real StockRequestsService and the
 * real OperationsService over a stand-in database that keeps the operations
 * table and the requests it filed, so what is pinned is the whole route's
 * behaviour, not a mock's. What two connections do to each other at the same
 * moment is scripts/idempotency-e2e.mjs's question, against real Postgres.
 */

const MEMBER = 39;
const OTHER_MEMBER = 41;

function world() {
  const operations: any[] = [];
  const requests: any[] = [];
  const warehouses = [{ id: 3, name: 'Սյունար օբյեկտ', code: 'SYU-1', type: 'PROJECT', status: 'ACTIVE', responsibleId: null }];
  const items = [
    { id: 5, name: 'Cement M400', unit: 'KG', type: 'CONSUMABLE' },
    { id: 6, name: 'Drill', unit: 'PCS', type: 'ASSET' },
  ];
  const prisma: any = {
    warehouse: {
      findUnique: jest.fn(async ({ where }: any) => warehouses.find((w) => w.id === where.id) ?? null),
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    warehouseEmployee: {
      findMany: jest.fn(async ({ where }: any) => ([MEMBER, OTHER_MEMBER].includes(where.userId) ? [{ warehouseId: 3 }] : [])),
    },
    item: { findMany: jest.fn(async ({ where }: any) => items.filter((i) => where.id.in.includes(i.id))) },
    stockRequest: {
      create: jest.fn(async () => {
        throw new Error('filed outside the transaction that records the operation');
      }),
    },
    writeOperation: operationsTable(operations),
  };
  // The transaction hands out its own client; only through it may the request be filed.
  const tx: any = {
    ...prisma,
    stockRequest: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: 100 + requests.length,
          warehouseId: data.warehouseId,
          comment: data.comment,
          createdBy: data.createdBy,
          status: 'PENDING',
          createdAt: new Date('2026-09-30T08:00:00Z'),
          items: data.items.create.map((l: any, i: number) => ({ id: i + 1, ...l, item: items.find((it) => it.id === l.itemId) })),
        };
        requests.push(row);
        return row;
      }),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(tx));
  tx.writeOperation = prisma.writeOperation;
  const usersPrisma: any = {
    getUserAccessInfo: jest.fn(async () => ({ isSuperAdmin: false, isGlobalSuperAdmin: false, permissionNames: [] })),
  };
  const svc = new StockRequestsService(prisma, new WarehousesService(prisma, usersPrisma), {} as any, usersPrisma);
  const controller = new StockRequestsController(svc, new OperationsService(prisma));
  return { controller, prisma, tx, operations, requests };
}

/** The operations table as Postgres would keep it: a unique key, JSON results. */
function operationsTable(rows: any[]) {
  let seq = 0;
  return {
    create: jest.fn(async ({ data }: any) => {
      if (rows.some((r) => r.key === data.key)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      const row = { id: ++seq, status: 'IN_FLIGHT', result: null, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    }),
    findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.key === where.key) ?? null),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      Object.assign(row, data, { result: JSON.parse(JSON.stringify(data.result ?? null)) });
      return row;
    }),
    updateMany: jest.fn(async () => ({ count: 0 })),
    deleteMany: jest.fn(async ({ where }: any) => {
      const at = rows.findIndex((r) => r.id === where.id && r.status === where.status);
      if (at >= 0) rows.splice(at, 1);
      return { count: at >= 0 ? 1 : 0 };
    }),
  };
}

const body = (over: any = {}) => ({
  warehouseId: 3,
  items: [
    { itemId: 5, quantity: 12.5 },
    { itemId: 6, quantity: 2 },
  ],
  comment: 'շաբաթվա աշխատանքների համար',
  ...over,
});

// AuthGuard parks the resolved actor on the request; no PermissionGuard runs here.
const as = (userId: number) => ({
  user: { id: userId },
  actor: { userId, declared: null, isSuperAdmin: false, isGlobalSuperAdmin: false, permissionNames: [], home: { wildcard: true, entityIds: [] } },
});

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('stock requests · create is carried out once per Idempotency-Key', () => {
  it('files once and answers the retry with the same request', async () => {
    const w = world();
    const first = await w.controller.create(body(), as(MEMBER), 'confirm-7f3a');
    const again = await w.controller.create(body(), as(MEMBER), 'confirm-7f3a');

    expect(w.requests).toHaveLength(1);
    expect(w.tx.stockRequest.create).toHaveBeenCalledTimes(1);
    expect(again).toEqual(json(first));
    expect(w.operations).toEqual([
      expect.objectContaining({ key: 'confirm-7f3a', route: 'POST /stock-requests', status: 'SUCCEEDED', resourceId: first.id, userId: MEMBER }),
    ]);
  });

  it('treats the same lines in another key order as the same request', async () => {
    const w = world();
    await w.controller.create(body(), as(MEMBER), 'k-1');
    await w.controller.create({ comment: body().comment, items: body().items, warehouseId: 3 }, as(MEMBER), 'k-1');
    expect(w.requests).toHaveLength(1);
  });

  it('refuses the same key with a different body as a conflict, and files nothing more', async () => {
    const w = world();
    await w.controller.create(body(), as(MEMBER), 'k-1');
    await expect(
      w.controller.create(body({ items: [{ itemId: 5, quantity: 13 }] }), as(MEMBER), 'k-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(w.requests).toHaveLength(1);
  });

  it('will not replay one person\'s request to somebody else holding their key', async () => {
    const w = world();
    await w.controller.create(body(), as(MEMBER), 'k-1');
    await expect(w.controller.create(body(), as(OTHER_MEMBER), 'k-1')).rejects.toBeInstanceOf(ConflictException);
    expect(w.requests).toHaveLength(1);
  });

  it('releases the key when the request is refused, so the corrected retry files', async () => {
    const w = world();
    await expect(
      w.controller.create(body({ items: [{ itemId: 5, quantity: 0 }] }), as(MEMBER), 'k-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(w.operations).toEqual([]);

    await w.controller.create(body(), as(MEMBER), 'k-1');
    expect(w.requests).toHaveLength(1);
  });

  it('keeps working without a key, exactly as before — every call files', async () => {
    const w = world();
    await w.controller.create(body(), as(MEMBER));
    await w.controller.create(body(), as(MEMBER));
    expect(w.requests).toHaveLength(2);
    expect(w.operations).toEqual([]);
  });

  it('writes the request inside the transaction that records the operation', async () => {
    const w = world();
    await w.controller.create(body(), as(MEMBER), 'k-1');
    expect(w.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(w.tx.stockRequest.create).toHaveBeenCalledTimes(1);
    expect(w.prisma.stockRequest.create).not.toHaveBeenCalled();
  });
});
