/**
 * The key this estate signs and verifies tokens with.
 *
 * WHAT THIS REPLACES
 *
 *     secret: process.env.JWT_SECRET || 'nairon_local_dev_secret',
 *
 * A published fallback. With the variable unset, auth-api would have signed
 * tokens with a string written in this repository and every other service
 * would have verified them against it — so anybody who had read the source
 * could mint a token for any account, super admin included, and no service in
 * the estate could tell it from a real one. Nothing would look wrong: the
 * platform would work perfectly, for everybody.
 *
 * A signing key has no safe default, so there is none. The service refuses to
 * start instead, which is a failure somebody notices in a deploy rather than
 * one nobody notices at all.
 */
function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error(
      'JWT_SECRET is not set. This service signs or verifies session tokens with it and will not ' +
        'fall back to a value that is published in the source.',
    );
  }
  return secret;
}

export const jwtConstants = {
  get secret(): string {
    return requireJwtSecret();
  },
};

/** Called at boot so an unconfigured service fails before it listens. */
export function assertJwtConfigured(): void {
  requireJwtSecret();
}
