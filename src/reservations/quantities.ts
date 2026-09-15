import { PrismaService } from 'prisma/prisma.service';

import { roundQty } from '../common/quantity';
import { ResourceReturnStatus } from '../common/enums/resource-return-status.enum';

/**
 * What was asked for, what left the shelf, what came back, what is still out.
 *
 * THE PROBLEM THIS FIXES
 *
 * There was one number where there are four. `ResourceReservation.quantity` held
 * the requested amount, and receiving a return SUBTRACTED from it — so a request
 * for 10 kg became a request for 6 kg the moment 4 came back. The history of
 * what somebody asked for was being used as a scratch counter for physical
 * movement, and after the fact nobody could say what had originally been wanted.
 *
 * So the column is frozen at its canonical meaning — **what was requested, as
 * requested** — and the other three are derived from records that are actually
 * about physical things.
 *
 *   requested   ResourceReservation.quantity, never written after creation
 *               except by an explicit change to the REQUEST itself.
 *
 *   out         the live allocations: what is physically in the requester's
 *               hands right now. Receiving a return reduces exactly this.
 *
 *   returned    the received returns. Immutable rows; the only thing that says
 *               goods actually came back.
 *
 *   issued      out + returned — everything that has ever left the shelf
 *               against this request.
 *
 * WHAT IS NOT DERIVABLE, AND WHY IT IS SAID OUT LOUD
 *
 * Releasing an allocation without a return — which is what cancelling does —
 * reduces `out` and adds nothing to `returned`, so `issued` falls. For goods
 * already handed over that is not true: they left the shelf and a cancellation
 * did not bring them back. The ledger cannot tell those two apart today because
 * a release records no reason a query can read. It is recorded as a known gap
 * rather than papered over with a fifth number.
 */
export type ReservationQuantities = {
  /** What the requester asked for. History; never a counter. */
  requested: number;
  /** Everything that has ever left the shelf against this request. */
  issued: number;
  /** What has actually come back and been received. */
  returned: number;
  /** What is physically out right now — issued minus returned. */
  out: number;
  /** What approval may still hand out: requested minus issued, never below 0. */
  outstandingToIssue: number;
  /** What could still honestly be handed back: out, minus returns already filed. */
  returnable: number;
};

type Db = Pick<PrismaService, 'resourceReservation' | 'reservationAllocation' | 'resourceReturn'>;

/**
 * Measure one reservation.
 *
 * Takes a database handle rather than using its own, so a caller inside a
 * transaction measures what that transaction can see. That is the whole point
 * for anything that then writes: reading outside the transaction and writing
 * inside it is how two callers both pass the same check.
 */
export async function quantitiesOf(db: Db, reservationId: number): Promise<ReservationQuantities> {
  const [reservation, live, received, pending] = await Promise.all([
    db.resourceReservation.findUnique({ where: { id: reservationId }, select: { quantity: true } }),
    db.reservationAllocation.aggregate({
      where: { reservationId, releasedAt: null },
      _sum: { quantity: true },
    }),
    db.resourceReturn.aggregate({
      where: { reservationId, status: ResourceReturnStatus.RECEIVED },
      _sum: { quantity: true },
    }),
    db.resourceReturn.aggregate({
      where: { reservationId, status: ResourceReturnStatus.PENDING },
      _sum: { quantity: true },
    }),
  ]);

  /*
   * Every number passes through roundQty. Quantities are double precision, so
   * 12.3 minus 12 lands as 0.3000000000000007, and that residue would reach
   * the over-issue comparison — refusing a legitimate issue, or admitting one
   * a hair over the entitlement. Three decimals is what the warehouse measures
   * (common/quantity.ts); this file does not invent its own precision.
   *
   * The definitions are unchanged: issued is still out + returned, so goods
   * that came back still count as having left.
   */
  const requested = roundQty(reservation?.quantity ?? 0);
  const out = roundQty(live._sum.quantity ?? 0);
  const returned = roundQty(received._sum.quantity ?? 0);
  const awaiting = roundQty(pending._sum.quantity ?? 0);
  const issued = roundQty(out + returned);

  return {
    requested,
    issued,
    returned,
    out,
    outstandingToIssue: Math.max(0, roundQty(requested - issued)),
    /*
     * What is out, less what is already waiting to come back. RECEIVED returns
     * are NOT subtracted again: receiving one already reduced the allocation it
     * came from, so counting it here too would subtract it twice and make a
     * reservation look less returnable after every partial return.
     */
    returnable: Math.max(0, roundQty(out - awaiting)),
  };
}
