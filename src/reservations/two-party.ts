import { WarehouseActor, Workspace, boundedTo } from '../auth/actor';

/**
 * A reservation has two companies, and they are not interchangeable.
 *
 * THE THING THIS FILE EXISTS TO SAY
 *
 * The warehouse is a shared physical store. Every one of the 71 reservations
 * here whose two companies can both be determined has DIFFERENT ones: company 7
 * and company 3 do the work, companies 1 and 4 own the shelves. Not one row is
 * same-company. So "which workspace does this reservation belong to" has no
 * single answer, and every attempt to give it one is wrong in a way that either
 * trusts the caller or breaks the product.
 *
 * It has two answers:
 *
 *   requester    the company whose work asked for the resource — from the CRM
 *                project, pinned when the reservation was made.
 *   stock owner  the company whose catalogue the item is filed under — from the
 *                item's category, derived on the spot.
 *
 * And two sides of authority that must not leak into each other:
 *
 *   A person who runs projects for the requester may ask, change their own
 *   request, hand things back and confirm receipt. They may NOT approve stock
 *   out of somebody else's store, reject a request, or take goods back onto a
 *   shelf that is not theirs.
 *
 *   A person who runs the stock owner's warehouse may approve, allocate,
 *   reject, release and receive. They may NOT rewrite what the requester asked
 *   for or why — that is another company's business purpose.
 *
 * Some actions belong to both sides and are marked as such. Reading is its own
 * question and lives in `mayRead` below.
 */

/** The two companies of one reservation, either of which may be unknown. */
export type ReservationParties = {
  requester: Workspace;
  stockOwner: Workspace;
};

export type Side = 'requester' | 'stock-owner';

export type SideVerdict = {
  allowed: boolean;
  because:
    /** The actor's roles are not confined to any company, so nothing narrows. */
    | 'unbounded'
    /** They hold a role in that side's company. */
    | 'in-scope'
    /** They hold a role, but somewhere else. */
    | 'outside-scope'
    /** The row cannot say which company that side is. Never a match. */
    | 'unknown-workspace';
  side: Side;
  workspace: Workspace;
};

/**
 * May this actor act on `side` of this reservation?
 *
 * The same three-case rule the rest of the warehouse uses, asked separately per
 * side — which is the whole point. An actor unbounded by their roles passes
 * both, and that is every account in this installation today, so this changes
 * nothing for anyone until a company-scoped role exists. An actor bounded to the
 * requester's company passes the requester side and fails the stock owner's.
 *
 * An unknown company is never a match: a reservation whose project was deleted
 * cannot be acted on from inside a company, because nobody can say whether it
 * is inside it.
 */
export function decideSide(
  actor: WarehouseActor,
  parties: ReservationParties,
  side: Side,
): SideVerdict {
  const workspace = side === 'requester' ? parties.requester : parties.stockOwner;
  const bounds = boundedTo(actor);
  if (bounds === null) return { allowed: true, because: 'unbounded', side, workspace };
  if (workspace === null) return { allowed: false, because: 'unknown-workspace', side, workspace };
  if (bounds.includes(workspace)) return { allowed: true, because: 'in-scope', side, workspace };
  return { allowed: false, because: 'outside-scope', side, workspace };
}

/**
 * Which side each operation belongs to.
 *
 * Written down as data rather than scattered through the service, because the
 * interesting mistakes in a two-party model are not "forgot to check" — they are
 * "checked the wrong side", and that is only visible when the answers sit next
 * to each other.
 *
 * `both` means the action needs standing on either side and is not a leak in
 * either direction: cancelling a reservation ends an arrangement both companies
 * are part of, and either may walk away from it.
 */
export const OPERATION_SIDE: Record<string, Side | 'both'> = {
  /* The requester's business purpose. */
  'reservation.create': 'requester',
  'reservation.update': 'requester',
  'reservation.accept': 'requester',
  'return.create': 'requester',

  /* The stock owner's shelves. */
  'reservation.approve': 'stock-owner',
  'reservation.allocate': 'stock-owner',
  'reservation.reject': 'stock-owner',
  'reservation.release': 'stock-owner',
  'reservation.reallocate': 'stock-owner',
  'return.receive': 'stock-owner',

  /* Either party may end an arrangement they are part of. */
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
): SideVerdict {
  const side = OPERATION_SIDE[operation];
  if (side === undefined) {
    // An operation nobody classified is not quietly allowed. Adding one means
    // deciding whose it is.
    return { allowed: false, because: 'unknown-workspace', side: 'stock-owner', workspace: null };
  }
  if (side !== 'both') return decideSide(actor, parties, side);

  const asRequester = decideSide(actor, parties, 'requester');
  if (asRequester.allowed) return asRequester;
  return decideSide(actor, parties, 'stock-owner');
}

/**
 * Who may READ a reservation, which is a wider question than who may change it.
 *
 * Five audiences, and leaving any of them out breaks something real:
 *
 *   - the requester's people, or the store fills orders nobody can follow;
 *   - the stock owner's people, or warehouse staff cannot fulfil what was asked;
 *   - the people on the task, who are neither and are the ones holding the
 *     drill — decided by CRM, not here, which is why it arrives as a flag;
 *   - warehouse staff with a viewing permission, for the fulfilment screens;
 *   - global admins.
 *
 * What is NOT an audience: "anybody with a token", which is what
 * `GET /reservations/task/:taskId` answered until this phase.
 */
export function mayRead(
  actor: WarehouseActor,
  parties: ReservationParties,
  context: { onTheTask?: boolean; warehouseViewer?: boolean } = {},
): boolean {
  if (actor.isSuperAdmin) return true;
  if (context.onTheTask) return true;
  if (decideSide(actor, parties, 'requester').allowed) return true;
  if (decideSide(actor, parties, 'stock-owner').allowed) return true;
  return context.warehouseViewer === true && boundedTo(actor) === null;
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
