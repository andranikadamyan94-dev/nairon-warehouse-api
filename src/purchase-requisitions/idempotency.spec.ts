import { BadRequestException, ConflictException } from '@nestjs/common';

import { OperationsService } from '../common/operations/operations.service';
import { PurchaseRequisitionsController } from './purchase-requisitions.controller';
import { CREATE_PERMISSION, PurchaseRequisitionsService } from './purchase-requisitions.service';

/**
 * POST /purchase-requisitions with an `Idempotency-Key` — "file this, once".
 *
 * A confirmation retried after its answer went missing, a proxy that repeats a
 * 502, a second click: each would otherwise put a second requisition in front
 * of the organization's approvers. These run the real controller, the real
 * PurchaseRequisitionsService and the real OperationsService over a stand-in
 * database that keeps the operations table and the requisitions filed, so the
 * whole route's behaviour is pinned, not a mock's. Concurrency proper is
 * scripts/idempotency-e2e.mjs's question, against real Postgres.
 */

const REQUESTER = 39;
const COLLEAGUE = 41;
const ENTITY = 3;
const OTHER_ENTITY = 5;

function world() {
  const operations: any[] = [];
  const requisitions: any[] = [];
  const items = [{ id: 5, name: 'Cement M400', code: 'CEM-400', unit: 'KG', quantity: 120 }];
  const prisma: any = {
    item: { findMany: jest.fn(async ({ where }: any) => items.filter((i) => where.id.in.includes(i.id))) },
    resourceReservation: { count: jest.fn(async () => 0) },
    procurementOrderItem: { findMany: jest.fn(async () => []) },
    purchaseRequisition: {
      create: jest.fn(async () => {
        throw new Error('filed outside the transaction that records the operation');
      }),
      findUnique: jest.fn(async () => null),
    },
    writeOperation: operationsTable(operations),
  };
  // The transaction hands out its own client; only through it may the requisition be filed.
  const tx: any = {
    ...prisma,
    purchaseRequisition: {
      create: jest.fn(async ({ data, include }: any) => {
        const { lines, ...fields } = data;
        const row = {
          id: 200 + requisitions.length,
          ...fields,
          createdAt: new Date('2026-09-30T08:00:00Z'),
          lines: lines.create.map((l: any, i: number) => ({ id: i + 1, ...l, item: items.find((it) => it.id === l.itemId) ?? null })),
          ...(include?.comments ? { comments: [] } : {}),
          ...(include?.attachments ? { attachments: [] } : {}),
          ...(include?.order ? { order: null } : {}),
        };
        requisitions.push(row);
        return row;
      }),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(tx));
  const usersPrisma: any = {
    getUserAccessInfo: jest.fn(async (_userId: number, entityId = 0) => ({
      isSuperAdmin: false,
      isGlobalSuperAdmin: false,
      permissionNames: [ENTITY, OTHER_ENTITY].includes(entityId) ? [CREATE_PERMISSION] : [],
    })),
    getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id, firstName: 'Անի', lastName: `#${id}` }))),
  };
  const svc = new PurchaseRequisitionsService(prisma, usersPrisma, {} as any);
  const controller = new PurchaseRequisitionsController(svc, new OperationsService(prisma));
  return { controller, prisma, tx, operations, requisitions };
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
  title: 'Հիմքի բետոնացում',
  lines: [
    { itemId: 5, quantity: 40 },
    { itemName: 'Ամրան Ø12', unit: 'M', quantity: 300 },
  ],
  ...over,
});

// AuthGuard parks the resolved actor on the request; the service is the gate.
const request = (opts: { userId?: number; entityId?: number } = {}) => {
  const userId = opts.userId ?? REQUESTER;
  const entityId = opts.entityId ?? ENTITY;
  return {
    user: { id: userId },
    headers: { 'x-entity-id': String(entityId) },
    actor: { userId, declared: entityId, isSuperAdmin: false, isGlobalSuperAdmin: false, permissionNames: [], home: { wildcard: true, entityIds: [] } },
  };
};

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('purchase requisitions · create is carried out once per Idempotency-Key', () => {
  it('files once and answers the retry with the same requisition', async () => {
    const w = world();
    const first = await w.controller.create(body(), request(), 'confirm-7f3a');
    const again = await w.controller.create(body(), request(), 'confirm-7f3a');

    expect(w.requisitions).toHaveLength(1);
    expect(w.tx.purchaseRequisition.create).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ entityId: ENTITY, status: 'PENDING_APPROVAL', createdBy: REQUESTER, createdByName: `Անի #${REQUESTER}` });
    expect(again).toEqual(json(first));
    expect(w.operations).toEqual([
      expect.objectContaining({ key: 'confirm-7f3a', route: 'POST /purchase-requisitions', status: 'SUCCEEDED', resourceId: first.id, userId: REQUESTER, entityId: ENTITY }),
    ]);
  });

  it('refuses the same key with a different body as a conflict, and files nothing more', async () => {
    const w = world();
    await w.controller.create(body(), request(), 'k-1');
    await expect(w.controller.create(body({ title: 'Այլ հայտ' }), request(), 'k-1')).rejects.toBeInstanceOf(ConflictException);
    await expect(w.controller.create(body({ draft: true }), request(), 'k-1')).rejects.toBeInstanceOf(ConflictException);
    expect(w.requisitions).toHaveLength(1);
  });

  it('counts the organization as part of the intent — the same key for another one is a conflict, not a replay', async () => {
    const w = world();
    await w.controller.create(body(), request({ entityId: ENTITY }), 'k-1');
    await expect(w.controller.create(body(), request({ entityId: OTHER_ENTITY }), 'k-1')).rejects.toBeInstanceOf(ConflictException);
    expect(w.requisitions).toHaveLength(1);
    expect(w.requisitions[0].entityId).toBe(ENTITY);
  });

  it('will not replay one person\'s requisition to somebody else holding their key', async () => {
    const w = world();
    await w.controller.create(body(), request(), 'k-1');
    await expect(w.controller.create(body(), request({ userId: COLLEAGUE }), 'k-1')).rejects.toBeInstanceOf(ConflictException);
    expect(w.requisitions).toHaveLength(1);
  });

  it('releases the key when the requisition is refused, so the corrected retry files', async () => {
    const w = world();
    await expect(
      w.controller.create(body({ periodStart: '2026-10-10', periodEnd: '2026-10-01' }), request(), 'k-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(w.operations).toEqual([]);

    await w.controller.create(body(), request(), 'k-1');
    expect(w.requisitions).toHaveLength(1);
  });

  it('keeps working without a key, exactly as before — every call files', async () => {
    const w = world();
    await w.controller.create(body(), request());
    await w.controller.create(body(), request());
    expect(w.requisitions).toHaveLength(2);
    expect(w.operations).toEqual([]);
  });

  it('files through the transaction that records the operation, and reads the row back through it', async () => {
    const w = world();
    await w.controller.create(body(), request(), 'k-1');
    expect(w.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(w.prisma.purchaseRequisition.create).not.toHaveBeenCalled();
    // Outside the transaction the new row is not visible yet; nothing may look for it there.
    expect(w.prisma.purchaseRequisition.findUnique).not.toHaveBeenCalled();
  });
});
