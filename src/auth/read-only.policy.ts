import { ExecutionContext, ForbiddenException } from '@nestjs/common';

/**
 * Read-only super administrators.
 *
 * A role flagged `Role.readOnly` in the users database (the «Read-Only Super
 * Admin» role is `isSuperAdmin` + `readOnly`) sees everything its super-admin
 * flag opens and changes nothing. The two halves are deliberately kept apart:
 * what a holder SEES is still whatever `isSuperAdmin` and the permission names
 * say, untouched by this file. This file is only the other half — the refusal.
 *
 * THE RULE
 *
 * An authenticated caller holding ANY read-only role, in any organisation, is
 * refused every request whose method is not GET, HEAD or OPTIONS, with
 * READ_ONLY_FORBIDDEN, before the route's own rights are looked at and before
 * PermissionGuard's super-admin bypass. The flag is part of the actor
 * (auth/actor.ts, `readOnly`) and the global AuthGuard applies the rule right
 * after resolving it. Public routes carry no user, and the internal
 * (x-internal-secret) routes are @Public, so neither is touched. A delegated
 * WRITE token acting for a read-only holder is refused the same way.
 *
 * THE ONE ALLOWLIST
 *
 * READ_ONLY_ALLOWED_WRITES names the non-GET handlers that write nothing and a
 * reader needs, as `Controller.handler`. In warehouse-api that is the stock
 * availability check, a POST only because its question is a list of lines.
 * Preflights (`POST .../preflight/<action>`) are deliberately NOT listed: a
 * preflight answers "could this person do this, right now?", and for a
 * read-only holder the honest answer is this same 403 — exactly what the
 * mutation would say.
 *
 * The same file, adapted to each guard, lives in hr-api, crm-api,
 * finance-api and marketing-api. Keep them in step.
 */
export const READ_ONLY_FORBIDDEN = 'Միայն դիտման իրավունք. փոփոխություններն արգելված են';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `Controller.handler` of every non-GET route a read-only holder may still call. */
export const READ_ONLY_ALLOWED_WRITES: ReadonlySet<string> = new Set<string>([
  'AvailabilityController.checkAvailability', // POST /availability/check — reads stock for a list of lines
]);

export function isReadMethod(method: string | undefined): boolean {
  return READ_METHODS.has(String(method ?? '').toUpperCase());
}

/** The allowlist key for the route being executed. */
export function routeKey(context: ExecutionContext): string {
  return `${context.getClass()?.name ?? ''}.${context.getHandler()?.name ?? ''}`;
}

/** Whether this request must be refused: a read-only holder, a writing method, no allowlist entry. */
export function readOnlyRefused(readOnly: boolean | undefined, method: string | undefined, key: string): boolean {
  return readOnly === true && !isReadMethod(method) && !READ_ONLY_ALLOWED_WRITES.has(key);
}

export function readOnlyForbidden(): ForbiddenException {
  return new ForbiddenException(READ_ONLY_FORBIDDEN);
}
