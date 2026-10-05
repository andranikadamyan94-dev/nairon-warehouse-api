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
   * Holds a role flagged readOnly, in any organisation: sees whatever the two
   * flags above open and is refused every writing request — the global
   * AuthGuard, with auth/read-only.policy.ts.
   */
  readOnly: boolean;

  /**
   * Effective permissions. For an ordinary session: across every assignment
   * in every organisation, whatever the browser has selected — "the warehouse
   * is global" (owner, 2026-10-05). For a delegated AI token: in `declared`
   * only, the organisation the token was issued for. Never the caller's claim.
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
   * checked against `home` — see settleDeclaration. For an ordinary session
   * it is a label only: new records are stamped with it and it narrows no
   * permission; a claim the person cannot back is dropped to `null`, the same
   * as declaring nothing. For a delegated token it is the organisation the
   * token was issued for — the only one its permissions are resolved in — and
   * a claim that fails is refused outright. The warehouse client sends the
   * header on every request since 2026-10-02. It never filters stock: the
   * warehouse is one shared pool.
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
 * most (for a delegated token) it is a way to set some of your own aside.
 */
export function mayDeclare(home: WarehouseActor['home'], declared: number): boolean {
  return home.wildcard || home.entityIds.includes(declared);
}

/**
 * The workspace PERMISSIONS are resolved in — the second argument of
 * UsersPrismaService.getUserAccessInfo, where EVERY_WORKSPACE means "every
 * assignment in every organisation counts".
 *
 * "The warehouse is global" (owner, 2026-10-05): an ordinary session's rights
 * never depend on the organisation the browser has selected. The keeper whose
 * warehouse role lives in company 6 keeps every right with company 1 open —
 * before this, the header the client sends on every request (2026-10-02) cost
 * them all of it. A delegated AI token is the one exception: it was issued for
 * a single organisation, AuthGuard has already held its header to that one,
 * and its rights are that organisation's only.
 */
export function accessWorkspace(delegated: boolean, declared: number | null): number {
  return delegated && declared !== null ? declared : EVERY_WORKSPACE;
}

export type Declaration =
  /** A delegated token claimed a workspace the person holds no role in. */
  | { refused: true }
  | { refused: false; declared: number | null; resolveIn: number };

/**
 * What becomes of the workspace a caller declared.
 *
 * An ordinary session: the claim is a label. Kept as `declared` when the
 * person can back it — new records are stamped with it — and dropped to
 * "declared nothing" when they cannot, never refused: the person merely has
 * another company open in the browser, and refusing would lock them out of a
 * warehouse that is one shared pool anyway. Permissions resolve across every
 * organisation either way (accessWorkspace).
 *
 * A delegated AI token keeps the strict rule it had: a claim it cannot back
 * is refused — a silent downgrade to "everything you can do anywhere" would
 * be the worst possible answer for a token minted for one organisation — and
 * its permissions are resolved in the claimed organisation only.
 */
export function settleDeclaration(home: WarehouseActor['home'], asked: number | null, delegated: boolean): Declaration {
  const claimable = asked !== null && mayDeclare(home, asked);
  if (delegated) {
    if (asked !== null && !claimable) return { refused: true };
    return { refused: false, declared: asked, resolveIn: accessWorkspace(true, asked) };
  }
  return { refused: false, declared: claimable ? asked : null, resolveIn: accessWorkspace(false, asked) };
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
 * Note what this does NOT consult: the workspace the caller declared. For a
 * session a declaration is a label (settleDeclaration); for a delegated token
 * it narrows the PERMISSIONS to that organisation. It adds no company to this
 * list and removes none.
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
