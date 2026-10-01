import { HttpException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { StockRequestsController } from './stock-requests.controller';
import { StockRequestsService } from './stock-requests.service';

/**
 * POST /stock-requests/:id/preflight/cancel (2026-10-01, coverage gaps batch
 * 4): «Չեղարկել» one's own pending «Ներքին հայտ». cancel()'s own check, so it
 * answers as the mutation does for the requester; one rule more — only the
 * person who filed it (an administrator stays on the screen). Writes nothing.
 */

const outcome = async (attempt: () => Promise<unknown> | unknown) => {
  try {
    await attempt();
    return 'ok';
  } catch (e) {
    if (e instanceof HttpException) return `${e.getStatus()} ${JSON.stringify(e.getResponse())}`;
    throw e;
  }
};

const ME = 39;
const COLLEAGUE = 40;
const T0 = new Date('2026-09-30T08:00:00Z');

function world() {
  const writes: string[] = [];
  const rows: any[] = [
    { id: 1, warehouseId: 3, status: 'PENDING', comment: 'Շաբաթվա համար', createdBy: ME, createdAt: T0 },
    { id: 2, warehouseId: 3, status: 'APPROVED', comment: null, createdBy: ME, createdAt: T0 },
    { id: 3, warehouseId: 3, status: 'PENDING', comment: null, createdBy: COLLEAGUE, createdAt: T0 },
  ];
  const lines: Record<number, any[]> = {
    1: [
      { id: 11, itemId: 5, quantity: 40, item: { id: 5, name: 'Ցեմենտ M400', unit: 'KG' } },
      { id: 12, itemId: 6, quantity: 2, item: { id: 6, name: 'Դրել', unit: 'PIECE' } },
    ],
  };
  const prisma: any = {
    stockRequest: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) return null;
        return include ? { ...r, warehouse: { id: 3, name: 'Սյունար օբյեկտ', code: 'SYU-1' }, items: lines[r.id] ?? [] } : { ...r };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        writes.push(`stockRequest.updateMany ${where.id} ${data.status}`);
        const r = rows.find((x) => x.id === where.id && x.status === where.status);
        if (r) r.status = data.status;
        return { count: r ? 1 : 0 };
      }),
    },
  };
  const svc = new StockRequestsService(prisma, {} as any, {} as any, {} as any);
  const controller = new StockRequestsController(svc, {} as any);
  return { controller, rows, writes };
}

const req = (userId: number, isSuperAdmin = false) => ({ user: { id: userId }, isSuperAdmin });

it('sits beside PATCH :id/cancel, unguarded like it', () => {
  const proto = StockRequestsController.prototype as any;
  expect(Reflect.getMetadata(PATH_METADATA, proto.preflightCancel)).toBe(':id/preflight/cancel');
  expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.preflightCancel)).toEqual(Reflect.getMetadata(PERMISSIONS_KEY, proto.cancel));
});

it.each([
  ['one\'s own, pending', ME, 1],
  ['one\'s own, already approved', ME, 2],
  ['somebody else\'s', ME, 3],
  ['one that does not exist', ME, 404],
])('%s: the preflight answers as the mutation does', async (_, as, id) => {
  expect(await outcome(() => world().controller.preflightCancel(id, req(as)))).toBe(await outcome(() => world().controller.cancel(id, req(as))));
});

it('answers the request as the card shows it, pinned to its status, lines and comment; writes nothing', async () => {
  const w = world();
  const answer = await w.controller.preflightCancel(1, req(ME));
  expect(answer).toMatchObject({ ...PREFLIGHT_OK, from: 'PENDING', to: 'CANCELLED' });
  expect(answer.request).toEqual({
    id: 1,
    warehouse: { id: 3, name: 'Սյունար օբյեկտ', code: 'SYU-1' },
    comment: 'Շաբաթվա համար',
    createdAt: T0.toISOString(),
    items: [
      { itemId: 5, itemName: 'Ցեմենտ M400', unit: 'KG', quantity: 40 },
      { itemId: 6, itemName: 'Դրել', unit: 'PIECE', quantity: 2 },
    ],
    material: { requestId: 1, status: 'PENDING', createdBy: ME, warehouseId: 3, comment: 'Շաբաթվա համար', lines: [[5, 40], [6, 2]] },
  });
  expect(w.writes).toEqual([]);
});

it('own only: an administrator withdrawing somebody else\'s stays on the screen', async () => {
  expect(await outcome(() => world().controller.preflightCancel(3, req(COLLEAGUE + 100, true)))).toMatch(/^403 /);
  expect(await outcome(() => world().controller.cancel(3, req(COLLEAGUE + 100, true)))).toBe('ok');
});

it('a yes grants nothing: approved in between, the mutation refuses', async () => {
  const w = world();
  expect(await outcome(() => w.controller.preflightCancel(1, req(ME)))).toBe('ok');
  w.rows[0].status = 'APPROVED';
  expect(await outcome(() => w.controller.cancel(1, req(ME)))).toMatch(/^400 /);
});
