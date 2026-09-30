import { ForbiddenException, SetMetadata } from '@nestjs/common';

/**
 * Delegated AI tokens — what this service lets them do.
 *
 * auth-api mints them for a Nairon AI background run (V3 goals, V5
 * workflows): an ordinary JWT for the owner, same key, `id` and `email` as a
 * login token, plus
 *
 *     act:      { sub: 'ai-goal' | 'ai-workflow', goalId | workflowId, runId? }
 *     scope:    'read'
 *     entityId: the one organisation the run acts in
 *     exp:      five minutes
 *
 * The gateway already holds them to GET — but ai-api reaches this service
 * directly, not through the gateway, so the rule has to live here too. This
 * file is the rule; the global AuthGuard applies it after verifying the token.
 *
 *   DELEGATED_TOKENS_READONLY=true   a token carrying `act` with scope 'read'
 *                                    may make GET requests, with X-Entity-ID
 *                                    equal to its entityId (hr-api also
 *                                    admits no header; see
 *                                    absentEntityAllowed), except on routes
 *                                    marked @NotForDelegatedTokens() (GETs
 *                                    that change something). Everything else
 *                                    is 403.
 *   unset / anything else            a token carrying `act` is 403 outright.
 *                                    None exist until auth-api's own flag is
 *                                    on, so nothing changes today — and a
 *                                    service that has not opted in can never
 *                                    take a write from one.
 *
 * A token without `act` is a normal token; nothing here applies to it.
 *
 * The same file, word for word, lives in hr-api, finance-api and
 * warehouse-api. Keep them in step.
 */

export const DELEGATED_READ_SCOPE = 'read';

export const NOT_FOR_DELEGATED_KEY = 'delegatedTokens:refused';

/**
 * Marks a GET that changes state (marks something received, creates
 * defaults, migrates lazily, hands out a write capability). A delegated
 * token is refused there even though the method is GET.
 */
export const NotForDelegatedTokens = () => SetMetadata(NOT_FOR_DELEGATED_KEY, true);

export type DelegatedRefusal =
  | 'delegated_tokens_disabled'
  | 'unsupported_scope'
  | 'method_not_allowed'
  | 'entity_mismatch'
  | 'route_not_allowed';

export function delegatedReadonlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DELEGATED_TOKENS_READONLY === 'true';
}

export function isDelegatedToken(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const act = (payload as Record<string, unknown>).act;
  return act !== undefined && act !== null;
}

function entityMatches(claim: unknown, header: unknown, absentAllowed: boolean): boolean {
  if (typeof claim !== 'number' || !Number.isSafeInteger(claim) || claim <= 0) return false;
  if (header === undefined && absentAllowed) return true;
  if (typeof header !== 'string') return false; // absent, or duplicated into an array
  return header.trim() === String(claim);
}

export interface DelegatedRequestFacts {
  method: string | undefined;
  entityHeader: unknown;
  /** The route carries @NotForDelegatedTokens(). */
  routeRefused?: boolean;
  /**
   * Set only by a service where a request WITHOUT X-Entity-ID sees less, not
   * more (global grants only) — hr-api, whose /api/entities the other
   * services call with the caller's token and no header to learn membership.
   * Where no header means "every entity's grants" it must stay unset.
   */
  absentEntityAllowed?: boolean;
}

/** Why this request may not proceed on this token, or null. Always null for a normal token. */
export function delegatedRefusal(
  payload: unknown,
  facts: DelegatedRequestFacts,
  env: NodeJS.ProcessEnv = process.env,
): DelegatedRefusal | null {
  if (!isDelegatedToken(payload)) return null;
  if (!delegatedReadonlyEnabled(env)) return 'delegated_tokens_disabled';
  const claims = payload as Record<string, unknown>;
  if (claims.scope !== DELEGATED_READ_SCOPE) return 'unsupported_scope';
  if (String(facts.method ?? '').toUpperCase() !== 'GET') return 'method_not_allowed';
  if (!entityMatches(claims.entityId, facts.entityHeader, !!facts.absentEntityAllowed)) return 'entity_mismatch';
  if (facts.routeRefused) return 'route_not_allowed';
  return null;
}

/** `error` is stable so ai-api can tell this (its own call was wrong) from a rights 403. */
export function delegatedForbidden(reason: DelegatedRefusal): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'delegated_token_forbidden',
    reason,
    message:
      reason === 'method_not_allowed'
        ? 'A delegated read token may only make GET requests.'
        : reason === 'entity_mismatch'
          ? 'A delegated token may only be used in the organisation it was issued for.'
          : reason === 'route_not_allowed'
            ? 'This request changes data and is not open to a delegated token.'
            : 'This delegated token is not accepted here.',
  });
}
