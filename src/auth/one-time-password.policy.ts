import { ForbiddenException, SetMetadata } from '@nestjs/common';

/**
 * One-time-password sessions — what this service lets them do (2026-10-07;
 * design in claude-work/design/OTP-SERVER-ENFORCEMENT.md).
 *
 * auth-api marks the session of an account in one-time-password state
 * (`isOneTimePassword`: a password somebody else chose and handed over) in
 * the token itself:
 *
 *     otp: true        (and a short lifetime)
 *
 * Such a token may call only a route marked @OneTimePasswordAllowed() — in
 * the whole estate that is POST /users/password-reset in hr-api and crm-api —
 * and is a 403 with the stable `error: 'one_time_password_required'` on every
 * other route. Sockets and cookie file reads refuse it outright.
 *
 * The gateway holds the same rule, but ai-api and the CRM sockets reach this
 * service without passing there, so it has to live here too. This file is the
 * rule; the global guard applies it after verifying the token.
 *
 * A token without the claim is a normal token; nothing here applies to it.
 * Until auth-api mints the claim (ONE_TIME_PASSWORD_SESSIONS=true there) this
 * changes nothing.
 *
 * The same file, word for word, lives in hr-api, crm-api, finance-api and
 * warehouse-api. Keep them in step.
 */

export const OTP_CLAIM = 'otp';

export const ONE_TIME_PASSWORD_ALLOWED_KEY = 'oneTimePassword:allowed';

/** The one thing a one-time-password session is for: replacing that password. */
export const OneTimePasswordAllowed = () => SetMetadata(ONE_TIME_PASSWORD_ALLOWED_KEY, true);

/** Present and not explicitly false: fails closed on any value auth-api would never mint. */
export function isOneTimePasswordToken(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const value = (payload as Record<string, unknown>)[OTP_CLAIM];
  return value !== undefined && value !== null && value !== false;
}

/** True when this token may not use this route. Always false for a normal token. */
export function oneTimePasswordRefused(payload: unknown, routeAllowed: boolean): boolean {
  return isOneTimePasswordToken(payload) && !routeAllowed;
}

/** `error` is stable so a client can tell this from a rights 403 and show the set-password step. */
export function oneTimePasswordForbidden(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'one_time_password_required',
    message: 'Մեկանգամյա գաղտնաբառով մուտք գործելուց հետո նախ պետք է սահմանել նոր գաղտնաբառ։',
  });
}
