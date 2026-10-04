import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';
import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

/**
 * Procurement is not held to the organisation acted in — the warehouse is
 * global (owner decision 2026-10-05, undoing the 2026-10-02 organisation
 * scoping of d464cd5 / 7fcb8c9). The route guards still ask for the
 * procurement rights, and the service still applies its own rules: a settled
 * order yields to a super-admin only, re-filing is super-admin only, and
 * approvers are checked by assertMayApprove.
 *
 * Order 1 is filed under organisation 3; order 2 under 9, pending approval;
 * order 3 under none; order 4 under 9 and received (settled).
 */
const ORDERS: Record<number, any> = {
  1: { id: 1, entityId: 3, status: 'DRAFT', supplier: { name: 'A' }, items: [{ unitPrice: 10 }] },
  2: { id: 2, entityId: 9, status: 'PENDING_APPROVAL', supplier: { name: 'B' }, items: [{ unitPrice: 20 }] },
  3: { id: 3, entityId: null, status: 'DRAFT', supplier: { name: 'C' }, items: [] },
  4: { id: 4, entityId: 9, status: 'RECEIVED', supplier: { name: 'D' }, items: [{ unitPrice: 30 }] },
};

const prismaWith = () => ({
  procurementOrder: {
    findUnique: jest.fn(async ({ where }: any) => ORDERS[where.id] ?? null),
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    update: jest.fn(async ({ where, data }: any) => ({ ...ORDERS[where.id], ...data })),
  },
});

const build = () => {
  const prisma: any = prismaWith();
  const service = new ProcurementService(prisma, {} as any, {} as any, {} as any, {} as any);
  return { controller: new ProcurementController(service), service, prisma };
};

describe('GET /procurement/:id — any order, whichever organisation it is filed under', () => {
  it("opens another organisation's pending order to an approver acting elsewhere: the handler reads no organisation", async () => {
    // Acting in organisation 3 (X-Entity-ID: 3) — the handler takes the id alone, so the header cannot narrow it.
    expect(ProcurementController.prototype.findOne.length).toBe(1);
    await expect(build().controller.findOne(2)).resolves.toMatchObject({
      id: 2,
      entityId: 9,
      status: 'PENDING_APPROVAL',
      supplier: { name: 'B' },
    });
  });

  it('opens an order filed under none, and one filed under an organisation with none declared', async () => {
    const { controller } = build();
    await expect(controller.findOne(3)).resolves.toMatchObject({ id: 3 });
    await expect(controller.findOne(1)).resolves.toMatchObject({ id: 1, entityId: 3 });
  });

  it('a missing order is still not found', async () => {
    await expect(build().controller.findOne(404)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still needs a procurement read right (route guard)', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, ProcurementController.prototype.findOne)).toEqual(
      expect.arrayContaining(['view_procurement', 'manage_procurement', 'approve_purchase_order']),
    );
  });

  it("leaves finance's internal read alone: any order, behind the internal secret", async () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ProcurementController.prototype.findOneInternal)).toBe(true);
    await expect(build().controller.findOneInternal(2)).resolves.toMatchObject({ id: 2, entityId: 9 });
  });
});

describe('GET /procurement — the list', () => {
  const listWith = async (query: any = {}) => {
    const { controller, prisma } = build();
    await controller.findAll(query);
    return prisma.procurementOrder.findMany.mock.calls[0][0].where;
  };

  it("reads no organisation: every organisation's orders, with no entityId condition", async () => {
    expect(ProcurementController.prototype.findAll.length).toBe(1);
    expect(await listWith()).toEqual({});
  });

  it("keeps the client's own filters, and only those", async () => {
    const where = await listWith({ search: 'cement', status: 'DRAFT', supplierId: '7' });
    expect(where.status).toBe('DRAFT');
    expect(where.supplierId).toBe(7);
    expect(where.OR).toHaveLength(2);
    expect(where.AND).toBeUndefined();
    expect(JSON.stringify(where)).not.toContain('entityId');
  });
});

describe('procurement changes by id — no organisation check before the service', () => {
  /** Each change, with the arguments its route takes; the service behind is a stub that records the call. */
  const CHANGES: [string, (c: ProcurementController, id: number) => Promise<unknown>][] = [
    ['PATCH :id', (c, id) => c.update(id, {} as any, { isSuperAdmin: false }, 1)],
    ['PATCH :id/entity', (c, id) => c.setEntity(id, null, { isSuperAdmin: true })],
    ['PATCH :id/order', (c, id) => c.markOrdered(id)],
    ['PATCH :id/cancel', (c, id) => c.cancel(id, {}, { user: { id: 1 } })],
    ['POST :id/finalize', (c, id) => c.finalize(id, { user: { id: 1 } })],
    ['POST :id/approve', (c, id) => c.approve(id, { user: { id: 1 } })],
    ['POST :id/reject-approval', (c, id) => c.rejectApproval(id, { reason: 'x' }, { user: { id: 1 } })],
    ['POST :id/resubmit', (c, id) => c.resubmit(id)],
    ['PATCH :id/amend', (c, id) => c.amend(id, {} as any, 1)],
    ['DELETE :id', (c, id) => c.remove(id)],
  ];

  const stubbed = () => {
    const prisma: any = prismaWith();
    const service = new ProcurementService(prisma, {} as any, {} as any, {} as any, {} as any);
    const done = jest.fn(async () => 'changed');
    for (const m of ['update', 'setEntity', 'confirmOrdered', 'cancel', 'finalize', 'approve', 'rejectApproval', 'resubmit', 'amend', 'remove']) {
      (service as any)[m] = done;
    }
    return { controller: new ProcurementController(service), done, prisma };
  };

  it.each(CHANGES)("%s: another organisation's order reaches the service, nothing looked up first", async (_route, call) => {
    const { controller, done, prisma } = stubbed();
    await expect(call(controller, 2)).resolves.toBe('changed');
    expect(done).toHaveBeenCalledTimes(1);
    expect((done.mock.calls[0] as unknown[])[0]).toBe(2);
    expect(prisma.procurementOrder.findUnique).not.toHaveBeenCalled();
  });

  it('the organisation checks of 2026-10-02 are gone from the service', () => {
    expect((ProcurementService.prototype as any).assertInActiveOrg).toBeUndefined();
    expect((ProcurementService.prototype as any).findOneFor).toBeUndefined();
  });

  it('receiving keeps its signatures: receive and close-short', () => {
    expect(ProcurementController.prototype.receive.length).toBe(4);
    expect(ProcurementController.prototype.closeShort.length).toBe(2);
  });
});

describe("a super-admin acting in organisation 3 on organisation 9's settled order", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.FINANCE_API_URL = 'http://finance.test';
    process.env.INTERNAL_SECRET = 's3cret';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...env };
  });

  it('re-files it (PATCH :id/entity): the service applies the super-admin rule, not the organisation', async () => {
    const { controller, prisma } = build();
    const finance = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ moved: [1], movedBooked: [1] }) } as any);
    const res = await controller.setEntity(4, 3, { isSuperAdmin: true });
    expect(prisma.procurementOrder.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 4 }, data: { entityId: 3 } }));
    expect(res).toMatchObject({ id: 4, entityId: 3, financeMovedBooked: [1] });
    expect(finance).toHaveBeenCalledTimes(1);
  });

  it('re-filing is still refused to somebody who is not a super-admin (the rule that stays)', async () => {
    const { controller, prisma } = build();
    await expect(controller.setEntity(4, 3, { isSuperAdmin: false })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.procurementOrder.update).not.toHaveBeenCalled();
  });

  it('corrects it (PATCH :id): a settled order yields to the super-admin flag alone', async () => {
    const { controller, service } = build();
    const override = jest.spyOn(service as any, 'overrideSettled').mockResolvedValue({ id: 4, corrected: true });
    await expect(controller.update(4, { notes: 'invoice' } as any, { isSuperAdmin: true }, 1)).resolves.toEqual({ id: 4, corrected: true });
    expect(override).toHaveBeenCalledWith(expect.objectContaining({ id: 4, entityId: 9, status: 'RECEIVED' }), { notes: 'invoice' }, 1);
    await expect(controller.update(4, { notes: 'invoice' } as any, { isSuperAdmin: false }, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('amends its prices (PATCH :id/amend): the handler hands the id straight to the service', async () => {
    const { controller, service } = build();
    const amend = jest.spyOn(service, 'amend').mockResolvedValue({ id: 4, amended: true } as any);
    await expect(controller.amend(4, { items: [] } as any, 1)).resolves.toEqual({ id: 4, amended: true });
    expect(amend).toHaveBeenCalledWith(4, { items: [] }, 1);
  });
});
