import { WarehouseActor } from '../auth/actor';
import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { ResourceReturnsController } from '../resource-returns/resource-returns.controller';
import { ReservationsController } from './reservations.controller';
import {
  OPERATION_SIDE,
  RESERVATION_READ_PERMISSIONS,
  ReservationParties,
  WAREHOUSE_OPERATION_PERMISSIONS,
  decideOperation,
  decideRequester,
  decideWarehouse,
  isReservationReader,
  isWarehouseViewer,
  mayRead,
} from './two-party';

/**
 * WAREHOUSE V1 CONTRACT — Requester Organization <-> Shared Warehouse.
 *
 * The actors below are shaped like the real staging data: the catalogue is
 * filed under company 1, nobody but the super admin holds a role there, and
 * every warehouse role lives in companies 3–7.
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

  it.each(routes)('%s', (operation, controller, method) => {
    expect(WAREHOUSE_OPERATION_PERMISSIONS[operation]).toEqual(permissionsOf(controller, method));
  });

  it('names a permission for every warehouse and either-side operation, and for nothing else', () => {
    expect(Object.keys(WAREHOUSE_OPERATION_PERMISSIONS).sort()).toEqual([...WAREHOUSE_OPS, ...EITHER_OPS].sort());
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

describe('D / F · a warehouse permission is not requester authority for another company', () => {
  it('does not let the warehouse head act as company 3’s or company 4’s requester', () => {
    for (const parties of [asked3, asked4]) {
      for (const op of REQUESTER_OPS) {
        expect(decideOperation(warehouseHead, parties, op)).toMatchObject({
          allowed: false,
          side: 'requester',
          because: 'outside-scope',
        });
      }
    }
  });

  it('does not let manage_warehouse stand in for a role in the requester’s company', () => {
    const manager = actor({ permissionNames: ['manage_warehouse'], home: { wildcard: false, entityIds: [7] } });
    expect(decideRequester(manager, asked3).allowed).toBe(false);
  });

  it('does let warehouse staff request for the company their own role is in', () => {
    expect(decideOperation(warehouseHead, { requester: 6, stockOwner: 1 }, 'reservation.create').allowed).toBe(true);
  });
});

describe('E / F · the requester side is the requester’s company', () => {
  it('lets company 3 act as the requester of company 3’s work, with no warehouse permission', () => {
    for (const op of REQUESTER_OPS) {
      expect(decideOperation(requester3, asked3, op)).toMatchObject({ allowed: true, because: 'in-scope' });
    }
  });

  it('does not let company 3 act as the requester for company 4', () => {
    for (const op of REQUESTER_OPS) {
      expect(decideOperation(requester3, asked4, op)).toMatchObject({ allowed: false, because: 'outside-scope' });
      expect(decideOperation(director3, asked4, op).allowed).toBe(false);
    }
  });

  it('does not let a requester approve, allocate, reject, release or receive without the warehouse permission', () => {
    for (const op of WAREHOUSE_OPS) expect(decideOperation(requester3, asked3, op).allowed).toBe(false);
  });

  it('ignores where the item is filed — the stock owner is bookkeeping', () => {
    for (const stockOwner of [1, 3, 4, 6, null]) {
      expect(decideRequester(requester3, { requester: 3, stockOwner }).allowed).toBe(true);
      expect(decideRequester(requester3, { requester: 4, stockOwner }).allowed).toBe(false);
    }
  });

  it('lets a task member be the requester only where the requester is unknown — a known company decides alone', () => {
    // Company 6's storekeeper on a task of company 4's project, filing a return.
    expect(decideOperation(storekeeper, asked4, 'return.create', { onTheTask: true })).toMatchObject({
      allowed: false,
      because: 'outside-scope',
    });
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

  it('refuse requester-side acts to anybody bounded who is not on the task — nothing is guessed', () => {
    for (const who of [requester3, director3, warehouseHead, inCatalogueCompany]) {
      for (const op of REQUESTER_OPS) {
        expect(decideOperation(who, legacy, op)).toMatchObject({ allowed: false, because: 'unknown-workspace' });
      }
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
  it('lets the requester’s company do it as the requester, without a warehouse permission', () => {
    for (const op of EITHER_OPS) {
      expect(decideOperation(requester3, asked3, op)).toMatchObject({ allowed: true, side: 'requester' });
    }
  });

  it('lets warehouse staff do it as the warehouse, for any company', () => {
    for (const op of EITHER_OPS) {
      expect(decideOperation(storekeeper, asked4, op)).toMatchObject({ allowed: true, side: 'warehouse' });
    }
  });

  it('refuses a third company with no warehouse permission', () => {
    for (const op of EITHER_OPS) expect(decideOperation(requester3, asked4, op).allowed).toBe(false);
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
    expect(decideRequester(alertsOnly, asked3)).toMatchObject({ allowed: false, because: 'outside-scope' });
    expect(decideRequester(alertsOnly, legacy)).toMatchObject({ allowed: false, because: 'unknown-workspace' });
  });

  it('does not widen returns or the warehouse viewer list', () => {
    expect(isWarehouseViewer(alertsOnly)).toBe(false);
  });
});
