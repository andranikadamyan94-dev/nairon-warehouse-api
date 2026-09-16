import { NotFoundException } from '@nestjs/common';

import { ResourceWorkspaceService } from './resource-workspace.service';

/**
 * A stand-in for Prisma that answers with rows shaped exactly as the selects in
 * the service ask for them. The point of these tests is the derivation, so the
 * database is not what is under test — but the shapes are, and a select that
 * stops matching its reader shows up here as a null workspace.
 */
const prismaWith = (rows: {
  category?: unknown;
  item?: unknown;
  asset?: unknown;
  maintenanceRecord?: unknown;
  reservation?: unknown;
  resourceReturn?: unknown;
  selects?: unknown[];
}) =>
  ({
    itemCategory: { findUnique: async () => rows.category ?? null },
    item: { findUnique: async () => rows.item ?? null },
    asset: { findUnique: async () => rows.asset ?? null },
    maintenanceRecord: { findUnique: async () => rows.maintenanceRecord ?? null },
    resourceReservation: {
      findUnique: async (args: { select: unknown }) => {
        rows.selects?.push(args.select);
        return rows.reservation ?? null;
      },
    },
    resourceReturn: {
      findUnique: async (args: { select: unknown }) => {
        rows.selects?.push(args.select);
        return rows.resourceReturn ?? null;
      },
    },
  }) as any;

describe('where a warehouse resource is filed', () => {
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
    await expect(svc.of('category', 404)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.of('maintenance', 404)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('WAREHOUSE V1 · the catalogue is one shared pool', () => {
  it('offers no catalogue refusal and no list narrowing by company any more', () => {
    // Where a category is filed is bookkeeping. Catalogue reads are open to
    // every authenticated caller the route admits; catalogue changes are the
    // route's manage_* permission. Nothing on this service may say otherwise.
    const svc = new ResourceWorkspaceService(prismaWith({})) as any;
    expect(svc.assertMayTouch).toBeUndefined();
    expect(svc.assertMayTouchWorkspace).toBeUndefined();
    expect(svc.scopeFor).toBeUndefined();
  });
});

describe('the two companies of a reservation', () => {
  it('takes the requester from requesterWorkspaceId, and the stock owner from the catalogue', async () => {
    const svc = new ResourceWorkspaceService(
      prismaWith({ reservation: { requesterWorkspaceId: 3, item: { category: { entityId: 1 } } } }),
    );
    await expect(svc.partiesOfReservation(8)).resolves.toEqual({ requester: 3, stockOwner: 1 });
  });

  it('reports a legacy requester as unknown — never as the old entityId label', async () => {
    const selects: unknown[] = [];
    // The row still carries entityId 4; the parties must not see it.
    const svc = new ResourceWorkspaceService(
      prismaWith({
        selects,
        reservation: { requesterWorkspaceId: null, entityId: 4, item: { category: { entityId: 1 } } },
        resourceReturn: {
          reservation: { requesterWorkspaceId: null, entityId: 4, item: { category: { entityId: 1 } } },
        },
      }),
    );
    await expect(svc.partiesOfReservation(8)).resolves.toEqual({ requester: null, stockOwner: 1 });
    await expect(svc.partiesOfReturn(2)).resolves.toEqual({ requester: null, stockOwner: 1 });
    // And the legacy column is not even asked for.
    expect(selects).toHaveLength(2);
    expect(selects.every((s) => !Object.prototype.hasOwnProperty.call(s, 'entityId'))).toBe(true);
    expect(
      selects.every(
        (s: any) => !s.reservation || !Object.prototype.hasOwnProperty.call(s.reservation.select, 'entityId'),
      ),
    ).toBe(true);
  });
});
