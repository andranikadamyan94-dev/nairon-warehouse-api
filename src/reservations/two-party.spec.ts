import { WarehouseActor } from '../auth/actor';
import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { ResourceReturnsController } from '../resource-returns/resource-returns.controller';
import { ReservationsController } from './reservations.controller';
import {
  OPERATION_SIDE,
  REQUESTER_SIDE_WAREHOUSE_PERMISSIONS,
  RESERVATION_READ_PERMISSIONS,
  ReservationParties,
  WAREHOUSE_OPERATION_PERMISSIONS,
  decideOperation,
  decideRequester,
  decideWarehouse,
  inRequesterCompany,
  isReservationReader,
  isWarehouseViewer,
  mayRead,
} from './two-party';

/**
 * WAREHOUSE V1 CONTRACT — Requester Organization <-> Shared Warehouse.
 *
 * Owner decision 2026-10-05, "the warehouse is global": the requester side
 * passes on being ON THE CRM TASK (`onTheTask`, which CRM answers) or on the
 * act's warehouse permission — never on a role in the requester's company.
 * The company still decides READING (mayRead).
 *
 * The actors below are shaped like the real staging data: the catalogue is
 * filed under company 1, nobody but the super admin holds a role there, and
 * every warehouse role lives in companies 3–7.
 */
const actor = (over: Partial<WarehouseActor> = {}): WarehouseActor => ({
  userId: 11,
  isSuperAdmin: false,
  readOnly: false,
  isGlobalSuperAdmin: false,
  permissionNames: [],
  home: { wildcard: false, entityIds: [] },
  declared: null,
  ...over,
});

/** The head of the warehouse: every warehouse right, one role, in company 6. */
const warehouseHead = actor({
  userId: 27,
  permissionNames: [
    'view_warehouse',
    'manage_warehouse',
    'view_reservations',
    'manage_reservations',
    'view_resource_returns',
    'manage_resource_returns',
  ],
  home: { wildcard: false, entityIds: [6] },
});
/** Warehouse staff holding only the narrow grants, role in company 6. */
const storekeeper = actor({
  userId: 34,
  permissionNames: ['manage_reservations', 'manage_resource_returns'],
  home: { wildcard: false, entityIds: [6] },
});
/** A project person in company 3 with no warehouse permission at all. */
const requester3 = actor({ userId: 39, home: { wildcard: false, entityIds: [3] } });
/** Company 3's director: a role in 3 and the reservation manage right. */
const director3 = actor({
  userId: 17,
  permissionNames: ['manage_reservations', 'view_reservations'],
  home: { wildcard: false, entityIds: [3] },
});
/** Somebody whose only role is in company 1, where the catalogue is filed — and no warehouse permission. */
const inCatalogueCompany = actor({ userId: 50, home: { wildcard: false, entityIds: [1] } });
/** A developer in company 4 who may look at the warehouse and nothing more. */
const viewer4 = actor({ userId: 18, permissionNames: ['view_warehouse'], home: { wildcard: false, entityIds: [4] } });
/** The global super admin: a super-admin role assigned in every company. */
const superAdmin = actor({ userId: 1, isSuperAdmin: true, isGlobalSuperAdmin: true, home: { wildcard: true, entityIds: [] } });

/** Company 3 asked; the item is filed under company 1. */
const asked3: ReservationParties = { requester: 3, stockOwner: 1 };
/** Company 4 asked; same pool. */
const asked4: ReservationParties = { requester: 4, stockOwner: 1 };
/** A legacy reservation: nobody pinned who asked. 81 of these on real data. */
const legacy: ReservationParties = { requester: null, stockOwner: 1 };
/** An item with no category at all. */
const uncatalogued: ReservationParties = { requester: 3, stockOwner: null };

const REQUESTER_OPS = ['reservation.create', 'reservation.update', 'reservation.accept', 'return.create'];
const WAREHOUSE_OPS = [
  'reservation.approve',
  'reservation.allocate',
  'reservation.reject',
  'reservation.release',
  'reservation.reallocate',
  'return.receive',
];
const EITHER_OPS = ['reservation.cancel', 'reservation.uncancel', 'return.cancel'];

describe('which side each operation belongs to', () => {
  it('puts asking, changing the ask, accepting and handing back on the requester', () => {
    for (const op of REQUESTER_OPS) expect(OPERATION_SIDE[op]).toBe('requester');
  });

  it('puts approving, allocating, rejecting, releasing and receiving on the shared warehouse', () => {
    for (const op of WAREHOUSE_OPS) expect(OPERATION_SIDE[op]).toBe('warehouse');
  });

  it('lets either side end an arrangement', () => {
    for (const op of EITHER_OPS) expect(OPERATION_SIDE[op]).toBe('both');
  });

  it('has no stock-owner side at all', () => {
    expect(Object.values(OPERATION_SIDE)).not.toContain('stock-owner');
  });

  it('refuses an operation nobody has classified — even for a super admin', () => {
    expect(decideOperation(superAdmin, asked3, 'reservation.teleport').allowed).toBe(false);
  });
});

describe('the warehouse permission each warehouse act needs is the one its route already demands', () => {
  const permissionsOf = (controller: object, method: string): string[] =>
    Reflect.getMetadata(PERMISSIONS_KEY, (controller as never)[method]) ?? [];

  const routes: [string, object, string][] = [
    ['reservation.approve', ReservationsController.prototype, 'approveConsumable'],
    ['reservation.allocate', ReservationsController.prototype, 'allocate'],
    ['reservation.reject', ReservationsController.prototype, 'reject'],
    ['reservation.release', ReservationsController.prototype, 'releaseAllocation'],
    ['reservation.reallocate', ReservationsController.prototype, 'reallocate'],
    ['reservation.cancel', ReservationsController.prototype, 'cancel'],
    ['reservation.uncancel', ReservationsController.prototype, 'uncancel'],
    ['return.receive', ResourceReturnsController.prototype, 'receive'],
    ['return.cancel', ResourceReturnsController.prototype, 'cancel'],
  ];

  /*
   * view_warehouse on a route is the REQUESTER's pass, not warehouse authority
   * (owner's decision 2026-09-20: it asks for goods and files and calls off its
   * own returns). The service decides the requester side by standing, so the
   * warehouse side of an operation is its route's permissions without it.
   */
  const REQUESTER_PASS = 'view_warehouse';
  const warehouseSideOf = (required: string[]) => required.filter((p) => p !== REQUESTER_PASS);

  it.each(routes)('%s', (operation, controller, method) => {
    const required = permissionsOf(controller, method);
    expect(warehouseSideOf(required).length).toBeGreaterThan(0);
    expect(WAREHOUSE_OPERATION_PERMISSIONS[operation]).toEqual(warehouseSideOf(required));
  });

  it('the requester pass appears only on an operation the requester side may also do', () => {
    for (const [operation, controller, method] of routes) {
      if (permissionsOf(controller, method).includes(REQUESTER_PASS)) expect(OPERATION_SIDE[operation]).toBe('both');
    }
  });

  it('never counts view_warehouse as warehouse authority', () => {
    for (const needed of Object.values(WAREHOUSE_OPERATION_PERMISSIONS)) expect(needed).not.toContain(REQUESTER_PASS);
  });

  it('names a permission for every warehouse and either-side operation, and for nothing else', () => {
    expect(Object.keys(WAREHOUSE_OPERATION_PERMISSIONS).sort()).toEqual([...WAREHOUSE_OPS, ...EITHER_OPS].sort());
  });

  /*
   * The requester-side acts a route serves: the warehouse pass that lets
   * warehouse staff do them for any task is the route's own permission beside
   * view_warehouse (owner, 2026-10-05).
   */
  const requesterRoutes: [string, object, string][] = [
    ['reservation.create', ReservationsController.prototype, 'create'],
    ['reservation.update', ReservationsController.prototype, 'updateTaskReservations'],
    ['return.create', ResourceReturnsController.prototype, 'create'],
  ];

  it.each(requesterRoutes)('requester-side %s: the warehouse pass is what its route demands beside view_warehouse, plus the CRM task-edit right', (operation, controller, method) => {
    const required = permissionsOf(controller, method);
    expect(required).toContain(REQUESTER_PASS);
    // CRM's update_project_task opens the requester side too (2026-10-05): a
    // project manager who may edit the task in CRM may ask for its resources.
    expect(REQUESTER_SIDE_WAREHOUSE_PERMISSIONS[operation]).toEqual([...warehouseSideOf(required), 'update_project_task']);
  });

  it('names a requester-side pass for the routed requester acts only — never for an either-side act', () => {
    expect(Object.keys(REQUESTER_SIDE_WAREHOUSE_PERMISSIONS).sort()).toEqual(['reservation.create', 'reservation.update', 'return.create']);
    for (const op of EITHER_OPS) expect(REQUESTER_SIDE_WAREHOUSE_PERMISSIONS[op]).toBeUndefined();
  });
});

describe('C · the warehouse side is the shared pool, decided by warehouse permissions only', () => {
  it('lets the warehouse head in company 6 operate stock filed under company 1', () => {
    for (const op of [...WAREHOUSE_OPS, ...EITHER_OPS]) {
      expect(decideOperation(warehouseHead, asked3, op)).toMatchObject({
        allowed: true,
        side: 'warehouse',
        because: 'warehouse-permission',
      });
    }
  });

  it('lets narrow warehouse staff do the same with the operation’s own grant', () => {
    for (const op of [...WAREHOUSE_OPS, ...EITHER_OPS]) {
      expect(decideOperation(storekeeper, asked4, op).allowed).toBe(true);
    }
  });

  it('never needs a role in company 1, in the category’s company or in the requester’s company', () => {
    for (const parties of [asked3, asked4, legacy, uncatalogued, { requester: 7, stockOwner: 6 }]) {
      for (const op of WAREHOUSE_OPS) {
        expect(decideOperation(warehouseHead, parties, op).allowed).toBe(true);
      }
    }
  });

  it('does not look at either company: the verdict is the same whatever the reservation names', () => {
    for (const op of WAREHOUSE_OPS) {
      const baseline = decideWarehouse(storekeeper, op);
      for (const parties of [asked3, asked4, legacy, uncatalogued]) {
        expect(decideOperation(storekeeper, parties, op)).toEqual(baseline);
      }
    }
  });

  it('asks for the operation’s own permission — the reservation right does not receive returns', () => {
    const reservationsOnly = actor({ permissionNames: ['manage_reservations'], home: { wildcard: false, entityIds: [6] } });
    expect(decideWarehouse(reservationsOnly, 'reservation.approve').allowed).toBe(true);
    expect(decideWarehouse(reservationsOnly, 'return.receive').allowed).toBe(false);
  });

  it('honours manage_warehouse, the warehouse super-permission, as the guard does', () => {
    const manager = actor({ permissionNames: ['manage_warehouse'], home: { wildcard: false, entityIds: [7] } });
    for (const op of [...WAREHOUSE_OPS, ...EITHER_OPS]) expect(decideWarehouse(manager, op).allowed).toBe(true);
  });

  it('refuses somebody without the warehouse permission — whatever company they are in', () => {
    for (const nobody of [requester3, viewer4, inCatalogueCompany]) {
      for (const op of WAREHOUSE_OPS) {
        expect(decideOperation(nobody, asked3, op)).toMatchObject({
          allowed: false,
          because: 'no-warehouse-permission',
        });
      }
    }
  });

  it('gives a role in the company the catalogue is filed under no warehouse authority', () => {
    expect(decideOperation(inCatalogueCompany, { requester: 5, stockOwner: 1 }, 'reservation.approve').allowed).toBe(
      false,
    );
  });
});

describe('C / D · the warehouse is global: a warehouse permission is requester authority for any company’s task', () => {
  const ROUTED_REQUESTER_OPS = ['reservation.create', 'reservation.update', 'return.create'];

  it('lets the warehouse head ask, change the ask and hand back for company 3, company 4 and a legacy row', () => {
    for (const parties of [asked3, asked4, legacy, uncatalogued]) {
      for (const op of ROUTED_REQUESTER_OPS) {
        expect(decideOperation(warehouseHead, parties, op)).toMatchObject({
          allowed: true,
          side: 'requester',
          because: 'warehouse-permission',
          workspace: parties.requester,
        });
      }
    }
  });

  it('asks for the act’s own permission: the reservation right does not file returns, the returns right does not ask for goods', () => {
    const reservationsOnly = actor({ permissionNames: ['manage_reservations'], home: { wildcard: false, entityIds: [6] } });
    const returnsOnly = actor({ permissionNames: ['manage_resource_returns'], home: { wildcard: false, entityIds: [6] } });
    expect(decideOperation(reservationsOnly, asked3, 'reservation.create').allowed).toBe(true);
    expect(decideOperation(reservationsOnly, asked3, 'reservation.update').allowed).toBe(true);
    expect(decideOperation(reservationsOnly, asked3, 'return.create')).toMatchObject({ allowed: false, because: 'not-on-the-task' });
    expect(decideOperation(returnsOnly, asked3, 'return.create').allowed).toBe(true);
    expect(decideOperation(returnsOnly, asked3, 'reservation.create')).toMatchObject({ allowed: false, because: 'not-on-the-task' });
  });

  it('honours manage_warehouse, the warehouse super-permission, on the requester side too', () => {
    const manager = actor({ permissionNames: ['manage_warehouse'], home: { wildcard: false, entityIds: [7] } });
    for (const op of REQUESTER_OPS) expect(decideRequester(manager, asked3, {}, op).allowed).toBe(true);
  });

  it('does not let view_warehouse — the requester’s route pass — stand in for being on the task', () => {
    for (const op of ROUTED_REQUESTER_OPS) {
      expect(decideOperation(viewer4, asked4, op)).toMatchObject({ allowed: false, because: 'not-on-the-task' });
    }
  });

  it('a company’s director with the reservation right asks for another company’s task — as warehouse staff would', () => {
    expect(decideOperation(director3, asked4, 'reservation.create')).toMatchObject({ allowed: true, because: 'warehouse-permission' });
  });
});

describe('E / F · the requester side is the CRM task, not the requester’s company', () => {
  it('lets a person on the task ask, change the ask, accept and hand back — whichever company they are in, with no warehouse permission', () => {
    for (const who of [requester3, inCatalogueCompany, viewer4, actor()]) {
      for (const parties of [asked3, asked4, legacy, uncatalogued]) {
        for (const op of REQUESTER_OPS) {
          expect(decideOperation(who, parties, op, { onTheTask: true })).toMatchObject({
            allowed: true,
            side: 'requester',
            because: 'on-the-task',
            workspace: parties.requester,
          });
        }
      }
    }
  });

  it('refuses a role in the requester’s own company that is not on the task — company 3 for company 3’s work included', () => {
    for (const op of REQUESTER_OPS) {
      expect(decideOperation(requester3, asked3, op)).toMatchObject({ allowed: false, side: 'requester', because: 'not-on-the-task' });
      expect(decideOperation(requester3, asked4, op)).toMatchObject({ allowed: false, because: 'not-on-the-task' });
    }
  });

  it('refuses a wildcard role too: a role in every company is still not the task', () => {
    const everywhere = actor({ userId: 70, home: { wildcard: true, entityIds: [] } });
    for (const parties of [asked3, legacy]) {
      for (const op of REQUESTER_OPS) {
        expect(decideOperation(everywhere, parties, op)).toMatchObject({ allowed: false, because: 'not-on-the-task' });
      }
    }
  });

  it('does not let a requester approve, allocate, reject, release or receive without the warehouse permission', () => {
    for (const op of WAREHOUSE_OPS) {
      expect(decideOperation(requester3, asked3, op).allowed).toBe(false);
      expect(decideOperation(requester3, asked3, op, { onTheTask: true }).allowed).toBe(false);
    }
  });

  it('ignores both companies on this side — who asked and where the item is filed are bookkeeping', () => {
    for (const stockOwner of [1, 3, 4, 6, null]) {
      for (const requester of [3, 4, null]) {
        expect(decideRequester(requester3, { requester, stockOwner }, { onTheTask: true }).allowed).toBe(true);
        expect(decideRequester(requester3, { requester, stockOwner }).allowed).toBe(false);
      }
    }
  });

  it('reports the company that asked on the verdict, for the log, without reading it', () => {
    expect(decideRequester(requester3, asked4, { onTheTask: true }).workspace).toBe(4);
    expect(decideRequester(requester3, legacy, { onTheTask: true }).workspace).toBeNull();
  });
});

describe('G · legacy reservations whose requester was never pinned', () => {
  it('leave every warehouse-side operation to warehouse staff', () => {
    for (const op of WAREHOUSE_OPS) {
      expect(decideOperation(warehouseHead, legacy, op)).toMatchObject({ allowed: true, because: 'warehouse-permission' });
    }
  });

  it('do not stop warehouse staff cancelling or restoring them, or calling off a return', () => {
    for (const op of EITHER_OPS) {
      expect(decideOperation(storekeeper, legacy, op)).toMatchObject({ allowed: true, side: 'warehouse' });
    }
  });

  it('refuse requester-side acts to anybody off the task without the act’s warehouse permission — nothing is guessed', () => {
    for (const who of [requester3, viewer4, inCatalogueCompany, actor({ home: { wildcard: true, entityIds: [] } })]) {
      for (const op of REQUESTER_OPS) {
        expect(decideOperation(who, legacy, op)).toMatchObject({ allowed: false, because: 'not-on-the-task', workspace: null });
      }
    }
  });

  it('let warehouse staff act as their requester, as for any task', () => {
    for (const op of ['reservation.create', 'reservation.update', 'return.create']) {
      expect(decideOperation(warehouseHead, legacy, op)).toMatchObject({ allowed: true, because: 'warehouse-permission' });
    }
  });

  it('give requester standing to a member of the CRM task the reservation serves', () => {
    expect(decideOperation(requester3, legacy, 'return.create', { onTheTask: true })).toMatchObject({
      allowed: true,
      side: 'requester',
      because: 'on-the-task',
      workspace: null,
    });
  });

  it('do not turn task membership into warehouse authority', () => {
    for (const op of WAREHOUSE_OPS) {
      expect(decideOperation(requester3, legacy, op, { onTheTask: true }).allowed).toBe(false);
    }
  });

  it('refuse an either-side act to somebody with neither standing', () => {
    expect(decideOperation(requester3, legacy, 'reservation.cancel')).toMatchObject({
      allowed: false,
      because: 'no-warehouse-permission',
    });
  });

  it('are decided by requesterWorkspaceId alone — parties carry no legacy label to fall back on', () => {
    // The parties type has exactly the two fields; a stray entityId on the
    // object is not read by anything.
    const withLabel = { ...legacy, entityId: 3 } as ReservationParties;
    expect(decideOperation(requester3, withLabel, 'return.create')).toEqual(
      decideOperation(requester3, legacy, 'return.create'),
    );
  });
});

describe('either side may end an arrangement', () => {
  it('lets the people on the task do it as the requester, without a warehouse permission', () => {
    for (const op of EITHER_OPS) {
      expect(decideOperation(requester3, asked3, op, { onTheTask: true })).toMatchObject({
        allowed: true,
        side: 'requester',
        because: 'on-the-task',
      });
    }
  });

  it('lets warehouse staff do it as the warehouse, for any company — the warehouse head wears that hat too', () => {
    for (const op of EITHER_OPS) {
      expect(decideOperation(storekeeper, asked4, op)).toMatchObject({ allowed: true, side: 'warehouse' });
      expect(decideOperation(warehouseHead, asked4, op)).toMatchObject({ allowed: true, side: 'warehouse', because: 'warehouse-permission' });
    }
  });

  it('refuses a role in the company that asked, off the task and without a warehouse permission — and a third company alike', () => {
    for (const op of EITHER_OPS) {
      expect(decideOperation(requester3, asked3, op)).toMatchObject({ allowed: false, because: 'no-warehouse-permission' });
      expect(decideOperation(requester3, asked4, op).allowed).toBe(false);
    }
  });
});

describe('H · the super admin', () => {
  it('works both sides, legacy rows included', () => {
    for (const parties of [asked3, asked4, legacy, uncatalogued]) {
      for (const op of [...REQUESTER_OPS, ...WAREHOUSE_OPS, ...EITHER_OPS]) {
        expect(decideOperation(superAdmin, parties, op).allowed).toBe(true);
      }
      expect(mayRead(superAdmin, parties)).toBe(true);
    }
  });
});

describe('who may look', () => {
  it('lets the requester’s company see its reservation', () => {
    expect(mayRead(requester3, asked3)).toBe(true);
    expect(inRequesterCompany(requester3, asked3)).toBe(true);
  });

  it('D · reading kept the company rule when acting lost it: company 3 sees company 3’s reservation and may not touch it off the task', () => {
    expect(mayRead(requester3, asked3, { onTheTask: false, warehouseViewer: false })).toBe(true);
    for (const op of [...REQUESTER_OPS, ...EITHER_OPS]) expect(decideOperation(requester3, asked3, op).allowed).toBe(false);
    // A wildcard role reads everything the company rule opens — and acts on nothing by it.
    const everywhere = actor({ userId: 70, home: { wildcard: true, entityIds: [] } });
    expect(inRequesterCompany(everywhere, asked4)).toBe(true);
    expect(mayRead(everywhere, legacy, { warehouseViewer: false })).toBe(true);
    expect(decideOperation(everywhere, asked4, 'reservation.create').allowed).toBe(false);
  });

  it('lets the people on the task see it, whichever company they are in', () => {
    expect(mayRead(requester3, asked4, { onTheTask: true })).toBe(true);
  });

  it('lets warehouse staff of any company see every reservation in the shared pool, legacy ones too', () => {
    for (const staff of [warehouseHead, storekeeper, viewer4]) {
      expect(isWarehouseViewer(staff)).toBe(true);
      for (const parties of [asked3, asked4, legacy, uncatalogued]) {
        expect(mayRead(staff, parties, { warehouseViewer: true })).toBe(true);
      }
    }
  });

  it('does not let another company’s person without a warehouse permission see it', () => {
    expect(isWarehouseViewer(requester3)).toBe(false);
    expect(mayRead(requester3, asked4, { warehouseViewer: false })).toBe(false);
    expect(mayRead(requester3, legacy, { warehouseViewer: false })).toBe(false);
  });

  it('does not let a role in the catalogue’s company stand in for a warehouse permission', () => {
    expect(mayRead(inCatalogueCompany, { requester: 4, stockOwner: 1 }, { warehouseViewer: false })).toBe(false);
  });

  it('does not let somebody with a token and nothing else see it', () => {
    expect(mayRead(actor(), asked3, { onTheTask: false, warehouseViewer: false })).toBe(false);
  });
});

describe('receive_reservation_alerts · reservation READ authority, and nothing else', () => {
  /** Somebody reservation alerts are sent to: that permission alone, role in company 5. */
  const alertsOnly = actor({ userId: 60, permissionNames: ['receive_reservation_alerts'], home: { wildcard: false, entityIds: [5] } });
  /** The same person without it. */
  const same = actor({ userId: 60, permissionNames: [], home: { wildcard: false, entityIds: [5] } });

  const permissionsOf = (controller: object, method: string): string[] =>
    Reflect.getMetadata(PERMISSIONS_KEY, (controller as never)[method]) ?? [];

  it('A · opens any reservation the alert can link to — other companies’ and legacy ones', () => {
    expect(RESERVATION_READ_PERMISSIONS).toContain('receive_reservation_alerts');
    expect(isReservationReader(alertsOnly)).toBe(true);
    for (const parties of [asked3, asked4, legacy, uncatalogued]) {
      expect(mayRead(alertsOnly, parties, { warehouseViewer: isReservationReader(alertsOnly) })).toBe(true);
      expect(mayRead(same, parties, { warehouseViewer: isReservationReader(same) })).toBe(parties.requester === 5);
    }
  });

  it('A · matches the route: GET /reservations and GET /reservations/:id admit it', () => {
    expect(permissionsOf(ReservationsController.prototype, 'getOne')).toContain('receive_reservation_alerts');
    expect(permissionsOf(ReservationsController.prototype, 'getAll')).toContain('receive_reservation_alerts');
  });

  it('B · performs no warehouse operation, on any reservation', () => {
    for (const parties of [asked3, asked4, legacy, uncatalogued]) {
      for (const op of [...WAREHOUSE_OPS, ...EITHER_OPS]) {
        expect(decideWarehouse(alertsOnly, op)).toMatchObject({ allowed: false, because: 'no-warehouse-permission' });
        expect(decideOperation(alertsOnly, parties, op).allowed).toBe(false);
      }
    }
    for (const needed of Object.values(WAREHOUSE_OPERATION_PERMISSIONS)) {
      expect(needed).not.toContain('receive_reservation_alerts');
    }
  });

  it('B · opens no mutation route', () => {
    const mutations: [object, string][] = [
      [ReservationsController.prototype, 'create'],
      [ReservationsController.prototype, 'preflightCreate'],
      [ReservationsController.prototype, 'preflightUpdate'],
      [ReservationsController.prototype, 'updateTaskReservations'],
      [ReservationsController.prototype, 'allocate'],
      [ReservationsController.prototype, 'reallocate'],
      [ReservationsController.prototype, 'releaseAllocation'],
      [ReservationsController.prototype, 'approveConsumable'],
      [ReservationsController.prototype, 'reclaim'],
      [ReservationsController.prototype, 'preflightCancel'],
      [ReservationsController.prototype, 'cancel'],
      [ReservationsController.prototype, 'uncancel'],
      [ReservationsController.prototype, 'reject'],
      [ResourceReturnsController.prototype, 'create'],
      [ResourceReturnsController.prototype, 'preflightCreate'],
      [ResourceReturnsController.prototype, 'receive'],
      [ResourceReturnsController.prototype, 'cancel'],
    ];
    for (const [controller, method] of mutations) {
      const required = permissionsOf(controller, method);
      expect(required.length).toBeGreaterThan(0);
      expect(required).not.toContain('receive_reservation_alerts');
    }
  });

  it('C · gives no requester standing: the same verdicts as without it', () => {
    for (const parties of [asked3, asked4, legacy, { requester: 5, stockOwner: 1 }]) {
      for (const op of REQUESTER_OPS) {
        expect(decideOperation(alertsOnly, parties, op)).toEqual(decideOperation(same, parties, op));
      }
    }
    expect(decideRequester(alertsOnly, asked3)).toMatchObject({ allowed: false, because: 'not-on-the-task' });
    expect(decideRequester(alertsOnly, legacy)).toMatchObject({ allowed: false, because: 'not-on-the-task' });
  });

  it('does not widen returns or the warehouse viewer list', () => {
    expect(isWarehouseViewer(alertsOnly)).toBe(false);
  });
});
