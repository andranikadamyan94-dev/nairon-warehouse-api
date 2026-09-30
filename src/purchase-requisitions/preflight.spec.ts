import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { PurchaseRequisitionsController } from './purchase-requisitions.controller';
import { CREATE_PERMISSION, PurchaseRequisitionsService } from './purchase-requisitions.service';

/**
 * POST /purchase-requisitions/preflight/create — "could this person file this
 * requisition, right now?"
 *
 * The assistant draws a confirmation card only after the owning service says
 * yes. The answer must come from the SAME checks create() runs — the right to
 * file in the active organization, the lines, the period — and must write
 * nothing. These run the real service over a stand-in database that refuses
 * every write.
 */

const REQUESTER = 39;
const ENTITY = 3;

/**
 * No key is sent here, so OperationsService would only open a transaction
 * around the call — and this stand-in database refuses transactions. Run the
 * work directly; what keys do is pinned in idempotency.spec.ts.
 */
const direct = (prisma: any): any => ({
  runOnce: async (_input: unknown, work: (tx: any) => Promise<unknown>) => ({ result: await work(prisma), replayed: false }),
});

function world(opts: { grants?: Record<number, string[]>; superAdmin?: boolean } = {}) {
  const grants = opts.grants ?? { [ENTITY]: [CREATE_PERMISSION] };
  const writes: string[] = [];
  const refuse = (what: string) =>
    jest.fn(async () => {
      writes.push(what);
      throw new Error(`a preflight must not write: ${what}`);
    });
  const items = [
    { id: 5, name: 'Cement M400', code: 'CEM-400', unit: 'KG', quantity: 120 },
    { id: 6, name: 'Drill', code: null, unit: 'PCS', quantity: 2 },
  ];
  const prisma: any = {
    item: { findMany: jest.fn(async ({ where }: any) => items.filter((i) => where.id.in.includes(i.id))) },
    resourceReservation: { count: jest.fn(async ({ where }: any) => where.id.in.filter((id: number) => id === 77).length) },
    procurementOrderItem: { findMany: jest.fn(async () => [{ itemId: 5, quantity: 50, receivedQuantity: 20 }]) },
    purchaseRequisition: { create: refuse('purchaseRequisition.create'), update: refuse('purchaseRequisition.update') },
    purchaseRequisitionLine: { create: refuse('purchaseRequisitionLine.create') },
    $transaction: refuse('$transaction'),
  };
  const usersPrisma: any = {
    getUserAccessInfo: jest.fn(async (_userId: number, entityId = 0) => ({
      isSuperAdmin: !!opts.superAdmin,
      isGlobalSuperAdmin: false,
      permissionNames: grants[entityId] ?? [],
    })),
  };
  const svc = new PurchaseRequisitionsService(prisma, usersPrisma, {} as any);
  const controller = new PurchaseRequisitionsController(svc, direct(prisma));
  return { svc, controller, prisma, usersPrisma, writes };
}

const body = (over: any = {}) => ({
  title: 'Հիմքի բետոնացում',
  lines: [
    { itemId: 5, quantity: 40 },
    { itemName: 'Ամրան Ø12', unit: 'M', quantity: 300, note: 'ըստ նախագծի' },
  ],
  ...over,
});

const request = (entityId: number | null = ENTITY) => ({
  user: { id: REQUESTER },
  headers: entityId ? { 'x-entity-id': String(entityId) } : {},
});

describe('purchase requisitions · preflight/create', () => {
  it('sits beside create on the same unguarded route shape — the service is the gate for both', () => {
    const proto = PurchaseRequisitionsController.prototype as any;
    expect(Reflect.getMetadata(PATH_METADATA, proto.preflightCreate)).toBe('preflight/create');
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.preflightCreate)).toEqual(
      Reflect.getMetadata(PERMISSIONS_KEY, proto.create),
    );
  });

  it('answers PREFLIGHT_OK with the lines as the catalogue resolves them, and writes nothing', async () => {
    const w = world();
    const out = await w.controller.preflightCreate(body(), request());
    expect(out).toMatchObject(PREFLIGHT_OK);
    expect(out.request).toMatchObject({
      entityId: ENTITY,
      status: 'PENDING_APPROVAL',
      title: 'Հիմքի բետոնացում',
      lines: [
        { itemId: 5, itemName: 'Cement M400', code: 'CEM-400', unit: 'KG', quantity: 40, stockQuantity: 120, expectedQuantity: 30 },
        { itemId: null, itemName: 'Ամրան Ø12', unit: 'M', quantity: 300, note: 'ըստ նախագծի', stockQuantity: null },
      ],
    });
    expect(w.writes).toEqual([]);
  });

  it('asks for create_purchase_requisition in the ACTIVE organization, as create does', async () => {
    const w = world();
    await w.controller.preflightCreate(body(), request());
    expect(w.usersPrisma.getUserAccessInfo).toHaveBeenCalledWith(REQUESTER, ENTITY);
  });

  it('says a draft would be a draft', async () => {
    const out = await world().controller.preflightCreate(body({ draft: true }), request());
    expect(out.request.status).toBe('DRAFT');
  });

  it('refuses without an organization, with the sentence create uses', async () => {
    const w = world();
    await expect(w.controller.preflightCreate(body(), request(null))).rejects.toBeInstanceOf(BadRequestException);
    await expect(w.controller.create(body(), request(null))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a person who holds the right only in ANOTHER organization', async () => {
    const w = world({ grants: { 5: [CREATE_PERMISSION] } });
    await expect(w.controller.preflightCreate(body(), request())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.controller.create(body(), request())).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.writes).toEqual([]);
  });

  it('lets a super admin in that organization through', async () => {
    const w = world({ grants: {}, superAdmin: true });
    await expect(w.controller.preflightCreate(body(), request())).resolves.toMatchObject(PREFLIGHT_OK);
  });

  it.each([
    ['no lines', { lines: [] }, BadRequestException],
    ['a zero quantity', { lines: [{ itemId: 5, quantity: 0 }] }, BadRequestException],
    ['a negative quantity', { lines: [{ itemId: 5, quantity: -2 }] }, BadRequestException],
    ['an item that does not exist', { lines: [{ itemId: 404, quantity: 1 }] }, NotFoundException],
    ['a free-text line without a name', { lines: [{ quantity: 1 }] }, BadRequestException],
    ['a reservation that does not exist', { lines: [{ itemId: 5, quantity: 1, reservationId: 78 }] }, NotFoundException],
    ['a period that ends before it starts', { periodStart: '2026-10-10', periodEnd: '2026-10-01' }, BadRequestException],
  ])('refuses %s exactly as create would', async (_label, over, error) => {
    const w = world();
    await expect(w.controller.preflightCreate(body(over), request())).rejects.toBeInstanceOf(error);
    await expect(w.controller.create(body(over), request())).rejects.toBeInstanceOf(error);
    expect(w.writes).toEqual([]);
  });

  it('accepts a line that covers an existing reservation', async () => {
    const out = await world().controller.preflightCreate(
      body({ lines: [{ itemId: 5, quantity: 1, reservationId: 77 }] }),
      request(),
    );
    expect(out.request.lines[0]).toMatchObject({ itemId: 5, reservationId: 77 });
  });
});
