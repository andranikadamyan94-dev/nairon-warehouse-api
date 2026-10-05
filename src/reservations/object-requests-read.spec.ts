import { ForbiddenException } from '@nestjs/common';

import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

/**
 * GET /reservations/object/:objectId — an object's own goods requests, read
 * by the CRM object page's «Պահեստային հայտեր» tab and nothing else (the
 * warehouse client only supplies an object, POST .../supply).
 *
 * Owner's decision 2026-10-05 (objects/object-page-rights.ts): opened by
 * view_object_requests, by the object's responsible person as CRM's internal
 * card names them, or by a super admin. The general warehouse rights — even
 * `manage_warehouse` — do not open it. Writes are untouched: asking is the
 * responsible person's, supplying is manage_reservations.
 *
 * CRM's card names 32 the responsible person of object 600; object 999 is
 * unknown to CRM.
 */
const RESPONSIBLE = 32;
const TAB = 61; // view_object_requests
const KEEPER = 62; // the general warehouse rights
const NOBODY = 51;
const ADMIN = 99;

const ROWS = [
  { id: 1, objectId: 600, taskId: null, item: { id: 1 }, quantity: 3, status: 'PENDING', allocations: [], statusHistory: [], acceptedQuantity: 0, createdAt: new Date() },
  { id: 2, objectId: 600, taskId: null, item: { id: 2 }, quantity: 1, status: 'ISSUED', allocations: [{ quantity: 1 }], statusHistory: [], acceptedQuantity: 0, createdAt: new Date() },
];

const build = () => {
  const prisma: any = {
    resourceReservation: { findMany: jest.fn(async ({ where }: any) => ROWS.filter((r) => r.objectId === where.objectId)) },
    purchaseRequisitionLine: { findMany: jest.fn(async () => []) },
  };
  const svc = new ReservationsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const controller = new ReservationsController(svc, {} as any);
  const net = jest.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
    const m = String(url).match(/^http:\/\/crm\.test\/api\/construction-objects\/internal\/(\d+)\/card$/);
    if (!m || init?.headers?.['x-internal-secret'] !== 's3cret') throw new Error(`unexpected network call: ${String(url)}`);
    const id = Number(m[1]);
    if (id !== 600) return { ok: false, status: 404 } as any;
    return { ok: true, status: 200, json: async () => ({ id, code: 'O-600', name: 'object', projectId: null, projectName: null, entityId: null, responsibleId: RESPONSIBLE }) } as any;
  });
  return { controller, prisma, net };
};

const PERMS: Record<number, string[]> = {
  [RESPONSIBLE]: [],
  [TAB]: ['view_object_requests'],
  [KEEPER]: ['view_resources', 'manage_inventory', 'manage_reservations', 'manage_warehouses', 'manage_warehouse', 'view_warehouse'],
  [NOBODY]: [],
  [ADMIN]: [],
};

/** The actor as AuthGuard resolves it. */
const actor = (userId: number): any => ({
  userId,
  isSuperAdmin: userId === ADMIN,
  isGlobalSuperAdmin: userId === ADMIN,
  readOnly: false,
  permissionNames: PERMS[userId] ?? [],
  home: { wildcard: true, entityIds: [] },
  declared: null,
});
const ids = (rows: any[]) => rows.map((r) => r.id).sort();

describe('GET /reservations/object/:objectId — the object page\'s requests tab', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INTERNAL_SECRET = 's3cret';
    process.env.CRM_API_URL = 'http://crm.test';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...env };
  });

  it('200 for view_object_requests, without asking CRM', async () => {
    const { controller, net } = build();
    expect(ids(await controller.forObject('600', actor(TAB)))).toEqual([1, 2]);
    expect(net).not.toHaveBeenCalled();
  });

  it('200 for a super admin with no grant of their own', async () => {
    const { controller, net } = build();
    expect(ids(await controller.forObject('600', actor(ADMIN)))).toEqual([1, 2]);
    expect(net).not.toHaveBeenCalled();
  });

  it("200 for the object's responsible person, as CRM's internal card names them", async () => {
    const { controller, net } = build();
    expect(ids(await controller.forObject('600', actor(RESPONSIBLE)))).toEqual([1, 2]);
    expect(net).toHaveBeenCalledWith('http://crm.test/api/construction-objects/internal/600/card', expect.anything());
  });

  it('403 for the responsible person of another object, and for an object CRM does not know', async () => {
    const { controller, prisma } = build();
    await expect(controller.forObject('700', actor(RESPONSIBLE))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.forObject('999', actor(RESPONSIBLE))).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.resourceReservation.findMany).not.toHaveBeenCalled();
  });

  it('403 for a warehouse keeper — the general rights, even manage_warehouse, do not open it', async () => {
    const { controller, prisma } = build();
    await expect(controller.forObject('600', actor(KEEPER))).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.resourceReservation.findMany).not.toHaveBeenCalled();
  });

  it('403 with no right at all', async () => {
    const { controller } = build();
    await expect(controller.forObject('600', actor(NOBODY))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('CRM unreachable is "not the responsible person": 403, never a guess', async () => {
    const { controller, net } = build();
    net.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(controller.forObject('600', actor(RESPONSIBLE))).rejects.toBeInstanceOf(ForbiddenException);
    // The right needs no CRM at all.
    expect(ids(await controller.forObject('600', actor(TAB)))).toEqual([1, 2]);
  });
});
