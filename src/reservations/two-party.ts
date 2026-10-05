import { WarehouseActor, Workspace, decideWorkspace } from '../auth/actor';

/**
 * A reservation has two sides, and they are not interchangeable.
 *
 * WAREHOUSE V1 CONTRACT (owner decision, 2026-09-16)
 *
 * The warehouse is ONE shared pool for every company. So the two sides are:
 *
 *   requester    the people whose work asked for the resource: the CRM task
 *                the reservation serves. Who is on it — creator, Կատարող,
 *                Ստուգող, Պատասխանատու — is asked of CRM, never of the body.
 *                The company that asked is still pinned on the reservation as
 *                requesterWorkspaceId when it is made, and still decides who
 *                may READ it (mayRead); since 2026-10-05 it no longer decides
 *                who may ACT for it.
 *   warehouse    the shared warehouse, operated by whoever holds the existing
 *                warehouse permission for the act. Not a company.
 *
 * The model is Requester Organization <-> Shared Warehouse. It is NOT requester
 * company <-> stock-owner company: the company a category happens to be filed
 * under (ItemCategory.entityId, reported as `stockOwner`) is bookkeeping, and
 * grants or refuses nothing. The head of the warehouse holds a role only in
 * company 6; the pool is filed under company 1; they run all of it.
 *
 * OWNER DECISION 2026-10-05 — "the warehouse is global". The requester side
 * passes when the caller is ON THE CRM TASK, or holds the warehouse permission
 * the act needs. It does NOT pass on a role, or an HR membership, in the
 * project's organisation: a person who merely belongs to the requester's
 * company is not the one holding the drill. Before this, a role in that
 * company was the requester standing, and a warehouse permission counted for
 * nothing on this side.
 *
 * And the two sides must not leak into each other:
 *
 *   A person on the task may ask, change the task's request and hand things
 *   back. They may NOT approve stock, reject a request, or take goods back
 *   onto a shelf — that needs a warehouse permission.
 *
 *   Warehouse staff may approve, allocate, reject, release and receive — and,
 *   since the warehouse is global, ask and hand back for any task.
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
    /** Requester: they are on the CRM task the reservation serves (creator or a role slot). */
    | 'on-the-task'
    /** Requester: they are not on the task and hold no warehouse permission for the act. */
    | 'not-on-the-task'
    /** Either side: they hold the warehouse permission this act needs. */
    | 'warehouse-permission'
    /** Warehouse: they do not. */
    | 'no-warehouse-permission';
  side: Side;
  /** The requester company for a requester verdict (null when the row never pinned one); always null for the warehouse. */
  workspace: Workspace;
};

/** What a caller already established about the actor and this reservation's task. */
export type StandingContext = {
  /**
   * The actor is on the CRM task: its creator, or one of its three role slots
   * (Կատարող, Ստուգող, Պատասխանատու). Asked of CRM, never of the body.
   */
  onTheTask?: boolean;
};

/**
 * The warehouse permission that lets warehouse staff do a REQUESTER-side act
 * for any task (owner, 2026-10-05: the warehouse is global). It is the same
 * permission the route already demands beside the requester's own pass,
 * view_warehouse — pinned against the controllers in two-party.spec.ts. The
 * `both` operations are not here: their warehouse hat is decideWarehouse.
 */
export const REQUESTER_SIDE_WAREHOUSE_PERMISSIONS: Record<string, string[]> = {
  // update_project_task is CRM's own "may edit this task" breadth right (a
  // project manager who is not in a role slot): CRM's rules decide the
  // requester side (owner, 2026-10-05), so it opens the same acts here.
  'reservation.create': ['manage_reservations', 'update_project_task'],
  'reservation.update': ['manage_reservations', 'update_project_task'],
  'return.create': ['manage_resource_returns', 'update_project_task'],
};

/**
 * May this actor act as the REQUESTER of this reservation?
 *
 * Two ways in, and no third:
 *
 *  - they are on the CRM task the reservation serves — the creator or one of
 *    its role slots, which CRM alone knows (`context.onTheTask`);
 *  - they hold the warehouse permission the act needs (super admin,
 *    manage_warehouse, or the operation's own from the map above).
 *
 * What is NOT a way in: a role in the requester's company, a wildcard role,
 * an HR membership. The company that asked is still known (parties.requester)
 * and is reported back, but it grants nothing here — it decides reading, in
 * mayRead. Nothing is guessed for a legacy row whose requester was never
 * pinned either: the task relationship is the same proof whether the company
 * is known or not.
 */
export function decideRequester(
  actor: WarehouseActor,
  parties: ReservationParties,
  context: StandingContext = {},
  operation?: string,
): SideVerdict {
  if (context.onTheTask === true) {
    return { allowed: true, because: 'on-the-task', side: 'requester', workspace: parties.requester };
  }
  const needed = operation !== undefined ? REQUESTER_SIDE_WAREHOUSE_PERMISSIONS[operation] ?? [] : [];
  const holds =
    actor.isSuperAdmin ||
    actor.permissionNames.includes('manage_warehouse') ||
    needed.some((p) => actor.permissionNames.includes(p));
  if (holds) return { allowed: true, because: 'warehouse-permission', side: 'requester', workspace: parties.requester };
  return { allowed: false, because: 'not-on-the-task', side: 'requester', workspace: parties.requester };
}

/**
 * Is this actor in the company that asked — the requester company of the
 * reservation? READ ONLY: this is what lets a company follow its own orders
 * (mayRead) and nothing else. A wildcard role is a role in every company; an
 * unknown requester is nobody's.
 */
export function inRequesterCompany(actor: WarehouseActor, parties: ReservationParties): boolean {
  return decideWorkspace(actor, parties.requester).allowed;
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
 * of, and either may walk away from it — the people on the task as the
 * requester, warehouse staff as the warehouse.
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
 * wearing: the requester's when they are on the task, the warehouse's when a
 * warehouse permission let them in.
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
  if (side === 'requester') return decideRequester(actor, parties, context, operation);
  if (side === 'warehouse') return decideWarehouse(actor, operation);

  const asRequester = decideRequester(actor, parties, context, operation);
  if (asRequester.allowed && asRequester.because === 'on-the-task') return asRequester;
  return decideWarehouse(actor, operation);
}

/**
 * Who may READ a reservation, which is a wider question than who may change it.
 *
 * Four audiences, and leaving any of them out breaks something real:
 *
 *   - the requester's people — a role in the company that asked — or the
 *     store fills orders nobody can follow. This is the one place the
 *     requester company still decides (owner, 2026-10-05: acting for it is
 *     the task's, reading it stays the company's);
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
  if (inRequesterCompany(actor, parties)) return true;
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
