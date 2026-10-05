import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PermissionGuard, PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { ObjectsController } from './objects.controller';
import { OBJECT_PAGE_RIGHT } from './object-page-rights';

/**
 * The CRM object page's warehouse-backed tabs (owner's decision, 2026-10-05):
 *
 *   GET /objects/:id/materials, /movements   view_object_materials
 *   GET /objects/:id/summary                 view_object_materials OR view_object_finance
 *   GET /objects/:id/estimate                view_object_estimate
 *
 * Each right opens only its own route(s); each route is opened only by its
 * right (super admins pass). The general warehouse rights — view_resources,
 * manage_inventory, manage_reservations, manage_warehouses, the
 * `manage_warehouse` super-permission — open the object LIST as before and
 * none of the object's page. The estimate writes keep manage_warehouses.
 *
 * Reads the metadata off the real controller and drives the real guard, so
 * it fails if somebody puts a general right back on an object route.
 */

const permissionsOf = (method: keyof ObjectsController): string[] =>
  Reflect.getMetadata(PERMISSIONS_KEY, ObjectsController.prototype[method]) ?? [];

function guardWith(permissionNames: string[], isSuperAdmin = false) {
  const reflector = { getAllAndOverride: (_k: string, [handler]: unknown[]) => handler } as unknown as Reflector;
  const guard = new PermissionGuard(reflector, {
    resolve: async () => ({ isSuperAdmin, permissionNames }),
  } as never);
  return (method: keyof ObjectsController) =>
    guard.canActivate({
      getHandler: () => permissionsOf(method),
      getClass: () => permissionsOf(method),
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 1 } }) }),
    } as never);
}

const outcome = async (attempt: Promise<unknown>) => {
  try {
    await attempt;
    return 200;
  } catch (e) {
    return e instanceof ForbiddenException ? 403 : 500;
  }
};

const OBJECT_READS: (keyof ObjectsController)[] = ['materials', 'movements', 'summary', 'listEstimate'];
const GENERAL = ['view_resources', 'manage_inventory', 'manage_reservations', 'manage_warehouses', 'manage_stock_transfers'];

describe('object page tabs · each read is opened by its own right alone', () => {
  it('declares the rights on the real routes', () => {
    expect(permissionsOf('materials')).toEqual([OBJECT_PAGE_RIGHT.materials]);
    expect(permissionsOf('movements')).toEqual([OBJECT_PAGE_RIGHT.materials]);
    expect(permissionsOf('summary')).toEqual([OBJECT_PAGE_RIGHT.materials, OBJECT_PAGE_RIGHT.finance]);
    expect(permissionsOf('listEstimate')).toEqual([OBJECT_PAGE_RIGHT.estimate]);
    // The list and the estimate writes are as they were.
    expect(permissionsOf('list')).toEqual(expect.arrayContaining(GENERAL));
    expect(permissionsOf('list')).not.toEqual(expect.arrayContaining(Object.values(OBJECT_PAGE_RIGHT)));
    expect(permissionsOf('upsertEstimate')).toEqual(['manage_warehouses']);
    expect(permissionsOf('removeEstimate')).toEqual(['manage_warehouses']);
  });

  it('403 with no right at all', async () => {
    const open = guardWith([]);
    for (const m of OBJECT_READS) expect(await outcome(open(m))).toBe(403);
  });

  it('200 with the route\'s own right', async () => {
    expect(await outcome(guardWith([OBJECT_PAGE_RIGHT.materials])('materials'))).toBe(200);
    expect(await outcome(guardWith([OBJECT_PAGE_RIGHT.materials])('movements'))).toBe(200);
    expect(await outcome(guardWith([OBJECT_PAGE_RIGHT.estimate])('listEstimate'))).toBe(200);
  });

  it('the summary feeds the materials tab and the finance tab: either right opens it', async () => {
    expect(await outcome(guardWith([OBJECT_PAGE_RIGHT.materials])('summary'))).toBe(200);
    expect(await outcome(guardWith([OBJECT_PAGE_RIGHT.finance])('summary'))).toBe(200);
  });

  it('200 for a super admin with no grant of their own', async () => {
    const open = guardWith([], true);
    for (const m of OBJECT_READS) expect(await outcome(open(m))).toBe(200);
  });

  it('a right opens only its own route(s)', async () => {
    const materials = guardWith([OBJECT_PAGE_RIGHT.materials]);
    expect(await outcome(materials('listEstimate'))).toBe(403);
    const estimate = guardWith([OBJECT_PAGE_RIGHT.estimate]);
    expect(await outcome(estimate('materials'))).toBe(403);
    expect(await outcome(estimate('movements'))).toBe(403);
    expect(await outcome(estimate('summary'))).toBe(403);
    const finance = guardWith([OBJECT_PAGE_RIGHT.finance]);
    expect(await outcome(finance('materials'))).toBe(403);
    expect(await outcome(finance('listEstimate'))).toBe(403);
    // The other tabs' rights (requests, assets) live in other modules and open nothing here.
    const others = guardWith([OBJECT_PAGE_RIGHT.requests, OBJECT_PAGE_RIGHT.assets]);
    for (const m of OBJECT_READS) expect(await outcome(others(m))).toBe(403);
  });

  it('a warehouse keeper (the general rights, no object right) is refused on the object routes and still sees the list', async () => {
    const keeper = guardWith(GENERAL);
    for (const m of OBJECT_READS) expect(await outcome(keeper(m))).toBe(403);
    expect(await outcome(keeper('list'))).toBe(200);
    // And one general right at a time, as the real grants come.
    for (const right of GENERAL) {
      const one = guardWith([right]);
      for (const m of OBJECT_READS) expect(await outcome(one(m))).toBe(403);
    }
  });

  it('the warehouse super-permission opens the list and the writes, not the object page', async () => {
    const boss = guardWith(['manage_warehouse']);
    for (const m of OBJECT_READS) expect(await outcome(boss(m))).toBe(403);
    expect(await outcome(boss('list'))).toBe(200);
    expect(await outcome(boss('upsertEstimate'))).toBe(200);
  });

  it('reading the estimate does not let one edit it', async () => {
    const reader = guardWith([OBJECT_PAGE_RIGHT.estimate]);
    expect(await outcome(reader('upsertEstimate'))).toBe(403);
    expect(await outcome(reader('removeEstimate'))).toBe(403);
    const editor = guardWith(['manage_warehouses']);
    expect(await outcome(editor('upsertEstimate'))).toBe(200);
    expect(await outcome(editor('listEstimate'))).toBe(403);
  });

  it('an object right opens nothing of the general warehouse (the list)', async () => {
    const page = guardWith(Object.values(OBJECT_PAGE_RIGHT));
    expect(await outcome(page('list'))).toBe(403);
  });
});
