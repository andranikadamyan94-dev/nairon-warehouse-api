import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import {
  WarehouseActor,
  WorkspaceVerdict,
  Workspace,
  boundedTo,
  decideWorkspace,
} from '../../auth/actor';

/**
 * Which warehouse resources can say where they belong, and how.
 *
 * This is the whole answer to "in this workspace?", and most of the value is in
 * what it refuses to answer. Only one table in the warehouse stores a workspace
 * the server owns: ItemCategory. Everything reachable from a category through a
 * relation the database enforces can be derived from it. Everything else cannot,
 * and is reported as unknown rather than guessed from a name, a caller's header,
 * or a label somebody typed.
 *
 * The deliberate exclusion is ResourceReservation.entityId. It looks like a
 * workspace and is not one: it is written straight from the request body, it is
 * NULL on 18 of the 80 rows here, and on the rows that do have it it usually
 * disagrees with the item's own catalogue — companies 3 and 7 reserving from
 * catalogues 1 and 4, which is not a bug but the point of a shared store. It
 * records who ASKED. Reading it as "who may" would both trust the caller and
 * quietly break a working cross-company flow.
 */
export type WorkspaceOrigin =
  /** The row carries the workspace itself. */
  | 'own'
  /** Derived along enforced relations; the path is spelled out. */
  | 'category'
  | 'item.category'
  | 'asset.item.category'
  /** Nothing in the schema can say. The resource is reported, not guessed. */
  | 'none';

export type ResourceWorkspace = {
  workspace: Workspace;
  origin: WorkspaceOrigin;
};

/** The resource kinds this service can be asked about. */
export type WarehouseResource = 'category' | 'item' | 'asset' | 'maintenance';

const UNKNOWN = (origin: WorkspaceOrigin): ResourceWorkspace => ({ workspace: null, origin });

@Injectable()
export class ResourceWorkspaceService {
  constructor(private readonly prisma: PrismaService) {}

  /** A category says so itself. The only authoritative workspace in the schema. */
  async ofCategory(categoryId: number): Promise<ResourceWorkspace> {
    const row = await this.prisma.itemCategory.findUnique({
      where: { id: categoryId },
      select: { entityId: true },
    });
    if (!row) throw new NotFoundException('Category not found');
    return { workspace: row.entityId, origin: 'own' };
  }

  /**
   * An item is wherever its category is. `categoryId` is optional in the
   * schema, so an uncategorised item genuinely has no workspace — not entity 1,
   * not "everywhere". Unknown.
   */
  async ofItem(itemId: number): Promise<ResourceWorkspace> {
    const row = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { category: { select: { entityId: true } } },
    });
    if (!row) throw new NotFoundException('Item not found');
    return row.category
      ? { workspace: row.category.entityId, origin: 'category' }
      : UNKNOWN('none');
  }

  /** An asset is a physical instance of an item, and required to have one. */
  async ofAsset(assetId: number): Promise<ResourceWorkspace> {
    const row = await this.prisma.asset.findUnique({
      where: { id: assetId },
      select: { item: { select: { category: { select: { entityId: true } } } } },
    });
    if (!row) throw new NotFoundException('Asset not found');
    return row.item.category
      ? { workspace: row.item.category.entityId, origin: 'item.category' }
      : UNKNOWN('none');
  }

  /** A maintenance record is work on one asset, and required to have one. */
  async ofMaintenance(recordId: number): Promise<ResourceWorkspace> {
    const row = await this.prisma.maintenanceRecord.findUnique({
      where: { id: recordId },
      select: { asset: { select: { item: { select: { category: { select: { entityId: true } } } } } } },
    });
    if (!row) throw new NotFoundException('Maintenance record not found');
    return row.asset.item.category
      ? { workspace: row.asset.item.category.entityId, origin: 'asset.item.category' }
      : UNKNOWN('none');
  }

  async of(kind: WarehouseResource, id: number): Promise<ResourceWorkspace> {
    switch (kind) {
      case 'category':
        return this.ofCategory(id);
      case 'item':
        return this.ofItem(id);
      case 'asset':
        return this.ofAsset(id);
      case 'maintenance':
        return this.ofMaintenance(id);
    }
  }

  /**
   * The assertion every mutation and every preflight calls. One implementation,
   * so a PREPARE that says yes and a CONFIRM that says no is not a thing that
   * can happen by drift.
   *
   * Throws on refusal and returns the resource's workspace on success, so a
   * caller that needs to record where something happened does not look it up
   * twice.
   */
  async assertMayTouch(
    actor: WarehouseActor,
    kind: WarehouseResource,
    id: number,
  ): Promise<ResourceWorkspace> {
    const found = await this.of(kind, id);
    const verdict = decideWorkspace(actor, found.workspace);
    if (!verdict.allowed) throw refusal(kind, verdict);
    return found;
  }

  /**
   * The same question about a workspace already in hand — for creation, where
   * there is no row yet, and for the parent a new row is being filed under.
   */
  assertMayTouchWorkspace(actor: WarehouseActor, kind: WarehouseResource, workspace: Workspace): void {
    const verdict = decideWorkspace(actor, workspace);
    if (!verdict.allowed) throw refusal(kind, verdict);
  }

  /**
   * A `where` fragment that confines a list to what the actor may see, or
   * `undefined` when they are not bounded and nothing should be narrowed.
   *
   * `pathToCategory` is the relation chain from the model being listed to its
   * ItemCategory: `[]` for categories themselves, `['category']` for items,
   * `['item','category']` for assets, and so on. Written as data rather than as
   * a string so a typo is a compile error, not a silently unfiltered list.
   */
  scopeFor(actor: WarehouseActor, pathToCategory: string[]): Record<string, unknown> | undefined {
    const bounds = boundedTo(actor);
    if (bounds === null) return undefined;
    const leaf = { entityId: bounds.length === 1 ? bounds[0] : { in: bounds } };
    // Built inside out: ['item','category'] becomes { item: { category: leaf } }.
    // An `is` would let NULL relations through; a plain nested filter requires
    // the relation to exist, which is what "unknown is not a match" means here.
    return pathToCategory.reduceRight<Record<string, unknown>>(
      (inner, segment) => ({ [segment]: inner }),
      leaf,
    );
  }
}

/**
 * The refusal says which of the two it was. They are not the same thing and
 * whoever reads the log should not have to guess: one means the resource is
 * somewhere else, the other means nothing in the schema can say where it is.
 */
function refusal(kind: WarehouseResource, verdict: WorkspaceVerdict) {
  return verdict.because === 'outside-scope'
    ? new ForbiddenException(`This ${kind} belongs to another workspace`)
    : new ForbiddenException(
        `This ${kind} has no workspace, so it cannot be acted on from inside one`,
      );
}
