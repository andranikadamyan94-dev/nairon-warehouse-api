/**
 * Who is asking, and where.
 *
 * Before this file the warehouse had no answer to the second half. Permissions
 * were resolved with no workspace at all — `getUserAccessInfo(user.id)`, which
 * in this service's own query means "every assignment in every company counts"
 * — so somebody made a warehouse manager of one company was, in effect, a
 * warehouse manager of all seven. No route ever read a workspace header, and
 * the client never sent one.
 *
 * The rules below are deliberately plain functions over plain data: no Nest,
 * no Prisma, no request. That is what lets the mutation path, the preflight
 * path and the tests all ask the same question and get the same answer.
 */

/**
 * A workspace as the warehouse can know it. `null` means UNKNOWN — the row
 * cannot say where it belongs — and unknown is never the same as "everywhere".
 */
export type Workspace = number | null;

/** Wildcard: an assignment with entityId 0 applies in every workspace. */
export const EVERY_WORKSPACE = 0;

export type WarehouseActor = {
  userId: number;

  /** Super admin somewhere; see isGlobalSuperAdmin for "everywhere". */
  isSuperAdmin: boolean;
  isGlobalSuperAdmin: boolean;

  /**
   * Effective permissions, resolved IN `declared` when one was verified and
   * across every assignment when none was. Never the caller's claim.
   */
  permissionNames: string[];

  /**
   * The workspaces this person actually holds a role in, read from their own
   * assignments in the users database. `wildcard` is an assignment with
   * entityId 0 — genuinely every workspace, which is what every role in this
   * installation currently is.
   */
  home: { wildcard: boolean; entityIds: number[] };

  /**
   * The workspace the caller asked to act in (`x-entity-id`), AFTER it was
   * checked against `home`. A claim that survives narrows which permissions
   * this actor holds; a claim that does not is refused outright rather than
   * quietly ignored. `null` means the caller declared nothing, which is what
   * every warehouse client does today — the assistant is the only caller that
   * sends one at all. It never filters stock: the warehouse is one shared pool.
   */
  declared: number | null;
};

/** Why a workspace decision went the way it did — logged, tested, reported. */
export type WorkspaceReason =
  /** The actor holds a wildcard role, so there was nothing to refuse. */
  | 'unbounded'
  /** Known company, one the actor holds a role in. */
  | 'in-scope'
  /** Known company, one they do not. */
  | 'outside-scope'
  /** The row cannot say which company, and the actor is bounded. Never a match. */
  | 'unknown-workspace';

export type WorkspaceVerdict = {
  allowed: boolean;
  because: WorkspaceReason;
  workspace: Workspace;
};

/**
 * Parse `x-entity-id`. Anything that is not a positive integer — absent, empty,
 * `0`, `abc`, an array of repeated headers — is "declared nothing". A caller
 * cannot smuggle a workspace in as junk.
 */
export function readDeclaredWorkspace(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * May this person act as this workspace at all?
 *
 * This is the "narrow, never authorize" rule in one place. A wildcard holder
 * may declare anything; anybody else may declare only a workspace they already
 * hold a role in. Declaring is therefore never a way to acquire standing — at
 * most it is a way to set some of your own aside.
 */
export function mayDeclare(home: WarehouseActor['home'], declared: number): boolean {
  return home.wildcard || home.entityIds.includes(declared);
}

/**
 * The companies an actor holds a role in. `null` means "not bounded" — a
 * wildcard holder, whose role applies in every company.
 *
 * WAREHOUSE V1 CONTRACT. This is the REQUESTER side's boundary and nothing
 * else: whether somebody may act for the company whose work asked for a
 * resource. The warehouse itself is one shared pool for every company, so it is
 * never asked about stock, the catalogue, or the company a category happens to
 * be filed under. Warehouse-side authority is the actor's existing warehouse
 * permissions — the route guards, and the warehouse half of two-party.ts.
 *
 * Note what this does NOT consult: the workspace the caller declared. A
 * declaration narrows the PERMISSIONS the actor holds — resolved in that
 * workspace by WarehouseActorService — and it is refused outright if they hold
 * no role there. It adds no company to this list and removes none.
 */
export function boundedTo(actor: WarehouseActor): number[] | null {
  if (actor.home.wildcard) return null;
  return actor.home.entityIds;
}

/**
 * Whether this actor may act FOR `workspace` — the requester company of a
 * reservation. Never asked about the shared warehouse.
 *
 * Three cases, and the middle one is the one worth being careful about:
 *
 *  - the actor is not bounded — a wildcard role applies in every company, so
 *    whichever company it is, they hold a role there. Nothing is guessed.
 *  - the workspace is UNKNOWN and the actor IS bounded. There is no honest
 *    answer: the row cannot say whether it is inside the boundary. It is
 *    refused, and the refusal says `unknown-workspace` rather than pretending
 *    the row was somewhere. Guessing is the one thing that must not happen —
 *    including guessing from ResourceReservation.entityId, which is a legacy
 *    label and never an input here.
 *  - both are known: they must match.
 *
 * Holding a warehouse permission changes none of this: running the shared
 * warehouse is not a role in the requester's company. Super admins are exempt
 * only within their own scope — a super admin of one company is still bounded
 * by it. Global super admins (a wildcard assignment) are unbounded anyway.
 */
export function decideWorkspace(actor: WarehouseActor, workspace: Workspace): WorkspaceVerdict {
  const bounds = boundedTo(actor);
  if (bounds === null) return { allowed: true, because: 'unbounded', workspace };
  if (workspace === null) return { allowed: false, because: 'unknown-workspace', workspace };
  if (bounds.includes(workspace)) return { allowed: true, because: 'in-scope', workspace };
  return { allowed: false, because: 'outside-scope', workspace };
}
