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
   * sends one at all. See boundedTo for why it does not also filter stock.
   */
  declared: number | null;
};

/** Why a workspace decision went the way it did — logged, tested, reported. */
export type WorkspaceReason =
  /** The actor was not bounded at all, so there was nothing to refuse. */
  | 'unbounded'
  /** Known workspace, inside the actor's boundary. */
  | 'in-scope'
  /** Known workspace, outside it. */
  | 'outside-scope'
  /** The row cannot say where it is, and the actor is bounded. Never a match. */
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
 * The workspaces an actor may touch. `null` means "not bounded" — a wildcard
 * holder, which is every account in this installation today and is exactly why
 * nothing below changes what anyone can currently do.
 *
 * Note what this does NOT consult: the workspace the caller declared. That is
 * on purpose, and it is the one place where the warehouse differs from CRM and
 * HR. Stock here is a shared physical pool: company 7's task reserves company
 * 1's drill, which is not a leak but the reason the warehouse exists — 44 of
 * the 62 labelled reservations in this installation cross that line. So the
 * company somebody is currently acting as is not a statement about which stock
 * exists, and reading it as one would empty the catalogue for everybody whose
 * company keeps no catalogue of its own.
 *
 * What a declaration does instead is narrow the PERMISSIONS the actor holds —
 * resolved in that workspace by WarehouseActorService — and it is refused
 * outright if they hold no role there. Somebody who wants to look at one
 * company's catalogue asks for it: `GET /categories?entityId=4` is a filter,
 * and a bounded actor's own scope is still applied on top of it.
 */
export function boundedTo(actor: WarehouseActor): number[] | null {
  if (actor.home.wildcard) return null;
  return actor.home.entityIds;
}

/**
 * Whether this actor may act on a resource that lives in `workspace`.
 *
 * Three cases, and the middle one is the one worth being careful about:
 *
 *  - the actor is not bounded — nothing was narrowed, so nothing is refused.
 *    Every caller in this installation is here today, which is why this phase
 *    tightens the rules without changing what anyone can currently do.
 *  - the resource's workspace is UNKNOWN and the actor IS bounded. There is no
 *    honest answer: the row cannot say whether it is inside the boundary. It is
 *    refused, and the refusal says `unknown-workspace` rather than pretending
 *    the resource was somewhere. Guessing is the one thing that must not happen.
 *  - both are known: they must match.
 *
 * Super admins are exempt only within their own scope — a super admin of one
 * company who declared it is still bounded by it. Global super admins (a
 * wildcard assignment) are unbounded by the first case anyway.
 */
export function decideWorkspace(actor: WarehouseActor, workspace: Workspace): WorkspaceVerdict {
  const bounds = boundedTo(actor);
  if (bounds === null) return { allowed: true, because: 'unbounded', workspace };
  if (workspace === null) return { allowed: false, because: 'unknown-workspace', workspace };
  if (bounds.includes(workspace)) return { allowed: true, because: 'in-scope', workspace };
  return { allowed: false, because: 'outside-scope', workspace };
}

/**
 * Which workspace a newly created row must be filed under, when the caller
 * named one. A bound actor may only create inside their own boundary; an
 * unbounded one keeps today's behaviour, where the request says.
 *
 * Returns the workspace to store, or a refusal. This is how a caller-supplied
 * `entityId` stops being authorization and becomes, at most, a choice among
 * things the actor could already do.
 */
export type CreationWorkspace = {
  ok: boolean;
  /** Where to file it, when ok. */
  workspace: Workspace;
  /** What the caller asked for, when not ok — null meaning they asked for nothing. */
  requested: Workspace;
};

export function decideCreationWorkspace(
  actor: WarehouseActor,
  requested: number | null | undefined,
): CreationWorkspace {
  const bounds = boundedTo(actor);
  const asked = requested == null ? null : Number(requested);
  if (bounds === null) return { ok: true, workspace: asked, requested: asked };
  if (asked === null) {
    // A bound actor who named nothing: file it where they are. That is only
    // unambiguous when the boundary is a single workspace, which a declaration
    // guarantees and a two-company role does not.
    return bounds.length === 1
      ? { ok: true, workspace: bounds[0], requested: null }
      : { ok: false, workspace: null, requested: null };
  }
  return bounds.includes(asked)
    ? { ok: true, workspace: asked, requested: asked }
    : { ok: false, workspace: null, requested: asked };
}
