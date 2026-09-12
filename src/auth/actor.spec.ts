import {
  WarehouseActor,
  boundedTo,
  decideCreationWorkspace,
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

/** What every caller in this installation looks like today. */
const unbounded = actor();
/** Somebody whose only role lives in company 1. */
const inOne = actor({ home: { wildcard: false, entityIds: [1] } });
/** The same person, having asked to act as company 1. */
const declaringOne = actor({ home: { wildcard: false, entityIds: [1] }, declared: 1 });

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

describe('what an actor is bounded to', () => {
  it('is nothing at all for a wildcard holder who declared nothing', () => {
    expect(boundedTo(unbounded)).toBeNull();
  });

  it('stays nothing for a wildcard holder even when they declare a company', () => {
    // Deliberate, and the one place the warehouse differs from CRM and HR:
    // stock is a shared pool, so which company somebody is acting as says
    // nothing about which stock exists. The declaration narrows their
    // permissions instead — see WarehouseActorService.
    expect(boundedTo(actor({ declared: 4 }))).toBeNull();
  });

  it('is their own workspaces when their roles are scoped', () => {
    expect(boundedTo(actor({ home: { wildcard: false, entityIds: [1, 4] } }))).toEqual([1, 4]);
  });
});

describe('may this actor touch a resource in this workspace', () => {
  it('refuses nothing when the actor is not bounded — today, every caller', () => {
    expect(decideWorkspace(unbounded, 4).allowed).toBe(true);
    expect(decideWorkspace(unbounded, null).allowed).toBe(true);
    expect(decideWorkspace(unbounded, 4).because).toBe('unbounded');
  });

  it('allows a bounded actor inside their own', () => {
    expect(decideWorkspace(inOne, 1)).toMatchObject({ allowed: true, because: 'in-scope' });
  });

  it('refuses a bounded actor outside it', () => {
    expect(decideWorkspace(inOne, 4)).toMatchObject({
      allowed: false,
      because: 'outside-scope',
      workspace: 4,
    });
  });

  it('refuses an unknown workspace rather than guessing at one', () => {
    expect(decideWorkspace(inOne, null)).toMatchObject({
      allowed: false,
      because: 'unknown-workspace',
    });
  });

  it('says which of the two it was, because they are not the same problem', () => {
    expect(decideWorkspace(inOne, 4).because).not.toBe(decideWorkspace(inOne, null).because);
  });

  it('lets somebody who holds two companies reach both, declaration or not', () => {
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

describe('where a new row gets filed', () => {
  it('lets an unbounded caller keep choosing, which is what the client does today', () => {
    expect(decideCreationWorkspace(unbounded, 4)).toMatchObject({ ok: true, workspace: 4 });
    expect(decideCreationWorkspace(unbounded, undefined)).toMatchObject({ ok: true, workspace: null });
  });

  it('files a bounded caller where they are when they name nothing', () => {
    expect(decideCreationWorkspace(declaringOne, undefined)).toMatchObject({ ok: true, workspace: 1 });
  });

  it('refuses a bounded caller who names a company they hold no role in', () => {
    expect(decideCreationWorkspace(declaringOne, 4)).toMatchObject({ ok: false, requested: 4 });
  });

  it('accepts a bounded caller naming their own', () => {
    expect(decideCreationWorkspace(declaringOne, 1)).toMatchObject({ ok: true, workspace: 1 });
  });

  it('asks a caller with two workspaces and no declaration to say which', () => {
    const both = actor({ home: { wildcard: false, entityIds: [1, 4] } });
    expect(decideCreationWorkspace(both, undefined)).toMatchObject({ ok: false, requested: null });
    expect(decideCreationWorkspace(both, 4)).toMatchObject({ ok: true, workspace: 4 });
  });

  it('never returns a workspace the caller could not have had', () => {
    const refused = decideCreationWorkspace(declaringOne, 4);
    expect(refused.ok).toBe(false);
    expect(refused.workspace).toBeNull();
  });
});
