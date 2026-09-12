import { WarehouseActor } from '../auth/actor';
import {
  OPERATION_SIDE,
  ReservationParties,
  decideOperation,
  decideSide,
  isWarehouseViewer,
  mayRead,
} from './two-party';

const actor = (over: Partial<WarehouseActor> = {}): WarehouseActor => ({
  userId: 11,
  isSuperAdmin: false,
  isGlobalSuperAdmin: false,
  permissionNames: [],
  home: { wildcard: true, entityIds: [] },
  declared: null,
  ...over,
});

const inWorkspaces = (...ids: number[]) => actor({ home: { wildcard: false, entityIds: ids } });

/** Every caller in this installation today: a role in every company. */
const unbounded = actor();
/** Company 7 does the work; companies 1 and 4 own the shelves. */
const REQUESTER = 7;
const OWNER = 1;
const OUTSIDER_WS = 3;

const parties: ReservationParties = { requester: REQUESTER, stockOwner: OWNER };
const sameCompany: ReservationParties = { requester: OWNER, stockOwner: OWNER };
const noRequester: ReservationParties = { requester: null, stockOwner: OWNER };
const noOwner: ReservationParties = { requester: REQUESTER, stockOwner: null };

describe('the two sides of one reservation', () => {
  it('lets somebody in the requester’s company act as the requester', () => {
    expect(decideSide(inWorkspaces(REQUESTER), parties, 'requester')).toMatchObject({
      allowed: true,
      because: 'in-scope',
    });
  });

  it('and NOT as the stock owner — asking for a thing is not owning the shelf', () => {
    expect(decideSide(inWorkspaces(REQUESTER), parties, 'stock-owner')).toMatchObject({
      allowed: false,
      because: 'outside-scope',
    });
  });

  it('lets the stock owner’s warehouse staff act as the stock owner', () => {
    expect(decideSide(inWorkspaces(OWNER), parties, 'stock-owner').allowed).toBe(true);
  });

  it('and NOT as the requester — running a store is not running somebody’s project', () => {
    expect(decideSide(inWorkspaces(OWNER), parties, 'requester').allowed).toBe(false);
  });

  it('lets somebody who holds both companies act on both sides', () => {
    const both = inWorkspaces(REQUESTER, OWNER);
    expect(decideSide(both, parties, 'requester').allowed).toBe(true);
    expect(decideSide(both, parties, 'stock-owner').allowed).toBe(true);
  });

  it('lets a third company act on neither', () => {
    const stranger = inWorkspaces(OUTSIDER_WS);
    expect(decideSide(stranger, parties, 'requester').allowed).toBe(false);
    expect(decideSide(stranger, parties, 'stock-owner').allowed).toBe(false);
  });

  it('refuses nothing to somebody whose roles are not confined — every account here today', () => {
    expect(decideSide(unbounded, parties, 'requester').allowed).toBe(true);
    expect(decideSide(unbounded, parties, 'stock-owner').allowed).toBe(true);
    expect(decideSide(unbounded, noRequester, 'requester').allowed).toBe(true);
  });

  it('treats an unknown company as a match for nobody who is confined', () => {
    expect(decideSide(inWorkspaces(REQUESTER), noRequester, 'requester')).toMatchObject({
      allowed: false,
      because: 'unknown-workspace',
    });
    expect(decideSide(inWorkspaces(OWNER), noOwner, 'stock-owner').because).toBe('unknown-workspace');
  });

  it('is the ordinary case when both companies are the same one', () => {
    expect(decideSide(inWorkspaces(OWNER), sameCompany, 'requester').allowed).toBe(true);
    expect(decideSide(inWorkspaces(OWNER), sameCompany, 'stock-owner').allowed).toBe(true);
  });
});

describe('which side each operation belongs to', () => {
  it('puts asking, changing the ask, accepting and handing back on the requester', () => {
    for (const op of ['reservation.create', 'reservation.update', 'reservation.accept', 'return.create']) {
      expect(OPERATION_SIDE[op]).toBe('requester');
    }
  });

  it('puts approving, allocating, rejecting, releasing and receiving on the stock owner', () => {
    for (const op of [
      'reservation.approve',
      'reservation.allocate',
      'reservation.reject',
      'reservation.release',
      'reservation.reallocate',
      'return.receive',
    ]) {
      expect(OPERATION_SIDE[op]).toBe('stock-owner');
    }
  });

  it('lets either party end an arrangement they are part of', () => {
    for (const op of ['reservation.cancel', 'reservation.uncancel', 'return.cancel']) {
      expect(OPERATION_SIDE[op]).toBe('both');
      expect(decideOperation(inWorkspaces(REQUESTER), parties, op).allowed).toBe(true);
      expect(decideOperation(inWorkspaces(OWNER), parties, op).allowed).toBe(true);
      expect(decideOperation(inWorkspaces(OUTSIDER_WS), parties, op).allowed).toBe(false);
    }
  });

  it('says which hat let somebody through, for the log', () => {
    expect(decideOperation(inWorkspaces(OWNER), parties, 'reservation.cancel').side).toBe('stock-owner');
    expect(decideOperation(inWorkspaces(REQUESTER), parties, 'reservation.cancel').side).toBe('requester');
  });

  it('refuses an operation nobody has classified, rather than allowing it', () => {
    expect(decideOperation(unbounded, parties, 'reservation.teleport').allowed).toBe(false);
  });
});

describe('the flows this model has to keep working', () => {
  it('company 7 may ask company 1 for a drill — the cross-company case, which is every row here', () => {
    const planner = inWorkspaces(REQUESTER);
    expect(decideOperation(planner, parties, 'reservation.create').allowed).toBe(true);
    expect(decideOperation(planner, parties, 'return.create').allowed).toBe(true);
  });

  it('and company 1’s storekeeper decides whether they get it', () => {
    const keeper = inWorkspaces(OWNER);
    expect(decideOperation(keeper, parties, 'reservation.approve').allowed).toBe(true);
    expect(decideOperation(keeper, parties, 'reservation.reject').allowed).toBe(true);
    expect(decideOperation(keeper, parties, 'return.receive').allowed).toBe(true);
  });

  it('company 7 cannot approve its own request out of company 1’s store', () => {
    expect(decideOperation(inWorkspaces(REQUESTER), parties, 'reservation.approve').allowed).toBe(false);
  });

  it('company 1 cannot rewrite what company 7 asked for', () => {
    expect(decideOperation(inWorkspaces(OWNER), parties, 'reservation.update').allowed).toBe(false);
  });

  it('company 3, who is neither, cannot do either', () => {
    const stranger = inWorkspaces(OUTSIDER_WS);
    for (const op of Object.keys(OPERATION_SIDE)) {
      expect(decideOperation(stranger, parties, op).allowed).toBe(false);
    }
  });

  it('nothing at all can be done from inside a company to a reservation whose requester is unknown', () => {
    const keeper = inWorkspaces(OWNER);
    expect(decideOperation(keeper, noRequester, 'reservation.update').allowed).toBe(false);
    // …except what is genuinely the stock owner's, which is still knowable.
    expect(decideOperation(keeper, noRequester, 'reservation.approve').allowed).toBe(true);
  });
});

describe('who may look', () => {
  const viewer = (over: Partial<WarehouseActor> = {}) =>
    actor({ home: { wildcard: false, entityIds: [OUTSIDER_WS] }, ...over });

  it('lets both companies see it', () => {
    expect(mayRead(inWorkspaces(REQUESTER), parties)).toBe(true);
    expect(mayRead(inWorkspaces(OWNER), parties)).toBe(true);
  });

  it('lets the people holding the drill see it, whichever company they are in', () => {
    expect(mayRead(viewer(), parties, { onTheTask: true })).toBe(true);
  });

  it('does not let a stranger see it', () => {
    expect(mayRead(viewer(), parties)).toBe(false);
  });

  it('lets warehouse staff whose roles are not confined see it, for the fulfilment screens', () => {
    const staff = actor({ permissionNames: ['view_reservations'] });
    expect(isWarehouseViewer(staff)).toBe(true);
    expect(mayRead(staff, parties, { warehouseViewer: true })).toBe(true);
  });

  it('but a warehouse permission does not let a company-scoped person see another company’s', () => {
    const scopedStaff = viewer({ permissionNames: ['view_reservations'] });
    expect(mayRead(scopedStaff, parties, { warehouseViewer: true })).toBe(false);
  });

  it('lets a global admin see it', () => {
    expect(mayRead(actor({ isSuperAdmin: true, home: { wildcard: false, entityIds: [OUTSIDER_WS] } }), parties)).toBe(
      true,
    );
  });

  it('does not let somebody with a token and nothing else see it', () => {
    expect(mayRead(viewer(), parties, { onTheTask: false, warehouseViewer: false })).toBe(false);
  });
});
