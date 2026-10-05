import { BadRequestException } from '@nestjs/common';

import { WarehouseActor } from '../auth/actor';
import { ReservationsService } from './reservations.service';

/**
 * THE PREFLIGHT NAMES THE WAREHOUSE, AND REFUSES WHAT CREATE REFUSES.
 *
 * previewCreate() runs the same task → project → warehouse resolution that
 * create() stamps the rows with, so a confirmation card can say which shelf the
 * request draws on. A project linked to no warehouse used to pass the preflight
 * and then fail on confirm; now both refuse with the same 400.
 *
 * CRM is a stubbed fetch; the warehouse links live in a stand-in prisma.
 */

const UNLINKED = 'Նախագիծը կապված չէ որևէ պահեստի հետ — դիմեք պահեստի պատասխանատուին';

/** Warehouse staff asking: manage_reservations is requester standing for any task (two-party.ts, 2026-10-05), so CRM is not asked who is on it. */
const actor: WarehouseActor = {
  userId: 39,
  isSuperAdmin: false,
  readOnly: false,
  isGlobalSuperAdmin: false,
  permissionNames: ['manage_reservations'],
  home: { wildcard: false, entityIds: [3] },
  declared: null,
};

type Link = { projectId: number; warehouseId: number; warehouse: { id: number; name: string; type: 'MAIN' | 'PROJECT'; status: string } };

function world(links: Link[]) {
  const warehouses = links.map((l) => l.warehouse);
  const prisma: any = {
    resourceReservation: { findFirst: async () => null },
    warehouseProject: {
      findUnique: async ({ where }: any) => links.find((l) => l.projectId === where.projectId) ?? null,
    },
    warehouse: {
      findUnique: async ({ where }: any) => {
        const w = warehouses.find((x) => x.id === where.id);
        return w ? { id: w.id, name: w.name, type: w.type } : null;
      },
    },
    item: {
      findUnique: async ({ where }: any) => ({
        id: where.id,
        name: 'Ցեմենտ',
        unit: 'KG',
        type: 'CONSUMABLE',
        category: { entityId: 1, name: 'Շինանյութ' },
      }),
      findMany: async () => [{ id: 7, unit: 'KG', type: 'CONSUMABLE' }],
    },
  };
  const availability = {
    checkAvailability: jest.fn(async () => ({ available: true, unavailableResources: [] })),
  };
  const svc = new ReservationsService(
    prisma,
    availability as any,
    { check: async () => {} } as any,
    { send: async () => {} } as any,
    {} as any,
    {} as any,
    { forRequest: async () => 3 } as any,
  );
  return { svc, availability };
}

const request = () =>
  ({
    projectId: 70,
    taskId: 12,
    startDate: '2026-10-01T09:00:00.000Z',
    endDate: '2026-10-10T18:00:00.000Z',
    resources: [{ itemId: 7, quantity: 5 }],
  }) as any;

let originalFetch: typeof fetch;
let originalSecret: string | undefined;

beforeEach(() => {
  originalFetch = global.fetch;
  originalSecret = process.env.INTERNAL_SECRET;
  process.env.INTERNAL_SECRET = 'test-secret';
  // Task 12 belongs to project 70; project 70 has no parent in CRM.
  global.fetch = jest.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/project-tasks/12/internal')) {
      return { ok: true, json: async () => ({ id: 12, projectId: 70, objectId: null }) } as any;
    }
    if (u.includes('/api/projects/70/workspace/internal')) {
      return { ok: true, json: async () => ({ parentId: null }) } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }) as any;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.INTERNAL_SECRET;
  else process.env.INTERNAL_SECRET = originalSecret;
});

describe('previewCreate names the warehouse create() would use', () => {
  it('a project linked to a project warehouse: that warehouse, by name, and availability measured on its shelf', async () => {
    const { svc, availability } = world([
      { projectId: 70, warehouseId: 3, warehouse: { id: 3, name: 'Ծիրան պահեստ', type: 'PROJECT', status: 'ACTIVE' } },
    ]);

    const preview = await svc.previewCreate(request(), actor);

    expect(preview.warehouse).toEqual({ id: 3, name: 'Ծիրան պահեստ', type: 'PROJECT' });
    expect(availability.checkAvailability).toHaveBeenCalledWith(expect.objectContaining({ warehouseId: 3 }));
    // Everything else keeps its shape.
    expect(preview.lines).toHaveLength(1);
    expect(preview.rowsToCreate).toBe(1);
    expect(preview.availabilityIsInformational).toBe(true);
  });

  it('a project linked to the main warehouse: id null, «Հիմնական պահեստ», MAIN', async () => {
    const { svc, availability } = world([
      { projectId: 70, warehouseId: 1, warehouse: { id: 1, name: 'Գլխավոր պահեստ', type: 'MAIN', status: 'ACTIVE' } },
    ]);

    const preview = await svc.previewCreate(request(), actor);

    expect(preview.warehouse).toEqual({ id: null, name: 'Հիմնական պահեստ', type: 'MAIN' });
    expect(availability.checkAvailability).toHaveBeenCalledWith(expect.objectContaining({ warehouseId: null }));
  });

  it('a request with no task stays on the main warehouse, without asking CRM', async () => {
    const { svc } = world([]);

    const preview = await svc.previewCreate({ ...request(), taskId: undefined }, actor);

    expect(preview.warehouse).toEqual({ id: null, name: 'Հիմնական պահեստ', type: 'MAIN' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a project linked to no warehouse: the preflight refuses with the same 400 create() gives', async () => {
    const { svc, availability } = world([]);

    const preview = svc.previewCreate(request(), actor);
    await expect(preview).rejects.toBeInstanceOf(BadRequestException);
    await expect(preview).rejects.toThrow(UNLINKED);
    expect(availability.checkAvailability).not.toHaveBeenCalled();

    const create = svc.create(request(), 39, actor);
    await expect(create).rejects.toBeInstanceOf(BadRequestException);
    await expect(create).rejects.toThrow(UNLINKED);
  });
});
