import { ForbiddenException, SetMetadata } from '@nestjs/common';

/**
 * Delegated WRITE tokens — Nairon AI V3.4 standing approvals
 * («Կանխավ հաստատում»; design V3-long-running-goals.md §3.2).
 *
 * auth-api mints one for ONE standing approval's ONE call:
 *
 *     act:      { sub: 'ai-goal', goalId, runId, approvalId }
 *     scope:    'goal:write:<tool>:<approvalId>'
 *     entityId: the one organisation the goal acts in
 *     target:   the one record the approval froze — { chatId } for a message,
 *               { taskId, itemId, quantity[, projectId] } for a reservation
 *     exp:      two minutes;  jti: unique
 *
 * ai-api calls this service directly, not through the gateway, so the rule
 * lives here as well as there. With DELEGATED_TOKENS_WRITE=true such a token
 * is accepted ONLY on a handler marked @DelegatedWriteRoute(<that tool>), and
 * only when, all of them:
 *
 *   - the scope parses, names a tool in WRITE_TOOL_RIGHTS, and act names the
 *     same approval (act.sub 'ai-goal');
 *   - the request is on the token's signed target and nothing else: the
 *     chat's :id in the path; the reservation body's task, project (exactly
 *     when frozen) and its one item and quantity, with only a start date
 *     besides (targetMatches);
 *   - X-Entity-ID is present and equals the token's entityId;
 *   - HR says, now, over the internal channel (not the token), that the
 *     person belongs to that organisation;
 *   - the person holds, literally in that organisation, use_ai_assistant,
 *     ai_long_goals, ai_write_actions, ai_standing_approvals and the tool's own
 *     right — super admin stands in for none of them;
 *   - on the mutation route, this token (its jti) has not made a mutation
 *     here before. One token, one write.
 *
 * Everything else is 403 `delegated_token_forbidden`; an expired or forged
 * token never gets here (401 in AuthGuard). The handler's own guards and
 * business rules then run as for the person — PermissionGuard, chat
 * membership, stock rules, idempotency — so this only ever narrows.
 *
 * DELEGATED_TOKENS_WRITE unset: a write-scoped token falls to the read-only
 * rule (delegated-token.policy.ts), which refuses it exactly as before.
 *
 * The same file, word for word, lives in crm-api and warehouse-api; each
 * marks only its own routes. Adding a tool is a change here, in auth-api's
 * WRITE_TOOLS and the gateway's GOAL_WRITE_ROUTES, and a security review.
 */

export const WRITE_SCOPE_PREFIX = 'goal:write:';

export const DELEGATED_WRITE_ROUTE_KEY = 'delegatedTokens:writeRoute';

export type DelegatedWriteRouteKind = 'preflight' | 'mutation';

export interface DelegatedWriteRouteMeta {
  tool: string;
  kind: DelegatedWriteRouteKind;
}

/**
 * Marks the one handler (method + path) a tool's write token may call here.
 * `preflight` writes nothing; `mutation` is single-use per token.
 */
export const DelegatedWriteRoute = (tool: string, kind: DelegatedWriteRouteKind) =>
  SetMetadata(DELEGATED_WRITE_ROUTE_KEY, Object.freeze({ tool, kind }) as DelegatedWriteRouteMeta);

/** Held literally, in the token's organisation, by every write-token use. */
export const WRITE_REQUIRED_AI_PERMISSIONS = [
  'use_ai_assistant',
  'ai_long_goals',
  'ai_write_actions',
  'ai_standing_approvals',
] as const;

/**
 * The tools, and the business right each needs on top (any one of, literally).
 * Empty: the service has no right for it and decides per record (a chat's
 * members may post into it).
 */
export const WRITE_TOOL_RIGHTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'warehouse.reservations.create': Object.freeze(['view_warehouse', 'manage_reservations', 'manage_warehouse']),
  'chat.messages.send': Object.freeze([] as string[]),
});

/** Each tool's target fields: required, then optional. The same rule auth-api signs by. */
export const WRITE_TARGETS: Readonly<Record<string, { required: readonly string[]; optional: readonly string[] }>> = Object.freeze({
  'warehouse.reservations.create': Object.freeze({ required: ['taskId', 'itemId', 'quantity'], optional: ['projectId'] }),
  'chat.messages.send': Object.freeze({ required: ['chatId'], optional: [] }),
});

export type WriteTarget = Readonly<Record<string, number>>;

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** The token's `target` claim, if it has exactly the tool's shape. */
export function targetOf(tool: string, raw: unknown): WriteTarget | null {
  const rule = Object.prototype.hasOwnProperty.call(WRITE_TARGETS, tool) ? WRITE_TARGETS[tool] : null;
  if (!rule || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  const known = [...rule.required, ...rule.optional];
  if (Object.keys(t).some((k) => !known.includes(k))) return null;
  if (!rule.required.every((k) => positive(t[k]))) return null;
  if (!rule.optional.every((k) => t[k] === undefined || positive(t[k]))) return null;
  return t as WriteTarget;
}

/**
 * Is this request on the token's target, and on nothing else?
 *   chat.messages.send             the route's :id is target.chatId
 *   warehouse.reservations.create  the body is the frozen taskId, projectId
 *                                  (iff frozen), exactly one resource of the
 *                                  frozen itemId and quantity, and a startDate
 */
export function targetMatches(tool: string, target: WriteTarget, request: { params?: unknown; body?: unknown }): boolean {
  if (tool === 'chat.messages.send') {
    const id = (request.params as Record<string, unknown> | undefined)?.id;
    return typeof id === 'string' && /^[1-9][0-9]{0,9}$/.test(id) && Number(id) === target.chatId;
  }
  if (tool === 'warehouse.reservations.create') {
    const b = request.body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
    if (Object.keys(b).some((k) => !['taskId', 'projectId', 'startDate', 'resources'].includes(k))) return false;
    if (b.taskId !== target.taskId) return false;
    if (target.projectId === undefined ? b.projectId !== undefined : b.projectId !== target.projectId) return false;
    if (typeof b.startDate !== 'string' || b.startDate.length > 40) return false;
    if (!Array.isArray(b.resources) || b.resources.length !== 1) return false;
    const r = b.resources[0] as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Object.keys(r).some((k) => k !== 'itemId' && k !== 'quantity')) return false;
    return r.itemId === target.itemId && r.quantity === target.quantity;
  }
  return false;
}

export type DelegatedWriteRefusal =
  | 'malformed_write_scope'
  | 'unknown_write_tool'
  | 'act_mismatch'
  | 'malformed_write_target'
  | 'target_mismatch'
  | 'route_not_allowed'
  | 'entity_mismatch'
  | 'not_a_member'
  | 'missing_permission'
  | 'token_already_used';

export function delegatedWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DELEGATED_TOKENS_WRITE === 'true';
}

/** A token carrying `act` whose scope begins `goal:write:`. */
export function isDelegatedWriteToken(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const claims = payload as Record<string, unknown>;
  return claims.act !== undefined && claims.act !== null &&
    typeof claims.scope === 'string' && claims.scope.startsWith(WRITE_SCOPE_PREFIX);
}

const TOOL = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const APPROVAL = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

export function parseWriteScope(scope: unknown): { tool: string; approvalId: string } | null {
  if (typeof scope !== 'string' || !scope.startsWith(WRITE_SCOPE_PREFIX)) return null;
  const parts = scope.slice(WRITE_SCOPE_PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  const [tool, approvalId] = parts;
  return TOOL.test(tool) && APPROVAL.test(approvalId) ? { tool, approvalId } : null;
}

export interface DelegatedWriteFacts {
  method: string | undefined;
  entityHeader: unknown;
  /** The handler's @DelegatedWriteRoute marker, if any. */
  route: DelegatedWriteRouteMeta | undefined;
  /** Express route params and the parsed JSON body, as the handler will see them. */
  params?: unknown;
  body?: unknown;
}

export interface DelegatedWriteGrant {
  tool: string;
  approvalId: string;
  entityId: number;
  userId: number;
  kind: DelegatedWriteRouteKind;
  target: WriteTarget;
}

/**
 * The synchronous half: the token's own shape against this route. Returns the
 * grant to verify further, or the refusal. Only for a token
 * `isDelegatedWriteToken` says is one, with the flag on.
 */
export function delegatedWriteCheck(payload: unknown, facts: DelegatedWriteFacts): DelegatedWriteGrant | DelegatedWriteRefusal {
  const claims = payload as Record<string, unknown>;
  const scope = parseWriteScope(claims.scope);
  if (!scope) return 'malformed_write_scope';
  if (!Object.prototype.hasOwnProperty.call(WRITE_TOOL_RIGHTS, scope.tool)) return 'unknown_write_tool';
  const act = claims.act as Record<string, unknown> | null;
  if (!act || typeof act !== 'object' || act.sub !== 'ai-goal' || act.approvalId !== scope.approvalId || typeof act.goalId !== 'string') {
    return 'act_mismatch';
  }
  const target = targetOf(scope.tool, claims.target);
  if (!target) return 'malformed_write_target';
  if (!facts.route || facts.route.tool !== scope.tool) return 'route_not_allowed';
  if (!targetMatches(scope.tool, target, { params: facts.params, body: facts.body })) return 'target_mismatch';
  const entityId = claims.entityId;
  if (typeof entityId !== 'number' || !Number.isSafeInteger(entityId) || entityId <= 0) return 'entity_mismatch';
  if (typeof facts.entityHeader !== 'string' || facts.entityHeader.trim() !== String(entityId)) return 'entity_mismatch';
  const userId = Number(claims.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return 'act_mismatch';
  return { tool: scope.tool, approvalId: scope.approvalId, entityId, userId, kind: facts.route.kind, target };
}

/** Which required right is missing, literally, or null when all are held. */
export function missingWriteRight(tool: string, permissionNames: readonly string[]): string | null {
  const held = new Set(permissionNames);
  const ai = WRITE_REQUIRED_AI_PERMISSIONS.find((p) => !held.has(p));
  if (ai) return ai;
  const anyOf = Object.prototype.hasOwnProperty.call(WRITE_TOOL_RIGHTS, tool) ? WRITE_TOOL_RIGHTS[tool] : null;
  if (!anyOf) return tool;
  if (anyOf.length && !anyOf.some((p) => held.has(p))) return anyOf.join('|');
  return null;
}

/**
 * One mutation per token. Kept in this process: a token lives two minutes and
 * this service runs as one instance; a restart forgets, which the ai-api side
 * (UNIQUE approval+occurrence, Idempotency-Key) still covers.
 */
export class WriteTokenLedger {
  private readonly used = new Map<string, number>();

  /** True the first time a jti is spent; false after, or with no jti at all. */
  spend(jti: unknown, expSec: unknown, now = Date.now()): boolean {
    if (typeof jti !== 'string' || jti === '') return false;
    for (const [k, until] of this.used) if (until <= now) this.used.delete(k);
    if (this.used.has(jti)) return false;
    const until = typeof expSec === 'number' && Number.isFinite(expSec) ? expSec * 1000 : now + 10 * 60_000;
    this.used.set(jti, Math.max(until, now + 1000));
    return true;
  }
}

export const writeTokenLedger = new WriteTokenLedger();

export function delegatedWriteForbidden(reason: DelegatedWriteRefusal): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'delegated_token_forbidden',
    reason,
    message:
      reason === 'route_not_allowed'
        ? 'A delegated write token may only call the one action it was issued for.'
        : reason === 'target_mismatch'
          ? 'A delegated write token may only act on the one record it was issued for.'
          : reason === 'entity_mismatch' || reason === 'not_a_member'
            ? 'A delegated token may only be used in the organisation it was issued for.'
            : reason === 'missing_permission'
              ? 'The person no longer holds a right this action needs.'
              : reason === 'token_already_used'
                ? 'This delegated write token has already been used.'
                : 'This delegated token is not accepted here.',
  });
}
