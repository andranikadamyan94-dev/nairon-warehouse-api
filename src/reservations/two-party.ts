import { WarehouseActor, Workspace, decideWorkspace } from '../auth/actor';

/**
 * A reservation has two sides, and they are not interchangeable.
 *
 * WAREHOUSE V1 CONTRACT (owner decision, 2026-09-16)
 *
 * The warehouse is ONE shared pool for every company. So the two sides are:
 *
 *   requester    the company whose work asked for the resource — from the CRM
 *                project, pinned on the reservation as requesterWorkspaceId
 *                when it was made — or, where the operation already has one,
 *                the authoritative CRM task relationship.
 *   warehouse    the shared warehouse, operated by whoever holds the existing
 *                warehouse permission for the act. Not a company.
 *
 * The model is Requester Organization <-> Shared Warehouse. It is NOT requester
 * company <-> stock-owner company: the company a category happens to be filed
 * under (ItemCategory.entityId, reported as `stockOwner`) is bookkeeping, and
 * grants or refuses nothing. The head of the warehouse holds a role only in
 * company 6; the pool is filed under company 1; they run all of it.
 *
 * And the two sides must not leak into each other:
 *
 *   A person who runs projects for the requester may ask, change their own
 *   request and hand things back. They may NOT approve stock, reject a
 *   request, or take goods back onto a shelf — that needs a warehouse
 *   permission.
 *
 *   Warehouse staff may approve, allocate, reject, release and receive. They
 *   may NOT act as the requester of another company's work — a warehouse
 *   permission is not a role in the requester's company.
 *
 * Some actions belong to both sides and are marked as such. Reading is its own
 * question and lives in `mayRead` below.
 *
 * What is never an input: ResourceReservation.entityId. It is a legacy label
 * whose rows mean three different things; it grants nothing, refuses nothing
 * and is never a fallback for an unknown requester.
 */

/**
 * The two companies a reservation can name. Only `requester` carries
 * authority; `stockOwner` is where the item is filed, kept for previews and
 * logs. Either may be unknown.
 */
export type ReservationParties = {
  requester: Workspace;
  stockOwner: Workspace;
};

export type Side = 'requester' | 'warehouse';

export type SideVerdict = {
  allowed: boolean;
  because:
    /** Requester: a wildcard role applies in every company, the requester's included. */
    | 'unbounded'
    /** Requester: they hold a role in the requester's company. */
    | 'in-scope'
    /** Requester: they hold a role, but somewhere else. */
    | 'outside-scope'
    /** Requester: the row cannot say which company asked, and nothing else stands in. */
    | 'unknown-workspace'
    /** Requester, legacy row: they are on the CRM task the reservation serves. */
    | 'on-the-task'
    /** Warehouse: they hold the warehouse permission this act needs. */
    | 'warehouse-permission'
    /** Warehouse: they do not. */
    | 'no-warehouse-permission';
  side: Side;
  /** The requester company for a requester verdict; always null for the warehouse. */
  workspace: Workspace;
};

/** What a caller already established about the actor and this reservation's task. */
export type StandingContext = {
  /** The actor holds one of the CRM task's role slots — asked of CRM, never of the body. */
  onTheTask?: boolean;
};

/**
 * May this actor act as the REQUESTER of this reservation?
 *
 * The requester company is the authority. When it is known, the actor must
 * hold a role in it (or a wildcard role, which is a role in every company). A
 * warehouse permission is not a role there and changes nothing.
 *
 * When it is NOT known — the legacy rows made before it was pinned — nothing is
 * guessed. A wildcard holder still passes, because every possible answer is a
 * company they hold a role in. Anybody else passes only on the authoritative
 * CRM task relationship, when the operation has one: being on the task is a
 * narrower proof of taking part in the requesting work than a company would
 * be. Without it, the requester-side act is refused.
 */
export function decideRequester(
  actor: WarehouseActor,
  parties: ReservationParties,
  context: StandingContext = {},
): SideVerdict {
  const verdict = decideWorkspace(actor, parties.requester);
  if (!verdict.allowed && verdict.because === 'unknown-workspace' && context.onTheTask === true) {
    return { allowed: true, because: 'on-the-task', side: 'requester', workspace: null };
  }
  return { allowed: verdict.allowed, because: verdict.because, side: 'requester', workspace: verdict.workspace };
}

/**
 * The existing warehouse permission each warehouse-side act needs — the same
 * one its route already demands with `@Permissions` (checked against the real
 * controllers in two-party.spec.ts). Not a new permission system: this is the
 * route's answer, asked again where the service decides.
 */
export const WAREHOUSE_OPERATION_PERMISSIONS: Record<string, string[]> = {
  'reservation.approve': ['manage_reservations'],
  'reservation.allocate': ['manage_reservations'],
  'reservation.reject': ['manage_reservations'],
  'reservation.release': ['manage_reservations'],
  'reservation.reallocate': ['manage_reservations'],
  'reservation.cancel': ['manage_reservations'],
  'reservation.uncancel': ['manage_reservations'],
  'return.receive': ['manage_resource_returns'],
  'return.cancel': ['manage_resource_returns'],
};

/**
 * May this actor act as the WAREHOUSE for this operation?
 *
 * Permissions only, exactly as PermissionGuard grants them: a super admin, the
 * warehouse super-permission `manage_warehouse`, or the operation's own
 * permission. No company is consulted — not the actor's, not the category's,
 * not the requester's — so a missing requesterWorkspaceId takes nothing away.
 */
export function decideWarehouse(actor: WarehouseActor, operation: string): SideVerdict {
  const needed = WAREHOUSE_OPERATION_PERMISSIONS[operation] ?? [];
  const holds =
    actor.isSuperAdmin ||
    actor.permissionNames.includes('manage_warehouse') ||
    needed.some((p) => actor.permissionNames.includes(p));
  return holds
    ? { allowed: true, because: 'warehouse-permission', side: 'warehouse', workspace: null }
    : { allowed: false, because: 'no-warehouse-permission', side: 'warehouse', workspace: null };
}

/**
 * Which side each operation belongs to.
 *
 * Written down as data rather than scattered through the service, because the
 * interesting mistakes in a two-party model are not "forgot to check" — they are
 * "checked the wrong side", and that is only visible when the answers sit next
 * to each other.
 *
 * `both` means standing on either side is enough, and is not a leak in either
 * direction: cancelling a reservation ends an arrangement both sides are part
 * of, and either may walk away from it.
 *
 * `reservation.accept` is classified here but decided in the service by the CRM
 * task relationship (or super admin), as it always has been — confirming
 * receipt is what the people on the task do.
 */
export const OPERATION_SIDE: Record<string, Side | 'both'> = {
  /* The requester's business purpose. */
  'reservation.create': 'requester',
  'reservation.update': 'requester',
  'reservation.accept': 'requester',
  'return.create': 'requester',

  /* The shared warehouse. */
  'reservation.approve': 'warehouse',
  'reservation.allocate': 'warehouse',
  'reservation.reject': 'warehouse',
  'reservation.release': 'warehouse',
  'reservation.reallocate': 'warehouse',
  'return.receive': 'warehouse',

  /* Either side may end an arrangement they are part of. */
  'reservation.cancel': 'both',
  'reservation.uncancel': 'both',
  'return.cancel': 'both',
};

/**
 * May this actor carry out this operation on this reservation?
 *
 * For a `both` operation, standing on either side is enough — and the verdict
 * reports the side that let them through, so a log says which hat they were
 * wearing.
 */
export function decideOperation(
  actor: WarehouseActor,
  parties: ReservationParties,
  operation: keyof typeof OPERATION_SIDE | string,
  context: StandingContext = {},
): SideVerdict {
  const side = OPERATION_SIDE[operation];
  if (side === undefined) {
    // An operation nobody classified is not quietly allowed. Adding one means
    // deciding whose it is.
    return { allowed: false, because: 'no-warehouse-permission', side: 'warehouse', workspace: null };
  }
  if (side === 'requester') return decideRequester(actor, parties, context);
  if (side === 'warehouse') return decideWarehouse(actor, operation);

  const asRequester = decideRequester(actor, parties, context);
  if (asRequester.allowed) return asRequester;
  return decideWarehouse(actor, operation);
}

/**
 * Who may READ a reservation, which is a wider question than who may change it.
 *
 * Four audiences, and leaving any of them out breaks something real:
 *
 *   - the requester's people, or the store fills orders nobody can follow;
 *   - the people on the task, who are the ones holding the drill — decided by
 *     CRM, not here, which is why it arrives as a flag;
 *   - warehouse staff with a viewing or managing warehouse permission, whichever
 *     company their roles are in — the warehouse is shared, and they cannot
 *     fulfil what they cannot see;
 *   - super admins.
 *
 * What is NOT an audience: "anybody with a token", and not "somebody with a
 * role in the company the item is filed under" — that company is bookkeeping.
 */
export function mayRead(
  actor: WarehouseActor,
  parties: ReservationParties,
  context: { onTheTask?: boolean; warehouseViewer?: boolean } = {},
): boolean {
  if (actor.isSuperAdmin) return true;
  if (context.onTheTask) return true;
  if (decideRequester(actor, parties).allowed) return true;
  return context.warehouseViewer === true;
}

/** The permissions that make somebody warehouse staff for reading purposes. */
export const WAREHOUSE_VIEWER_PERMISSIONS = [
  'view_reservations',
  'manage_reservations',
  'view_resource_returns',
  'manage_resource_returns',
  'view_warehouse',
  'manage_warehouse',
];

export const isWarehouseViewer = (actor: WarehouseActor): boolean =>
  actor.isSuperAdmin || WAREHOUSE_VIEWER_PERMISSIONS.some((p) => actor.permissionNames.includes(p));

/**
 * Who may READ a reservation as warehouse staff: the viewers above, plus the
 * people reservation alerts are sent to.
 *
 * `GET /reservations/:id` admits `receive_reservation_alerts` so that an alert
 * can open the reservation it links to, and the service must not contradict
 * that route with a 404. READ ONLY: this list is consulted by the reservation
 * read paths and nothing else. It is not requester standing (decideRequester
 * reads roles, never permissions), it is not warehouse authority
 * (decideWarehouse reads WAREHOUSE_OPERATION_PERMISSIONS), and returns keep
 * isWarehouseViewer.
 */
export const RESERVATION_READ_PERMISSIONS = [...WAREHOUSE_VIEWER_PERMISSIONS, 'receive_reservation_alerts'];

export const isReservationReader = (actor: WarehouseActor): boolean =>
  actor.isSuperAdmin || RESERVATION_READ_PERMISSIONS.some((p) => actor.permissionNames.includes(p));
