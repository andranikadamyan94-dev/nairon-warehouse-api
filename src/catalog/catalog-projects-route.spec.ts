import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PermissionGuard, PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { CatalogController } from './catalog.controller';
import { CatalogService, EMPLOYEE_PERMISSIONS } from './catalog.service';

/**
 * The cart's project picker (Arshak, staging, 2026-10-09): CartPage asked
 * GET /warehouses/projects, which is guarded by manage_warehouses, so an
 * ordinary requester got 403 and an empty «Նախագիծ / ծախսերի կենտրոն» select.
 *
 * GET /catalog/projects is open to every requester — the same guard as
 * /catalog/objects (page_warehouse / view_warehouse) — and answers
 * `{ id, name }[]` from CRM's /api/projects/internal, nothing else of CRM's
 * row. CRM down → an empty list, never an error.
 */

const permissionsOf = (method: keyof CatalogController): string[] =>
  Reflect.getMetadata(PERMISSIONS_KEY, CatalogController.prototype[method]) ?? [];

function guardWith(permissionNames: string[], isSuperAdmin = false) {
  const reflector = { getAllAndOverride: (_k: string, [handler]: unknown[]) => handler } as unknown as Reflector;
  const guard = new PermissionGuard(reflector, {
    resolve: async () => ({ isSuperAdmin, permissionNames }),
  } as never);
  return (method: keyof CatalogController) =>
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

describe('GET /catalog/projects · guard', () => {
  it('is guarded exactly like /catalog/objects (EMPLOYEE_PERMISSIONS)', () => {
    expect(permissionsOf('projects')).toEqual(EMPLOYEE_PERMISSIONS);
    expect(permissionsOf('projects')).toEqual(permissionsOf('objects'));
  });

  it('page_warehouse alone opens it (the requester without manage_warehouses)', async () => {
    expect(await outcome(guardWith(['page_warehouse'])('projects'))).toBe(200);
  });

  it('view_warehouse opens it; manage_warehouses alone does not', async () => {
    expect(await outcome(guardWith(['view_warehouse'])('projects'))).toBe(200);
    expect(await outcome(guardWith(['manage_warehouses'])('projects'))).toBe(403);
  });

  it('no warehouse right → 403', async () => {
    expect(await outcome(guardWith([])('projects'))).toBe(403);
  });
});

describe('GET /catalog/projects · shape', () => {
  const service = () => new CatalogService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const realFetch = global.fetch;
  beforeEach(() => { process.env.INTERNAL_SECRET = 'test-secret'; });
  afterEach(() => { global.fetch = realFetch; });

  it('answers { id, name }[] by name — CRM\'s other columns are not passed on', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [
        { id: 7, name: 'Բ նախագիծ', entityId: 1, parentId: null, status: 'ACTIVE' },
        { id: 3, name: 'Ա նախագիծ', entityId: 2, parentId: 7 },
      ],
    })) as any;
    const rows = await service().projectsForRequester();
    expect(rows).toEqual([{ id: 3, name: 'Ա նախագիծ' }, { id: 7, name: 'Բ նախագիծ' }]);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toMatch(/\/api\/projects\/internal$/);
    expect(init.headers['x-internal-secret']).toBe('test-secret');
  });

  it('CRM not ok → empty list', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) })) as any;
    expect(await service().projectsForRequester()).toEqual([]);
  });

  it('CRM unreachable → empty list, no throw', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    expect(await service().projectsForRequester()).toEqual([]);
  });

  it('the controller hands the service answer back unchanged', async () => {
    const svc = { projectsForRequester: jest.fn(async () => [{ id: 1, name: 'Ա' }]) } as unknown as CatalogService;
    const ctrl = new CatalogController(svc);
    expect(await ctrl.projects()).toEqual([{ id: 1, name: 'Ա' }]);
  });
});
