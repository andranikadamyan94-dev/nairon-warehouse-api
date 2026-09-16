import {
  WarehouseActor,
  boundedTo,
  decideWorkspace,
  mayDeclare,
  readDeclaredWorkspace,
} from './actor';

const actor = (over: Partial<WarehouseActor> = {}): WarehouseActor => ({
  userId: 11,
  isSuperAdmin: false,
  isGlobalSuperAdmin: false,
  permissionNames: ['manage_items'],
  home: { wildcard: true, entityIds: [] },
  declared: null,
  ...over,
});

/** A wildcard role holder: a role in every company. */
const unbounded = actor();
/** Somebody whose only role lives in company 1. */
const inOne = actor({ home: { wildcard: false, entityIds: [1] } });

describe('reading the workspace a caller declared', () => {
  it('takes a positive integer', () => {
    expect(readDeclaredWorkspace('4')).toBe(4);
    expect(readDeclaredWorkspace(4)).toBe(4);
  });

  it('treats anything else as declaring nothing, rather than as workspace zero', () => {
    for (const junk of [undefined, null, '', '0', 0, '-1', 'abc', '1.5', {}, true]) {
      expect(readDeclaredWorkspace(junk)).toBeNull();
    }
  });

  it('takes the first of a repeated header rather than an array', () => {
    expect(readDeclaredWorkspace(['4', '9'])).toBe(4);
  });
});

describe('who may declare a workspace', () => {
  it('lets a wildcard holder declare any of them', () => {
    expect(mayDeclare({ wildcard: true, entityIds: [] }, 7)).toBe(true);
  });

  it('lets everybody else declare only their own', () => {
    expect(mayDeclare({ wildcard: false, entityIds: [1, 4] }, 4)).toBe(true);
    expect(mayDeclare({ wildcard: false, entityIds: [1, 4] }, 7)).toBe(false);
  });

  it('never lets a header add a workspace somebody does not hold', () => {
    expect(mayDeclare({ wildcard: false, entityIds: [] }, 1)).toBe(false);
  });
});

describe('the organization boundary — the companies somebody holds a role in', () => {
  it('is nothing at all for a wildcard holder who declared nothing', () => {
    expect(boundedTo(unbounded)).toBeNull();
  });

  it('stays nothing for a wildcard holder even when they declare a company', () => {
    // A declaration narrows the permissions the actor holds — see
    // WarehouseActorService — not the companies they hold a role in.
    expect(boundedTo(actor({ declared: 4 }))).toBeNull();
  });

  it('is their own workspaces when their roles are scoped', () => {
    expect(boundedTo(actor({ home: { wildcard: false, entityIds: [1, 4] } }))).toEqual([1, 4]);
  });
});

describe('may this actor act for this company · the requester side', () => {
  it('refuses nothing to a wildcard role holder, whose role is in every company', () => {
    expect(decideWorkspace(unbounded, 4).allowed).toBe(true);
    expect(decideWorkspace(unbounded, null).allowed).toBe(true);
    expect(decideWorkspace(unbounded, 4).because).toBe('unbounded');
  });

  it('allows a bounded actor for their own company', () => {
    expect(decideWorkspace(inOne, 1)).toMatchObject({ allowed: true, because: 'in-scope' });
  });

  it('refuses a bounded actor for another company', () => {
    expect(decideWorkspace(inOne, 4)).toMatchObject({
      allowed: false,
      because: 'outside-scope',
      workspace: 4,
    });
  });

  it('refuses an unknown company rather than guessing at one', () => {
    expect(decideWorkspace(inOne, null)).toMatchObject({
      allowed: false,
      because: 'unknown-workspace',
    });
  });

  it('says which of the two it was, because they are not the same problem', () => {
    expect(decideWorkspace(inOne, 4).because).not.toBe(decideWorkspace(inOne, null).because);
  });

  it('lets somebody who holds two companies act for both, declaration or not', () => {
    const both = actor({ home: { wildcard: false, entityIds: [1, 4] }, declared: 1 });
    expect(decideWorkspace(both, 4).allowed).toBe(true);
    expect(decideWorkspace(both, 7).allowed).toBe(false);
  });

  it('holds a scoped super admin to the companies they hold a role in', () => {
    const scoped = actor({
      isSuperAdmin: true,
      home: { wildcard: false, entityIds: [1] },
      declared: 1,
    });
    expect(decideWorkspace(scoped, 4).allowed).toBe(false);
    expect(decideWorkspace(scoped, 1).allowed).toBe(true);
  });

  it('leaves a global super admin unbounded, because a wildcard role is what that means', () => {
    const global = actor({ isSuperAdmin: true, isGlobalSuperAdmin: true });
    expect(decideWorkspace(global, 4).allowed).toBe(true);
  });
});

describe('a warehouse permission is not a role in anybody’s company', () => {
  /** The warehouse head on real data: every warehouse right, one role, in company 6. */
  const warehouseHead = actor({
    permissionNames: ['manage_warehouse', 'manage_reservations', 'manage_resource_returns', 'manage_items'],
    home: { wildcard: false, entityIds: [6] },
  });

  it('does not let warehouse staff act for company 3, 4 or 1', () => {
    for (const company of [1, 3, 4]) {
      expect(decideWorkspace(warehouseHead, company)).toMatchObject({ allowed: false, because: 'outside-scope' });
    }
  });

  it('does not stand in for an unknown requester either', () => {
    expect(decideWorkspace(warehouseHead, null)).toMatchObject({ allowed: false, because: 'unknown-workspace' });
  });

  it('still lets them act for the company their role is in', () => {
    expect(decideWorkspace(warehouseHead, 6).allowed).toBe(true);
  });

  it('answers the same with and without the permissions — the boundary reads roles only', () => {
    const noPermissions = actor({ permissionNames: [], home: { wildcard: false, entityIds: [6] } });
    for (const company of [null, 1, 3, 4, 6]) {
      expect(decideWorkspace(warehouseHead, company)).toEqual(decideWorkspace(noPermissions, company));
    }
  });
});
