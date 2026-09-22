/**
 * The identity of one financial operation attempt, as warehouse builds it.
 *
 * WHY THIS IS NOT `externalRef`
 *
 * `warehouse_procurement:28` is a SOURCE REFERENCE. It says which order the
 * money is for, and it repeats on purpose: an order refused by finance and
 * resubmitted raises another transfer under the same ref, and one order
 * already produces both `…:28` and `…:28:prepayment`. Three transfers share
 * that ref in the live data.
 *
 * An operation key says which ATTEMPT. Retrying a finalize that failed halfway
 * must reuse it, so the deposit finance already created is found rather than
 * created again. Resubmitting after a rejection must not, because that is a
 * new financial operation that is entitled to its own row.
 *
 * Every part is server-owned and persisted before finance is called: the
 * record id, the payment kind the code itself chose, and `financeAttempt`,
 * which is a column. Nothing here comes from a browser, and nothing is
 * generated fresh per HTTP attempt — a UUID made just before each retry would
 * defeat the entire mechanism.
 */

export type FinanceSource = 'warehouse_procurement' | 'warehouse_maintenance';

export type PaymentKind =
  | 'FULL'
  | 'PREPAYMENT'
  | 'BALANCE'
  | 'ADJUSTMENT'
  | 'REFUND';

/**
 * `warehouse_procurement:28:transfer.prepayment:2`
 *
 * The operation segment names the kind, so a transfer key can never collide
 * with an advance key — finance keeps the two in separate tables with separate
 * unique indexes, and an unnamespaced key would be unique in each while
 * meaning the same operation.
 */
export function transferOperationKey(
  source: FinanceSource,
  recordId: number,
  kind: PaymentKind,
  attempt: number,
): string {
  return `${source}:${recordId}:transfer.${kind.toLowerCase()}:${attempt}`;
}
