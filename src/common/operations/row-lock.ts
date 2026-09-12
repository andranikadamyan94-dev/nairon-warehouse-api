/**
 * Make two transactions take turns.
 *
 * WHY A RE-READ WAS NOT ENOUGH
 *
 * Moving a check inside a transaction feels like it fixes a race and does not.
 * Postgres runs READ COMMITTED by default, so two transactions asking "how much
 * is left?" at the same moment each see the world without the other's
 * uncommitted rows in it. Both get the same answer, both decide yes, both
 * commit. The live acceptance caught exactly this twice: two requests for the
 * last three units were both accepted, and two people handing back the same six
 * both filed a return.
 *
 * What actually serialises them is a lock somebody has to wait for. Taking one
 * on the row everything in that decision hangs off — the item whose stock is
 * being counted, the reservation whose outstanding amount is being measured —
 * makes the second transaction block until the first commits, and then measure
 * again with the first one's work visible.
 *
 * The alternatives were considered and are worse here. SERIALIZABLE turns this
 * into a retry loop every caller has to handle. A conditional UPDATE works
 * beautifully for a single counter — it is what the stock decrement uses — but
 * these checks are aggregates over other tables, and there is no single row
 * whose WHERE clause can carry the invariant.
 *
 * Always lock before measuring, and always in the same order across the
 * codebase (item, then reservation) so two callers cannot each hold what the
 * other is waiting for.
 */

type RawCapable = { $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown> };

/**
 * Lock one item's row for the rest of this transaction.
 *
 * Anything that counts stock, or counts what has been promised out of it, takes
 * this first. A missing item locks nothing and says so by returning false — the
 * caller's own not-found message is better than one from here.
 */
export async function lockItem(tx: RawCapable, itemId: number): Promise<boolean> {
  const rows = (await tx.$queryRawUnsafe(
    'SELECT id FROM "Item" WHERE id = $1 FOR UPDATE',
    itemId,
  )) as unknown[];
  return rows.length > 0;
}

/**
 * Lock one reservation's row for the rest of this transaction.
 *
 * Anything that measures what is out against it, or files something that
 * changes that, takes this first.
 */
export async function lockReservation(tx: RawCapable, reservationId: number): Promise<boolean> {
  const rows = (await tx.$queryRawUnsafe(
    'SELECT id FROM "ResourceReservation" WHERE id = $1 FOR UPDATE',
    reservationId,
  )) as unknown[];
  return rows.length > 0;
}
