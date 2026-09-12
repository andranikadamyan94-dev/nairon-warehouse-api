import { ResourceReturnStatus } from '../common/enums/resource-return-status.enum';
import { quantitiesOf } from './quantities';

/**
 * A stand-in for the four reads `quantitiesOf` makes, shaped exactly as it asks
 * for them. What is under test is the arithmetic and the definitions — the
 * concurrency is tested against real Postgres, where it is the only place it
 * means anything.
 */
const db = (state: {
  requested: number;
  /** Live allocations: what is physically out. */
  out?: number;
  /** Returns already received back. */
  received?: number;
  /** Returns filed and not yet received. */
  pending?: number;
}) =>
  ({
    resourceReservation: { findUnique: async () => ({ quantity: state.requested }) },
    reservationAllocation: { aggregate: async () => ({ _sum: { quantity: state.out ?? 0 } }) },
    resourceReturn: {
      aggregate: async ({ where }: any) => ({
        _sum: {
          quantity:
            where.status === ResourceReturnStatus.RECEIVED ? (state.received ?? 0) : (state.pending ?? 0),
        },
      }),
    },
  }) as never;

describe('what was asked for, what went out, what came back', () => {
  it('a fresh request has been issued nothing and can be issued all of it', async () => {
    const q = await quantitiesOf(db({ requested: 10 }), 1);
    expect(q).toMatchObject({ requested: 10, issued: 0, returned: 0, out: 0, outstandingToIssue: 10, returnable: 0 });
  });

  it('a fully issued request has nothing left to issue and everything to hand back', async () => {
    const q = await quantitiesOf(db({ requested: 10, out: 10 }), 1);
    expect(q).toMatchObject({ issued: 10, out: 10, outstandingToIssue: 0, returnable: 10 });
  });

  it('a partly issued one can still be issued the rest', async () => {
    const q = await quantitiesOf(db({ requested: 10, out: 4 }), 1);
    expect(q).toMatchObject({ issued: 4, outstandingToIssue: 6, returnable: 4 });
  });

  it('keeps the request intact after a return — the whole point of this file', async () => {
    // Asked for 10, was given 10, handed 4 back. The ask is still 10.
    const q = await quantitiesOf(db({ requested: 10, out: 6, received: 4 }), 1);
    expect(q.requested).toBe(10);
    expect(q).toMatchObject({ issued: 10, returned: 4, out: 6 });
  });

  it('and does not let a return quietly restore the right to issue the same units again', async () => {
    const q = await quantitiesOf(db({ requested: 10, out: 6, received: 4 }), 1);
    // 10 have left the shelf against this request, so nothing more may be issued.
    expect(q.outstandingToIssue).toBe(0);
  });

  it('counts a received return once, not twice — the bug this replaced', async () => {
    /*
     * Receiving a return already reduces the allocation it came from. The old
     * formula subtracted it again, so 6 genuinely still out read as 2
     * returnable. Six are out; six can come back.
     */
    const q = await quantitiesOf(db({ requested: 10, out: 6, received: 4 }), 1);
    expect(q.returnable).toBe(6);
  });

  it('holds back what a pending return has already claimed', async () => {
    const q = await quantitiesOf(db({ requested: 10, out: 10, pending: 4 }), 1);
    expect(q.returnable).toBe(6);
  });

  it('and both at once', async () => {
    const q = await quantitiesOf(db({ requested: 10, out: 6, received: 4, pending: 2 }), 1);
    expect(q).toMatchObject({ issued: 10, returned: 4, out: 6, returnable: 4, outstandingToIssue: 0 });
  });

  it('never reports a negative amount, whatever the rows say', async () => {
    const q = await quantitiesOf(db({ requested: 2, out: 1, received: 9, pending: 5 }), 1);
    expect(q.outstandingToIssue).toBe(0);
    expect(q.returnable).toBe(0);
  });

  it('says nothing is returnable when nothing went out', async () => {
    expect((await quantitiesOf(db({ requested: 5 }), 1)).returnable).toBe(0);
  });

  it('treats a reservation that is not there as all zeroes rather than throwing', async () => {
    const missing = {
      resourceReservation: { findUnique: async () => null },
      reservationAllocation: { aggregate: async () => ({ _sum: { quantity: null } }) },
      resourceReturn: { aggregate: async () => ({ _sum: { quantity: null } }) },
    } as never;
    expect(await quantitiesOf(missing, 999)).toMatchObject({ requested: 0, issued: 0, returnable: 0 });
  });
});
