import { NotFoundException } from '@nestjs/common';

import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';
import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

/**
 * GET /procurement/:id (org sweep 2026-10-02, hole 6). It answered any order —
 * supplier, lines, prices — to a procurement right holder of any organisation.
 *
 * Order 1 is filed under organisation 3, order 2 under 9, order 3 under none.
 */
const ORDERS: Record<number, any> = {
  1: { id: 1, entityId: 3, supplier: { name: 'A' }, items: [{ unitPrice: 10 }] },
  2: { id: 2, entityId: 9, supplier: { name: 'B' }, items: [{ unitPrice: 20 }] },
  3: { id: 3, entityId: null, supplier: { name: 'C' }, items: [] },
};

const build = () => {
  const prisma: any = { procurementOrder: { findUnique: jest.fn(async ({ where }: any) => ORDERS[where.id] ?? null) } };
  const service = new ProcurementService(prisma, {} as any, {} as any, {} as any, {} as any);
  return new ProcurementController(service);
};

const acting = (declared: number | null) => ({ declared }) as any;

describe('GET /procurement/:id — only the organisation acted in', () => {
  it('shows an order filed under the organisation the caller acts in', async () => {
    await expect(build().findOne(1, acting(3))).resolves.toMatchObject({ id: 1, supplier: { name: 'A' } });
  });

  it("is not found for another organisation's order", async () => {
    await expect(build().findOne(2, acting(3))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is not found for an order filed under an organisation when none is declared', async () => {
    await expect(build().findOne(1, acting(null))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps showing an order filed under no organisation, as the requisition read does', async () => {
    await expect(build().findOne(3, acting(3))).resolves.toMatchObject({ id: 3 });
    await expect(build().findOne(3, acting(null))).resolves.toMatchObject({ id: 3 });
  });

  it('missing and refused read the same', async () => {
    const missing = await build().findOne(404, acting(3)).catch((e) => e);
    const refused = await build().findOne(2, acting(3)).catch((e) => e);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(refused.message).toBe(missing.message);
  });

  it('still needs a procurement read right (route guard)', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, ProcurementController.prototype.findOne)).toEqual(
      expect.arrayContaining(['view_procurement', 'manage_procurement']),
    );
  });

  it("leaves finance's internal read alone: any order, behind the internal secret", async () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ProcurementController.prototype.findOneInternal)).toBe(true);
    await expect(build().findOneInternal(2)).resolves.toMatchObject({ id: 2, entityId: 9 });
  });
});

describe('GET /procurement — the list, in an organisation', () => {
  const listWith = async (declared: number | null, query: any = {}) => {
    const prisma: any = {
      procurementOrder: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    };
    const controller = new ProcurementController(new ProcurementService(prisma, {} as any, {} as any, {} as any, {} as any));
    await controller.findAll(query, acting(declared));
    return prisma.procurementOrder.findMany.mock.calls[0][0].where;
  };

  it("holds the organisation's orders and the ones filed under none", async () => {
    expect(await listWith(3)).toEqual({ AND: [{ OR: [{ entityId: 3 }, { entityId: null }] }] });
  });

  it('keeps the search alongside it, not instead of it', async () => {
    const where = await listWith(3, { search: 'cement', status: 'DRAFT' });
    expect(where.AND).toEqual([{ OR: [{ entityId: 3 }, { entityId: null }] }]);
    expect(where.OR).toHaveLength(2);
    expect(where.status).toBe('DRAFT');
  });

  it('is every order with no organisation sent (the warehouse client)', async () => {
    expect(await listWith(null)).toEqual({});
  });
});

describe('procurement changes by id — the organisation acted in', () => {
  /** Each change, with the arguments its route takes; the service behind is a stub that records the call. */
  const CHANGES: [string, (c: ProcurementController, id: number, a: any) => Promise<unknown>][] = [
    ['PATCH :id', (c, id, a) => c.update(id, {} as any, { isSuperAdmin: false }, a, 1)],
    ['PATCH :id/entity', (c, id, a) => c.setEntity(id, null, { isSuperAdmin: true }, a)],
    ['PATCH :id/order', (c, id, a) => c.markOrdered(id, a)],
    ['PATCH :id/cancel', (c, id, a) => c.cancel(id, {}, { user: { id: 1 } }, a)],
    ['POST :id/finalize', (c, id, a) => c.finalize(id, { user: { id: 1 } }, a)],
    ['POST :id/approve', (c, id, a) => c.approve(id, { user: { id: 1 } }, a)],
    ['POST :id/reject-approval', (c, id, a) => c.rejectApproval(id, { reason: 'x' }, { user: { id: 1 } }, a)],
    ['POST :id/resubmit', (c, id, a) => c.resubmit(id, a)],
    ['PATCH :id/amend', (c, id, a) => c.amend(id, {} as any, a, 1)],
    ['DELETE :id', (c, id, a) => c.remove(id, a)],
  ];

  const stubbed = () => {
    const prisma: any = { procurementOrder: { findUnique: jest.fn(async ({ where }: any) => ORDERS[where.id] ?? null) } };
    const service = new ProcurementService(prisma, {} as any, {} as any, {} as any, {} as any);
    const done = jest.fn(async () => 'changed');
    for (const m of ['update', 'setEntity', 'confirmOrdered', 'cancel', 'finalize', 'approve', 'rejectApproval', 'resubmit', 'amend', 'remove']) {
      (service as any)[m] = done;
    }
    return { controller: new ProcurementController(service), done };
  };

  it.each(CHANGES)("%s: another organisation's order is not found, and nothing changes", async (_route, call) => {
    const { controller, done } = stubbed();
    await expect(call(controller, 2, acting(3))).rejects.toBeInstanceOf(NotFoundException);
    expect(done).not.toHaveBeenCalled();
  });

  it.each(CHANGES)('%s: the organisation\'s own order, and one filed under none, go through', async (_route, call) => {
    const { controller, done } = stubbed();
    await expect(call(controller, 1, acting(3))).resolves.toBe('changed');
    await expect(call(controller, 3, acting(3))).resolves.toBe('changed');
    expect(done).toHaveBeenCalledTimes(2);
  });

  it.each(CHANGES)('%s: with no organisation sent (the warehouse client) nothing changes', async (_route, call) => {
    const { controller } = stubbed();
    await expect(call(controller, 2, acting(null))).resolves.toBe('changed');
  });

  it('receiving stays the shared warehouse\'s: receive and close-short take no organisation', () => {
    // Their handlers keep their old signatures — no actor to check.
    expect(ProcurementController.prototype.receive.length).toBe(4);
    expect(ProcurementController.prototype.closeShort.length).toBe(2);
  });
});
