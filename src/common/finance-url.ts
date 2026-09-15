/**
 * Where finance-api is, or a refusal.
 *
 * WHAT THIS REPLACES, AND WHY IT MATTERED
 *
 *     const financeUrl = process.env.FINANCE_API_URL || 'http://localhost:3005';
 *
 * 3005 is **this service's own port**. So an unset variable did not fail, and
 * did not reach finance — it made warehouse-api POST a transfer to itself, on
 * four different money paths. The best case is a 404 that looks like a network
 * blip; the worst is that a future route at that path does something with it.
 *
 * A money call with no destination has to fail before it mutates anything, not
 * fall back to a guess. There is no default here on purpose.
 */
export function requireFinanceUrl(): string {
  const url = process.env.FINANCE_API_URL;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error(
      'FINANCE_API_URL is not set. This operation raises a transfer in finance-api and will not ' +
        'guess where that is — refusing before anything is written.',
    );
  }
  return url.replace(/\/+$/, '');
}
