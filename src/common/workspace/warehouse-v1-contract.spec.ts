import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { WarehouseActor } from '../../auth/actor';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import { PERMISSIONS_KEY, PermissionGuard } from '../../auth/guards/permission.guard';
import { AssetsController } from '../../assets/assets.controller';
import { AssetsService } from '../../assets/assets.service';
import { CategoriesController } from '../../categories/categories.controller';
import { CategoriesService } from '../../categories/categories.service';
import { ItemsController } from '../../items/items.controller';
import { ItemsService } from '../../items/items.service';
import { MaintenanceController } from '../../maintenance/maintenance.controller';
import { MaintenanceService } from '../../maintenance/maintenance.service';
import { ReservationsController } from '../../reservations/reservations.controller';
import { ReservationsService } from '../../reservations/reservations.service';
import { ResourceReturnsController } from '../../resource-returns/resource-returns.controller';
import { ResourceReturnsService } from '../../resource-returns/resource-returns.service';
import { ResourceWorkspaceService } from './resource-workspace.service';

/**
 * WAREHOUSE V1 CONTRACT — owner decision 2026-09-16, cases A–H.
 *
 *   READ the shared catalogue   -> every authenticated caller the route admits
 *   WRITE the shared catalogue  -> the existing manage_* permission
 *   WAREHOUSE side              -> existing warehouse permissions, any company
 *   REQUESTER side              -> requesterWorkspaceId, or the CRM task
 *                                  relationship where the operation has one
 *   ResourceReservation.entityId -> never an input
 *
 * These run the real services over a stand-in database shaped like staging:
 * the catalogue is filed under company 1, and nobody but the super admin holds
 * a role there.
 *
 * SERVICE LEVEL vs ROUTE LEVEL. Most cases below are decided in the services.
 * Over HTTP every mutation also passes the controller's PermissionGuard first,
 * and this release does not change a single controller permission — so
 * requester standing in a service never means a person without the route's
 * permission can call the endpoint. The route checks are asserted separately
 * (B, and "service-level standing does not open an HTTP route").
 */

const actor = (over: Partial<WarehouseActor> = {}): WarehouseActor => ({
  userId: 11,
  isSuperAdmin: false,
  isGlobalSuperAdmin: false,
  permissionNames: [],
  home: { wildcard: false, entityIds: [] },
  declared: null,
  ...over,
});

/** An ordinary authenticated user: a role in company 3, no warehouse permission. */
const ordinary3 = actor({ userId: 39, home: { wildcard: false, entityIds: [3] } });
/** An ordinary authenticated user in company 5. */
const ordinary5 = actor({ userId: 32, home: { wildcard: false, entityIds: [5] } });
/** The head of the warehouse: warehouse rights, one role, in company 6. */
const warehouseHead = actor({
  userId: 27,
  permissionNames: [
    'view_warehouse',
    'manage_warehouse',
    'manage_items',
    'manage_categories',
    'manage_assets',
    'manage_maintenance',
    'view_reservations',
    'manage_reservations',
    'view_resource_returns',
    'manage_resource_returns',
  ],
  home: { wildcard: false, entityIds: [6] },
});
/** Narrow warehouse staff in company 6. */
const storekeeper = actor({
  userId: 34,
  permissionNames: ['manage_reservations', 'manage_resource_returns', 'view_reservations'],
  home: { wildcard: false, entityIds: [6] },
});
const superAdmin = actor({ userId: 1, isSuperAdmin: true, isGlobalSuperAdmin: true, home: { wildcard: true, entityIds: [] } });

const EVERYONE = [ordinary3, ordinary5, warehouseHead, storekeeper, superAdmin];

const metadata = (key: string, controller: object, method: string) =>
  Reflect.getMetadata(key, (controller as never)[method]);

/* ------------------------------------------------------------------------ */
/* Catalogue stand-ins                                                       */
/* ------------------------------------------------------------------------ */

function catalogue() {
  const seen: { table: string; op: string; args: any }[] = [];
  const record = (table: string, op: string, result: unknown) => async (args: any) => {
    seen.push({ table, op, args });
    return result;
  };
  const filedUnderOne = { id: 5, name: 'Drill', entityId: 1, category: { entityId: 1 } };
  const prisma: any = {
    item: {
      findMany: record('item', 'findMany', [filedUnderOne]),
      findFirst: record('item', 'findFirst', filedUnderOne),
      findUnique: record('item', 'findUnique', { category: { entityId: 1 } }),
    },
    itemCategory: {
      findMany: record('itemCategory', 'findMany', [{ id: 9, entityId: 1, parentId: null }]),
      findUnique: record('itemCategory', 'findUnique', { id: 9, entityId: 1 }),
      create: record('itemCategory', 'create', { id: 10 }),
    },
    asset: {
      findMany: record('asset', 'findMany', []),
      findFirst: record('asset', 'findFirst', { id: 2 }),
      findUnique: record('asset', 'findUnique', { item: { category: { entityId: 1 } } }),
    },
    maintenanceRecord: {
      findMany: record('maintenanceRecord', 'findMany', []),
      count: record('maintenanceRecord', 'count', 0),
      findFirst: record('maintenanceRecord', 'findFirst', { id: 4 }),
      findUnique: record('maintenanceRecord', 'findUnique', { asset: { item: { category: { entityId: 1 } } } }),
    },
  };
  const workspaces = new ResourceWorkspaceService(prisma);
  const categories = new CategoriesService(prisma, workspaces);
  return {
    seen,
    wheres: (table: string, op: string) => seen.filter((s) => s.table === table && s.op === op).map((s) => s.args.where),
    items: new ItemsService(prisma, categories, { check: () => undefined } as any, workspaces),
    categories,
    assets: new AssetsService(prisma, workspaces),
    maintenance: new MaintenanceService(prisma, workspaces),
  };
}

/* ------------------------------------------------------------------------ */
/* A                                                                         */
/* ------------------------------------------------------------------------ */

describe('A · an ordinary authenticated user reads the shared catalogue, whatever company their role is in', () => {
  it.each([
    ['GET /items', ItemsController.prototype, 'findAll'],
    ['GET /items/:id', ItemsController.prototype, 'findOne'],
    ['GET /categories', CategoriesController.prototype, 'getAll'],
    ['GET /categories/tree', CategoriesController.prototype, 'getTree'],
  ])('%s asks for authentication and no warehouse permission — unchanged', (_route, controller, method) => {
    expect(metadata(PERMISSIONS_KEY, controller, method)).toBeUndefined();
    expect(metadata(IS_PUBLIC_KEY, controller, method)).toBeUndefined();
  });

  it('lists items filed under company 1 for everybody, with the same query for everybody', async () => {
    const c = catalogue();
    for (const who of EVERYONE) {
      await expect(c.items.findAll({} as any, who)).resolves.toEqual([expect.objectContaining({ id: 5 })]);
    }
    const wheres = c.wheres('item', 'findMany');
    expect(wheres).toHaveLength(EVERYONE.length);
    for (const where of wheres) expect(where).toEqual({});
  });

  it('opens one item filed under company 1 for everybody', async () => {
    const c = catalogue();
    for (const who of EVERYONE) await expect(c.items.findOne(5, who)).resolves.toMatchObject({ id: 5 });
    for (const where of c.wheres('item', 'findFirst')) expect(where).toEqual({ id: 5 });
  });

  it('lists and trees categories for everybody, narrowing only when ?entityId= asks', async () => {
    const c = catalogue();
    for (const who of EVERYONE) {
      await c.categories.getAll(undefined, who);
      await c.categories.getTree(undefined, who);
      await c.categories.getAll(4, who);
    }
    const wheres = c.wheres('itemCategory', 'findMany');
    expect(wheres).toHaveLength(EVERYONE.length * 3);
    wheres.forEach((where, i) => expect(where).toEqual(i % 3 === 2 ? { entityId: 4 } : undefined));
  });

  it('adds no company to asset and maintenance reads either — their routes’ view permissions decide', async () => {
    const c = catalogue();
    for (const who of EVERYONE) {
      await c.assets.findAll({}, who);
      await c.assets.findOne(2, who);
      await c.maintenance.getAll({}, who);
      await c.maintenance.getUpcomingMaintenance(who);
      await c.maintenance.getOne(4, who);
    }
    for (const where of c.wheres('asset', 'findMany')) expect(where).toEqual({});
    for (const where of c.wheres('asset', 'findFirst')) expect(where).toEqual({ id: 2 });
    for (const where of c.wheres('maintenanceRecord', 'count')) expect(where).toEqual({});
    for (const where of c.wheres('maintenanceRecord', 'findFirst')) expect(where).toEqual({ id: 4 });
    for (const where of c.wheres('maintenanceRecord', 'findMany')) {
      expect(Object.keys(where ?? {}).filter((k) => k !== 'endDate')).toEqual([]);
    }
    expect(JSON.stringify(c.seen.map((s) => s.args.where))).not.toMatch(/entityId|category/);
  });
});

/* ------------------------------------------------------------------------ */
/* B                                                                         */
/* ------------------------------------------------------------------------ */

function guardFor(who: WarehouseActor) {
  const reflector = { getAllAndOverride: (_k: string, [handler]: unknown[]) => handler } as unknown as Reflector;
  const guard = new PermissionGuard(reflector, { resolve: async () => who } as never);
  return (required: string[]) =>
    guard.canActivate({
      getHandler: () => required,
      getClass: () => required,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: who.userId } }) }),
    } as never);
}

describe('B · nobody changes the catalogue without the existing manage_* permission', () => {
  const mutations: [string, object, string, string][] = [
    ['POST /items', ItemsController.prototype, 'create', 'manage_items'],
    ['POST /items/preflight/create', ItemsController.prototype, 'preflightCreate', 'manage_items'],
    ['POST /items/preflight/update/:id', ItemsController.prototype, 'preflightUpdate', 'manage_items'],
    ['POST /items/preflight/delete/:id', ItemsController.prototype, 'preflightDelete', 'manage_items'],
    ['PATCH /items/:id', ItemsController.prototype, 'update', 'manage_items'],
    ['DELETE /items/:id', ItemsController.prototype, 'remove', 'manage_items'],
    ['POST /categories', CategoriesController.prototype, 'create', 'manage_categories'],
    ['POST /categories/preflight/create', CategoriesController.prototype, 'preflightCreate', 'manage_categories'],
    ['POST /categories/preflight/update/:id', CategoriesController.prototype, 'preflightUpdate', 'manage_categories'],
    ['POST /categories/preflight/delete/:id', CategoriesController.prototype, 'preflightDelete', 'manage_categories'],
    ['PATCH /categories/:id', CategoriesController.prototype, 'update', 'manage_categories'],
    ['DELETE /categories/:id', CategoriesController.prototype, 'remove', 'manage_categories'],
    ['POST /assets', AssetsController.prototype, 'create', 'manage_assets'],
    ['POST /assets/preflight/create', AssetsController.prototype, 'preflightCreate', 'manage_assets'],
    ['POST /assets/preflight/update/:id', AssetsController.prototype, 'preflightUpdate', 'manage_assets'],
    ['POST /assets/preflight/delete/:id', AssetsController.prototype, 'preflightDelete', 'manage_assets'],
    ['PATCH /assets/:id', AssetsController.prototype, 'update', 'manage_assets'],
    ['DELETE /assets/:id', AssetsController.prototype, 'remove', 'manage_assets'],
    ['POST /maintenance', MaintenanceController.prototype, 'createRecord', 'manage_maintenance'],
    ['POST /maintenance/preflight/create', MaintenanceController.prototype, 'preflightCreate', 'manage_maintenance'],
    ['POST /maintenance/preflight/update/:id', MaintenanceController.prototype, 'preflightUpdate', 'manage_maintenance'],
    ['PATCH /maintenance/:id', MaintenanceController.prototype, 'update', 'manage_maintenance'],
    ['POST /maintenance/:id/finalize', MaintenanceController.prototype, 'finalize', 'manage_maintenance'],
    ['POST /maintenance/:id/complete', MaintenanceController.prototype, 'complete', 'manage_maintenance'],
    ['DELETE /maintenance/:id', MaintenanceController.prototype, 'remove', 'manage_maintenance'],
  ];

  it.each(mutations)('%s requires its manage permission and refuses an ordinary user', async (_route, controller, method, permission) => {
    const required = metadata(PERMISSIONS_KEY, controller, method);
    expect(required).toEqual([permission]);
    await expect(guardFor(ordinary3)(required)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guardFor(actor({ permissionNames: ['view_warehouse', 'view_assets', 'view_maintenance'] }))(required),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guardFor(actor({ permissionNames: [permission], home: { wildcard: false, entityIds: [6] } }))(required)).resolves.toBe(true);
  });

  it('lets the permission holder change what is filed under company 1 without a role there', async () => {
    const c = catalogue();
    await expect(c.categories.assertMayEdit(warehouseHead, 9)).resolves.toBeUndefined();
    await expect(c.categories.assertMayCreate(warehouseHead, { entityId: 1, parentId: 9 })).resolves.toBeUndefined();
    await expect(c.items.assertMayEdit(warehouseHead, 5)).resolves.toBeUndefined();
    await expect(c.items.assertMayFileUnder(warehouseHead, 9)).resolves.toBeUndefined();
    await expect(c.items.assertMayFileUnder(warehouseHead, null)).resolves.toBeUndefined();
    await expect(c.assets.assertMayCreateFor(warehouseHead, 5)).resolves.toBeUndefined();
    await expect(c.assets.assertMayEdit(warehouseHead, 2)).resolves.toBeUndefined();
    await expect(c.maintenance.assertMayMaintain(warehouseHead, 2)).resolves.toBeUndefined();
    await expect(c.maintenance.assertMayEdit(warehouseHead, 4)).resolves.toBeUndefined();
  });

  it('files a new category where the request says, or under the schema default — never by the creator’s role', async () => {
    const c = catalogue();
    await c.categories.create({ name: 'Named' } as any, warehouseHead);
    await c.categories.create({ name: 'Filed', entityId: 1 } as any, warehouseHead);
    const created = c.seen.filter((s) => s.table === 'itemCategory' && s.op === 'create').map((s) => s.args.data);
    expect(created[0]).not.toHaveProperty('entityId');
    expect(created[1]).toMatchObject({ entityId: 1 });
  });

  it('still answers 404 for a row that does not exist', async () => {
    const c = catalogue();
    (c.categories as any).prisma.itemCategory.findUnique = async () => null;
    await expect(c.categories.assertMayEdit(warehouseHead, 404)).rejects.toBeInstanceOf(NotFoundException);
  });
});

/* ------------------------------------------------------------------------ */
/* Reservation and return stand-ins                                          */
/* ------------------------------------------------------------------------ */

type Parties = { requester: number | null; stockOwner: number | null };

function reservations(opts: { parties: Parties; requester?: number | null; onTask?: number[]; superAdmins?: number[] }) {
  const onTask = new Set(opts.onTask ?? []);
  const reservationRow = {
    id: 8,
    taskId: 12,
    status: 'APPROVED',
    quantity: 2,
    requesterWorkspaceId: opts.parties.requester,
    // The legacy label, deliberately set to a company that would help or hurt
    // anybody who read it.
    entityId: 3,
    item: { id: 5, type: 'ASSET', name: 'Drill', unit: 'pcs', category: { entityId: opts.parties.stockOwner } },
  };
  const findReservation = jest.fn().mockResolvedValue(reservationRow);
  const prisma: any = {
    resourceReservation: { findUnique: findReservation },
    resourceReturn: {
      findUnique: jest.fn().mockResolvedValue({ id: 2, status: 'RECEIVED', reservationId: 8, reservation: reservationRow }),
      aggregate: async () => ({ _sum: { quantity: 0 } }),
    },
    reservationAllocation: { aggregate: async () => ({ _sum: { quantity: 0 } }) },
    // getOne() also reports the purchase requisition raised for a reservation (bea3fe3); none here.
    purchaseRequisitionLine: { findMany: async () => [] },
  };
  const workspaces: any = {
    partiesOfReservation: async () => opts.parties,
    partiesOfReturn: async () => opts.parties,
  };
  const requesters: any = { forRequest: async () => (opts.requester === undefined ? opts.parties.requester : opts.requester) };
  const usersPrisma: any = {
    getUserAccessInfo: async (userId: number) => ({ isSuperAdmin: (opts.superAdmins ?? []).includes(userId) }),
  };
  const svc = new ReservationsService(prisma, {} as any, {} as any, {} as any, usersPrisma, workspaces, requesters);
  const assertTaskRole = jest.spyOn(svc as any, 'assertTaskRole').mockImplementation(async (_taskId: unknown, userId: unknown) => {
    if (!onTask.has(userId as number)) throw new ForbiddenException('not on the task');
  });
  const isOnTask = jest.spyOn(svc, 'isOnTask');
  const returns = new ResourceReturnsService(prisma, {} as any, workspaces, svc);
  return { svc, returns, prisma, findReservation, assertTaskRole, isOnTask, row: reservationRow };
}

/** Passed authorization and was stopped by the next, unrelated rule. */
const passed = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(BadRequestException);
const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ForbiddenException);
/** Whatever else happened past authorization (the stand-in database is thin), it was not a refusal. */
const notRefused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).not.toBeInstanceOf(ForbiddenException);
  }
};

const WAREHOUSE_ASSERTED = ['reservation.approve', 'reservation.reject', 'reservation.cancel', 'reservation.uncancel'];
const emptyRequest = (entityId?: number) => ({ projectId: 70, taskId: 12, resources: [], ...(entityId ? { entityId } : {}) }) as any;

/* ------------------------------------------------------------------------ */
/* C                                                                         */
/* ------------------------------------------------------------------------ */

describe('C · a warehouse employee in company 6 operates stock filed under company 1', () => {
  const h = () => reservations({ parties: { requester: 3, stockOwner: 1 } });

  it.each(WAREHOUSE_ASSERTED)('%s', async (op) => {
    await expect(h().svc.assertMay(warehouseHead, 8, op)).resolves.toEqual({ requester: 3, stockOwner: 1 });
    await expect(h().svc.assertMay(storekeeper, 8, op)).resolves.toBeDefined();
  });

  it('receives and calls off returns', async () => {
    await passed(h().returns.receive(2, 27, warehouseHead));
    await passed(h().returns.cancel(2, storekeeper));
  });

  it('reads the reservation', async () => {
    await expect(h().svc.assertMayRead(storekeeper, 8)).resolves.toBeUndefined();
  });

  it('while an ordinary user in the requester’s own company cannot do the warehouse’s part', async () => {
    for (const op of ['reservation.approve', 'reservation.reject']) {
      await refused(h().svc.assertMay(ordinary3, 8, op));
    }
    await refused(h().returns.receive(2, 39, ordinary3));
  });
});

/* ------------------------------------------------------------------------ */
/* D                                                                         */
/* ------------------------------------------------------------------------ */

describe('D · a warehouse permission is not requester authority for another company', () => {
  it('refuses the warehouse head asking for, or changing, company 3’s request', async () => {
    const h = reservations({ parties: { requester: 3, stockOwner: 1 } });
    await refused(h.svc.previewCreate(emptyRequest(), warehouseHead));
    await refused(h.svc.previewUpdate(12, emptyRequest(), warehouseHead));
  });

  it('refuses the warehouse head handing goods back as company 3', async () => {
    const h = reservations({ parties: { requester: 3, stockOwner: 1 } });
    await refused(h.returns.previewCreate({ reservationId: 8, quantity: 1 } as any, warehouseHead));
  });

  it('lets them request for company 6, where their role is', async () => {
    const h = reservations({ parties: { requester: 6, stockOwner: 1 } });
    await passed(h.svc.previewCreate(emptyRequest(), warehouseHead));
  });
});

/* ------------------------------------------------------------------------ */
/* E                                                                         */
/* ------------------------------------------------------------------------ */

describe('E · requester-side acts work on authoritative requester or task standing', () => {
  it('lets company 3 ask for company 3’s work, with no warehouse permission', async () => {
    const h = reservations({ parties: { requester: 3, stockOwner: 1 } });
    await passed(h.svc.previewCreate(emptyRequest(), ordinary3));
  });

  it('lets company 3 hand goods back against its own reservation, without asking CRM', async () => {
    const h = reservations({ parties: { requester: 3, stockOwner: 1 } });
    await passed(h.returns.previewCreate({ reservationId: 8, quantity: 1 } as any, ordinary3));
    expect(h.isOnTask).not.toHaveBeenCalled();
  });

  it('keeps accept on the CRM task relationship, as it was — no company involved', async () => {
    const accept = (h: ReturnType<typeof reservations>, userId: number) => {
      h.findReservation.mockReset();
      h.findReservation
        .mockResolvedValueOnce({ ...h.row, item: { ...h.row.item, type: 'CONSUMABLE' } })
        .mockResolvedValueOnce(null);
      return h.svc.accept(8, userId, 1);
    };
    // A task member in company 5 accepts a legacy reservation of unknown requester.
    const member = reservations({ parties: { requester: null, stockOwner: 1 }, onTask: [32] });
    await expect(accept(member, 32)).rejects.toBeInstanceOf(NotFoundException); // past authorization
    expect(member.assertTaskRole).toHaveBeenCalledWith(12, 32);

    // An unrelated user is refused, whatever the old entityId label says.
    const stranger = reservations({ parties: { requester: null, stockOwner: 1 }, onTask: [32] });
    await expect(accept(stranger, 39)).rejects.toBeInstanceOf(ForbiddenException);

    // A super admin is not asked about the task.
    const admin = reservations({ parties: { requester: null, stockOwner: 1 }, superAdmins: [1] });
    await expect(accept(admin, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(admin.assertTaskRole).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ */
/* F                                                                         */
/* ------------------------------------------------------------------------ */

describe('F · a requester from company 3 cannot act as the requester for company 4', () => {
  it('refuses asking for or changing company 4’s work', async () => {
    const h = reservations({ parties: { requester: 4, stockOwner: 1 } });
    await refused(h.svc.previewCreate(emptyRequest(), ordinary3));
    await refused(h.svc.previewUpdate(12, emptyRequest(), ordinary3));
  });

  it('refuses handing goods back against company 4’s reservation — even from the task', async () => {
    const h = reservations({ parties: { requester: 4, stockOwner: 1 }, onTask: [39] });
    await refused(h.returns.previewCreate({ reservationId: 8, quantity: 1 } as any, ordinary3));
    expect(h.isOnTask).not.toHaveBeenCalled();
  });

  it('refuses reading company 4’s reservation without a warehouse permission or the task', async () => {
    const h = reservations({ parties: { requester: 4, stockOwner: 1 } });
    await expect(h.svc.assertMayRead(ordinary3, 8)).rejects.toBeInstanceOf(NotFoundException);
  });
});

/* ------------------------------------------------------------------------ */
/* G                                                                         */
/* ------------------------------------------------------------------------ */

describe('G · a legacy reservation whose requester was never pinned', () => {
  const legacy = { requester: null, stockOwner: 1 };

  it.each(WAREHOUSE_ASSERTED)('still lets warehouse staff %s it', async (op) => {
    await expect(reservations({ parties: legacy }).svc.assertMay(storekeeper, 8, op)).resolves.toEqual(legacy);
  });

  it('still lets warehouse staff receive and call off its returns, and read it', async () => {
    const h = reservations({ parties: legacy });
    await passed(h.returns.receive(2, 34, storekeeper));
    await passed(h.returns.cancel(2, storekeeper));
    await expect(h.svc.assertMayRead(storekeeper, 8)).resolves.toBeUndefined();
  });

  it('lets a member of its CRM task hand goods back — the task is the standing', async () => {
    const h = reservations({ parties: legacy, onTask: [32] });
    await passed(h.returns.previewCreate({ reservationId: 8, quantity: 1 } as any, ordinary5));
    expect(h.isOnTask).toHaveBeenCalledWith(12, 32);
  });

  it('refuses somebody not on the task, although the old entityId label names their company', async () => {
    // The row's entityId is 3 and ordinary3's role is in 3. It must not matter.
    const h = reservations({ parties: legacy, onTask: [32] });
    await refused(h.returns.previewCreate({ reservationId: 8, quantity: 1 } as any, ordinary3));
    await refused(h.svc.assertMay(ordinary3, 8, 'reservation.cancel'));
    await expect(h.svc.assertMayRead(ordinary3, 8)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses warehouse staff acting as its requester, when they are not on the task', async () => {
    const h = reservations({ parties: legacy });
    await refused(h.returns.previewCreate({ reservationId: 8, quantity: 1 } as any, warehouseHead));
  });

  it('never uses a request body’s entityId either way', async () => {
    // Labelled with company 3, project in company 4: the label grants nothing.
    await refused(reservations({ parties: { requester: 4, stockOwner: 1 } }).svc.previewCreate(emptyRequest(3), ordinary3));
    // Labelled with company 4, project in company 3: the label refuses nothing.
    await passed(reservations({ parties: { requester: 3, stockOwner: 1 } }).svc.previewCreate(emptyRequest(4), ordinary3));
    await notRefused(
      reservations({ parties: { requester: 3, stockOwner: 1 } }).svc.previewUpdate(12, emptyRequest(4), ordinary3),
    );
  });
});

/* ------------------------------------------------------------------------ */
/* H                                                                         */
/* ------------------------------------------------------------------------ */

describe('H · the super admin continues to work', () => {
  it('on both sides, legacy rows included', async () => {
    for (const parties of [
      { requester: 4, stockOwner: 1 },
      { requester: null, stockOwner: 1 },
    ]) {
      const h = reservations({ parties });
      for (const op of WAREHOUSE_ASSERTED) await expect(h.svc.assertMay(superAdmin, 8, op)).resolves.toBeDefined();
      await passed(h.returns.previewCreate({ reservationId: 8, quantity: 1 } as any, superAdmin));
      await passed(h.returns.receive(2, 1, superAdmin));
      await expect(h.svc.assertMayRead(superAdmin, 8)).resolves.toBeUndefined();
    }
    await passed(reservations({ parties: { requester: 4, stockOwner: 1 } }).svc.previewCreate(emptyRequest(), superAdmin));
  });

  it('and reads and changes the catalogue', async () => {
    const c = catalogue();
    await expect(c.items.findAll({} as any, superAdmin)).resolves.toHaveLength(1);
    await expect(c.categories.assertMayEdit(superAdmin, 9)).resolves.toBeUndefined();
    await expect(guardFor(superAdmin)(['manage_items'])).resolves.toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* Service level is not route level                                          */
/* ------------------------------------------------------------------------ */

describe('service-level standing does not open an HTTP route the guard still closes', () => {
  // E and F above are decided in the SERVICES. Over HTTP every reservation and
  // return mutation also passes PermissionGuard first, unchanged by this
  // release: company 3's person with no warehouse permission holds requester
  // standing in the service and is still refused at the route.
  it.each([
    ['POST /reservations', ReservationsController.prototype, 'create', 'manage_reservations'],
    ['POST /reservations/preflight/create', ReservationsController.prototype, 'preflightCreate', 'manage_reservations'],
    ['PATCH /reservations/task/:taskId', ReservationsController.prototype, 'updateTaskReservations', 'manage_reservations'],
    ['POST /resource-returns', ResourceReturnsController.prototype, 'create', 'manage_resource_returns'],
    ['POST /resource-returns/preflight/create', ResourceReturnsController.prototype, 'preflightCreate', 'manage_resource_returns'],
  ])('%s still requires its manage permission at the route', async (_route, controller, method, permission) => {
    const required = metadata(PERMISSIONS_KEY, controller, method);
    expect(required).toEqual([permission]);
    await expect(guardFor(ordinary3)(required)).rejects.toBeInstanceOf(ForbiddenException);
    // …while the same person passes the service's requester check for company 3.
    await passed(reservations({ parties: { requester: 3, stockOwner: 1 } }).svc.previewCreate(emptyRequest(), ordinary3));
  });
});

/* ------------------------------------------------------------------------ */
/* receive_reservation_alerts                                                */
/* ------------------------------------------------------------------------ */

describe('receive_reservation_alerts alone · reads a reservation, and nothing more', () => {
  /** Somebody reservation alerts go to, holding that permission only, role in company 5. */
  const alertsOnly = actor({ userId: 60, permissionNames: ['receive_reservation_alerts'], home: { wildcard: false, entityIds: [5] } });

  it('A · passes the route guard of GET /reservations/:id and GET /reservations', async () => {
    for (const method of ['getOne', 'getAll']) {
      await expect(guardFor(alertsOnly)(metadata(PERMISSIONS_KEY, ReservationsController.prototype, method))).resolves.toBe(true);
    }
  });

  it('A · opens another company’s reservation and a legacy one through the service', async () => {
    for (const parties of [
      { requester: 3, stockOwner: 1 },
      { requester: null, stockOwner: 1 },
    ]) {
      const h = reservations({ parties });
      await expect(h.svc.assertMayRead(alertsOnly, 8)).resolves.toBeUndefined();
      await expect(h.svc.getOne(8, alertsOnly)).resolves.toMatchObject({ id: 8, stockOwnerWorkspaceId: 1 });
    }
    // Without the permission the same person gets the 404 the route used to contradict.
    const without = actor({ userId: 60, home: { wildcard: false, entityIds: [5] } });
    await expect(reservations({ parties: { requester: 3, stockOwner: 1 } }).svc.getOne(8, without)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('B · is refused every warehouse mutation in the service', async () => {
    for (const parties of [
      { requester: 3, stockOwner: 1 },
      { requester: null, stockOwner: 1 },
    ]) {
      const h = reservations({ parties });
      for (const op of WAREHOUSE_ASSERTED) await refused(h.svc.assertMay(alertsOnly, 8, op));
      await refused(h.returns.receive(2, 60, alertsOnly));
      await refused(h.returns.cancel(2, alertsOnly));
    }
  });

  it('B · is refused every reservation and return mutation route', async () => {
    const routes: [object, string][] = [
      [ReservationsController.prototype, 'create'],
      [ReservationsController.prototype, 'updateTaskReservations'],
      [ReservationsController.prototype, 'allocate'],
      [ReservationsController.prototype, 'reallocate'],
      [ReservationsController.prototype, 'releaseAllocation'],
      [ReservationsController.prototype, 'approveConsumable'],
      [ReservationsController.prototype, 'reclaim'],
      [ReservationsController.prototype, 'cancel'],
      [ReservationsController.prototype, 'uncancel'],
      [ReservationsController.prototype, 'reject'],
      [ResourceReturnsController.prototype, 'create'],
      [ResourceReturnsController.prototype, 'receive'],
      [ResourceReturnsController.prototype, 'cancel'],
    ];
    for (const [controller, method] of routes) {
      await expect(guardFor(alertsOnly)(metadata(PERMISSIONS_KEY, controller, method))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
  });

  it('C · gains no requester standing — not for another company, not on a legacy row', async () => {
    const other = reservations({ parties: { requester: 3, stockOwner: 1 } });
    await refused(other.svc.previewCreate(emptyRequest(), alertsOnly));
    await refused(other.svc.previewUpdate(12, emptyRequest(), alertsOnly));
    await refused(other.returns.previewCreate({ reservationId: 8, quantity: 1 } as any, alertsOnly));
    const legacyRow = reservations({ parties: { requester: null, stockOwner: 1 } });
    await refused(legacyRow.returns.previewCreate({ reservationId: 8, quantity: 1 } as any, alertsOnly));
    await refused(legacyRow.svc.assertMay(alertsOnly, 8, 'reservation.cancel'));
  });
});
