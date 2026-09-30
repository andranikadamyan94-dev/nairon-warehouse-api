import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { WarehousesService } from '../warehouses/warehouses.service';
import { StockRequestsController } from './stock-requests.controller';
import { StockRequestsService } from './stock-requests.service';

/**
 * POST /stock-requests/preflight/create — "could this person ask main for
 * these resources, for this warehouse, right now?"
 *
 * Membership is the gate for stock requests, not a route permission; the
 * preflight must ask exactly what create() asks — a PROJECT warehouse, active,
 * that the caller belongs to, with lines that hold — and write nothing. These
 * run the real StockRequestsService and the real WarehousesService membership
 * check over a stand-in database that refuses every write.
 */

const MEMBER = 39;
const OUTSIDER = 40;

function world(opts: { permissionNames?: string[] } = {}) {
  const writes: string[] = [];
  const refuse = (what: string) =>
    jest.fn(async () => {
      writes.push(what);
      throw new Error(`a preflight must not write: ${what}`);
    });
  const warehouses = [
    { id: 1, name: 'Գլխավոր պահեստ', code: 'MAIN', type: 'MAIN', status: 'ACTIVE', responsibleId: null },
    { id: 3, name: 'Սյունար օբյեկտ', code: 'SYU-1', type: 'PROJECT', status: 'ACTIVE', responsibleId: null },
    { id: 4, name: 'Փակված օբյեկտ', code: 'OLD-1', type: 'PROJECT', status: 'ARCHIVED', responsibleId: null },
  ];
  const items = [
    { id: 5, name: 'Cement M400', unit: 'KG', type: 'CONSUMABLE' },
    { id: 6, name: 'Drill', unit: 'PCS', type: 'ASSET' },
  ];
  const prisma: any = {
    warehouse: {
      findUnique: jest.fn(async ({ where }: any) => warehouses.find((w) => w.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) => warehouses.filter((w) => w.responsibleId === where.responsibleId)),
      findFirst: jest.fn(async () => warehouses[0]),
    },
    warehouseEmployee: {
      findMany: jest.fn(async ({ where }: any) =>
        where.userId === MEMBER ? [{ warehouseId: 3 }, { warehouseId: 4 }] : [],
      ),
    },
    item: {
      findMany: jest.fn(async ({ where }: any) => items.filter((i) => where.id.in.includes(i.id))),
    },
    stockRequest: { create: refuse('stockRequest.create'), update: refuse('stockRequest.update') },
    $transaction: refuse('$transaction'),
  };
  const usersPrisma: any = {
    getUserAccessInfo: jest.fn(async () => ({
      isSuperAdmin: false,
      isGlobalSuperAdmin: false,
      permissionNames: opts.permissionNames ?? [],
    })),
  };
  const warehousesService = new WarehousesService(prisma, usersPrisma);
  const svc = new StockRequestsService(prisma, warehousesService, {} as any, usersPrisma);
  const controller = new StockRequestsController(svc);
  return { svc, controller, writes };
}

const body = (over: any = {}) => ({
  warehouseId: 3,
  items: [
    { itemId: 5, quantity: 12.5 },
    { itemId: 6, quantity: 2 },
  ],
  comment: '  շաբաթվա աշխատանքների համար ',
  ...over,
});

// No PermissionGuard runs on these routes, so the request carries no permissionNames.
const as = (userId: number) => ({ user: { id: userId } });

describe('stock requests · preflight/create', () => {
  it('sits beside create with the same (absent) route permission — membership in the service is the gate', () => {
    const proto = StockRequestsController.prototype as any;
    expect(Reflect.getMetadata(PATH_METADATA, proto.preflightCreate)).toBe('preflight/create');
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.preflightCreate)).toEqual(
      Reflect.getMetadata(PERMISSIONS_KEY, proto.create),
    );
  });

  it('answers PREFLIGHT_OK for a member, with the warehouse and each line named, and writes nothing', async () => {
    const w = world();
    const out = await w.controller.preflightCreate(body(), as(MEMBER));
    expect(out).toMatchObject(PREFLIGHT_OK);
    expect(out.request).toEqual({
      warehouse: { id: 3, name: 'Սյունար օբյեկտ', code: 'SYU-1' },
      comment: 'շաբաթվա աշխատանքների համար',
      items: [
        { itemId: 5, itemName: 'Cement M400', unit: 'KG', quantity: 12.5 },
        { itemId: 6, itemName: 'Drill', unit: 'PCS', quantity: 2 },
      ],
    });
    expect(w.writes).toEqual([]);
  });

  it('refuses somebody who does not belong to the warehouse, as create does', async () => {
    const w = world();
    await expect(w.controller.preflightCreate(body(), as(OUTSIDER))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.controller.create(body(), as(OUTSIDER))).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.writes).toEqual([]);
  });

  it('lets warehouse-wide staff through without a membership row', async () => {
    const w = world({ permissionNames: ['manage_warehouse'] });
    await expect(w.controller.preflightCreate(body(), as(OUTSIDER))).resolves.toMatchObject(PREFLIGHT_OK);
  });

  it.each([
    ['a warehouse that does not exist', { warehouseId: 404 }, NotFoundException],
    ['the MAIN warehouse', { warehouseId: 1 }, BadRequestException],
    ['an archived project warehouse', { warehouseId: 4 }, BadRequestException],
    ['no lines', { items: [] }, BadRequestException],
    ['a zero quantity', { items: [{ itemId: 5, quantity: 0 }] }, BadRequestException],
    ['the same item twice', { items: [{ itemId: 5, quantity: 1 }, { itemId: 5, quantity: 2 }] }, BadRequestException],
    ['an item that does not exist', { items: [{ itemId: 404, quantity: 1 }] }, NotFoundException],
    ['half an asset', { items: [{ itemId: 6, quantity: 1.5 }] }, BadRequestException],
  ])('refuses %s exactly as create would', async (_label, over, error) => {
    const w = world();
    await expect(w.controller.preflightCreate(body(over), as(MEMBER))).rejects.toBeInstanceOf(error);
    await expect(w.controller.create(body(over), as(MEMBER))).rejects.toBeInstanceOf(error);
    expect(w.writes).toEqual([]);
  });
});
