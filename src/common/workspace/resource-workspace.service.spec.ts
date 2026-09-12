import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { WarehouseActor } from '../../auth/actor';
import { ResourceWorkspaceService } from './resource-workspace.service';

/**
 * A stand-in for Prisma that answers with rows shaped exactly as the selects in
 * the service ask for them. The point of these tests is the derivation and the
 * refusals, so the database is not what is under test — but the shapes are, and
 * a select that stops matching its reader shows up here as a null workspace.
 */
const prismaWith = (rows: {
  category?: unknown;
  item?: unknown;
  asset?: unknown;
  maintenanceRecord?: unknown;
}) =>
  ({
    itemCategory: { findUnique: async () => rows.category ?? null },
    item: { findUnique: async () => rows.item ?? null },
    asset: { findUnique: async () => rows.asset ?? null },
    maintenanceRecord: { findUnique: async () => rows.maintenanceRecord ?? null },
  }) as any;

const actor = (over: Partial<WarehouseActor> = {}): WarehouseActor => ({
  userId: 11,
  isSuperAdmin: false,
  isGlobalSuperAdmin: false,
  permissionNames: [],
  home: { wildcard: true, entityIds: [] },
  declared: null,
  ...over,
});

const unbounded = actor();
const inOne = actor({ home: { wildcard: false, entityIds: [1] } });

describe('where a warehouse resource lives', () => {
  it('reads a category straight off the row — the one workspace the schema stores', async () => {
    const svc = new ResourceWorkspaceService(prismaWith({ category: { entityId: 4 } }));
    await expect(svc.ofCategory(9)).resolves.toEqual({ workspace: 4, origin: 'own' });
  });

  it('derives an item from its category', async () => {
    const svc = new ResourceWorkspaceService(prismaWith({ item: { category: { entityId: 1 } } }));
    await expect(svc.ofItem(3)).resolves.toEqual({ workspace: 1, origin: 'category' });
  });

  it('calls an uncategorised item unknown, not entity one and not everywhere', async () => {
    const svc = new ResourceWorkspaceService(prismaWith({ item: { category: null } }));
    await expect(svc.ofItem(3)).resolves.toEqual({ workspace: null, origin: 'none' });
  });

  it('derives an asset through its item', async () => {
    const svc = new ResourceWorkspaceService(
      prismaWith({ asset: { item: { category: { entityId: 4 } } } }),
    );
    await expect(svc.ofAsset(2)).resolves.toEqual({ workspace: 4, origin: 'item.category' });
  });

  it('derives a maintenance record through its asset', async () => {
    const svc = new ResourceWorkspaceService(
      prismaWith({ maintenanceRecord: { asset: { item: { category: { entityId: 1 } } } } }),
    );
    await expect(svc.ofMaintenance(5)).resolves.toEqual({
      workspace: 1,
      origin: 'asset.item.category',
    });
  });

  it('carries the unknown all the way down a chain rather than losing it', async () => {
    const svc = new ResourceWorkspaceService(
      prismaWith({ maintenanceRecord: { asset: { item: { category: null } } } }),
    );
    await expect(svc.ofMaintenance(5)).resolves.toMatchObject({ workspace: null });
  });

  it('says not found rather than unknown when the row is not there at all', async () => {
    const svc = new ResourceWorkspaceService(prismaWith({}));
    await expect(svc.ofItem(404)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.ofAsset(404)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('the assertion a mutation and its preflight share', () => {
  it('lets an unbounded actor through, known workspace or not', async () => {
    const svc = new ResourceWorkspaceService(prismaWith({ item: { category: { entityId: 4 } } }));
    await expect(svc.assertMayTouch(unbounded, 'item', 1)).resolves.toMatchObject({ workspace: 4 });

    const uncategorised = new ResourceWorkspaceService(prismaWith({ item: { category: null } }));
    await expect(uncategorised.assertMayTouch(unbounded, 'item', 1)).resolves.toMatchObject({
      workspace: null,
    });
  });

  it('refuses a bounded actor another company’s item', async () => {
    const svc = new ResourceWorkspaceService(prismaWith({ item: { category: { entityId: 4 } } }));
    await expect(svc.assertMayTouch(inOne, 'item', 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a bounded actor an item that cannot say where it is', async () => {
    const svc = new ResourceWorkspaceService(prismaWith({ item: { category: null } }));
    await expect(svc.assertMayTouch(inOne, 'item', 1)).rejects.toThrow(/no workspace/i);
  });

  it('tells the two refusals apart in what it says', async () => {
    const elsewhere = new ResourceWorkspaceService(prismaWith({ item: { category: { entityId: 4 } } }));
    await expect(elsewhere.assertMayTouch(inOne, 'item', 1)).rejects.toThrow(/another workspace/i);
  });

  it('answers the same question about a workspace already in hand, for creation', () => {
    const svc = new ResourceWorkspaceService(prismaWith({}));
    expect(() => svc.assertMayTouchWorkspace(inOne, 'item', 1)).not.toThrow();
    expect(() => svc.assertMayTouchWorkspace(inOne, 'item', 4)).toThrow(ForbiddenException);
    expect(() => svc.assertMayTouchWorkspace(inOne, 'item', null)).toThrow(ForbiddenException);
    expect(() => svc.assertMayTouchWorkspace(unbounded, 'item', null)).not.toThrow();
  });
});

describe('the filter a list is narrowed by', () => {
  const svc = () => new ResourceWorkspaceService(prismaWith({}));

  it('is nothing at all for an unbounded actor, so today no list changes', () => {
    expect(svc().scopeFor(unbounded, ['category'])).toBeUndefined();
  });

  it('nests along the relation path it is given', () => {
    expect(svc().scopeFor(inOne, [])).toEqual({ entityId: 1 });
    expect(svc().scopeFor(inOne, ['category'])).toEqual({ category: { entityId: 1 } });
    expect(svc().scopeFor(inOne, ['item', 'category'])).toEqual({
      item: { category: { entityId: 1 } },
    });
    expect(svc().scopeFor(inOne, ['asset', 'item', 'category'])).toEqual({
      asset: { item: { category: { entityId: 1 } } },
    });
  });

  it('uses an in-list when somebody holds more than one workspace', () => {
    const two = actor({ home: { wildcard: false, entityIds: [1, 4] } });
    expect(svc().scopeFor(two, ['category'])).toEqual({ category: { entityId: { in: [1, 4] } } });
  });

  it('does not narrow a wildcard holder who declared a company, because stock is shared', () => {
    const declaring = actor({ home: { wildcard: true, entityIds: [] }, declared: 4 });
    expect(svc().scopeFor(declaring, ['category'])).toBeUndefined();
  });

  it('requires the relation to exist, so a row with no category is not in anybody’s list', () => {
    // A nested relation filter in Prisma does not match a row whose relation is
    // NULL. That is the whole contract: unknown is never a match.
    const scope = svc().scopeFor(inOne, ['category']) as any;
    expect(scope.category).toBeDefined();
    expect(scope.category.entityId).toBe(1);
  });
});
