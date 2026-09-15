/**
 * The header this service uses to identify itself to another one.
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE OBJECT
 *
 * Every call site used to build it by hand as
 *
 *     'x-internal-secret': process.env.INTERNAL_SECRET ?? ''
 *
 * which sends an EMPTY CREDENTIAL when the service is unconfigured. Against a
 * peer that fails closed that is a confusing 401 at the far end; against one
 * that fails open it is worse, because an empty string is exactly what the
 * broken comparison on the other side accepted. Either way the mistake belongs
 * here rather than at the far end: a caller that cannot authenticate itself
 * should say so, loudly, at the moment it tries.
 *
 * So there is one function, it refuses to produce a blank credential, and the
 * value is never logged and never returned to anything that renders.
 */
export function internalServiceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const secret = process.env.INTERNAL_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error(
      'INTERNAL_SECRET is not set. This service authenticates to auth-api with it and cannot ' +
        'make internal calls without it.',
    );
  }
  return { ...extra, 'x-internal-secret': secret };
}

/**
 * The secret alone, for the call sites that build their own header object.
 *
 * Same rule as above and the same reason: an unconfigured caller must fail
 * here rather than send an empty string and let the far end decide what that
 * means.
 */
export function requireInternalSecret(): string {
  const secret = process.env.INTERNAL_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error(
      'INTERNAL_SECRET is not set. This service cannot authenticate its internal calls without it.',
    );
  }
  return secret;
}
