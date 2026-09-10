/**
 * Quantities are stored as double precision, so weighed goods carry binary
 * floating-point residue: 12.3 kg with 12 reserved leaves 0.3000000000000007
 * free, and that number reaches the screen and every comparison after it.
 *
 * Until the columns become exact decimals, every derived quantity passes
 * through here. Three decimals is the finest the warehouse actually measures
 * (grams on a kilogram), and rounding at that scale is far coarser than the
 * residue it removes.
 */
export const QUANTITY_DECIMALS = 3;

const FACTOR = 10 ** QUANTITY_DECIMALS;

/** Round a computed quantity to the precision the warehouse works in. */
export function roundQty(value: number | null | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  // The epsilon nudges values that landed a hair below a half-step (0.0005
  // arriving as 0.00049999999999999994) onto the side arithmetic intended.
  return Math.round((n + Number.EPSILON * Math.sign(n || 1)) * FACTOR) / FACTOR;
}
