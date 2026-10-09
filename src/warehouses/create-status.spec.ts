import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { WarehousesService } from './warehouses.service';

/**
 * #2338 (QA, 2026-10-09): a warehouse created with status «Ոչ ակտիվ» was
 * stored ACTIVE — the service forced the status and the DTO comment said it
 * was ignored. The chosen status is now honoured; ACTIVE when absent. The
 * assignment notice on create tells the people named of their assignment and
 * never says «closed» — there was no earlier status to change from.
 */

function world() {
  const prisma: any = {
    warehouse: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({
        id: 51,
        ...data,
        projects: [],
        employees: (data.employees?.create ?? []).map((e: any) => ({ userId: e.userId })),
      })),
    },
    warehouseProject: { findMany: jest.fn(async () => []) },
  };
  const notifications: any = { sendToUsers: jest.fn(async () => undefined) };
  const service = new WarehousesService(prisma, {} as any, notifications);
  // CRM is not consulted: no projects are linked in these cases.
  (service as any).projectNames = jest.fn(async () => new Map());
  (service as any).assertProjectsLinkable = jest.fn(async () => undefined);
  return { service, prisma, notifications };
}

const dto = (status?: 'ACTIVE' | 'INACTIVE') => ({ name: 'Փորձնական', code: `TST-${status ?? 'none'}`, status });

describe('warehouses · create honours the chosen status (#2338)', () => {
  it('«Ոչ ակտիվ» is stored INACTIVE', async () => {
    const { service, prisma } = world();
    const created = await service.create(dto('INACTIVE'), 7);
    expect(prisma.warehouse.create.mock.calls[0][0].data.status).toBe('INACTIVE');
    expect(created.status).toBe('INACTIVE');
  });

  it('«Ակտիվ» is stored ACTIVE', async () => {
    const { service, prisma } = world();
    await service.create(dto('ACTIVE'), 7);
    expect(prisma.warehouse.create.mock.calls[0][0].data.status).toBe('ACTIVE');
  });

  it('no status → ACTIVE (old clients, the API without the field)', async () => {
    const { service, prisma } = world();
    await service.create(dto(undefined), 7);
    expect(prisma.warehouse.create.mock.calls[0][0].data.status).toBe('ACTIVE');
  });

  it('created INACTIVE with staff: the staff hear of the assignment, not of a closure', async () => {
    const { service, notifications } = world();
    await service.create({ ...dto('INACTIVE'), responsibleId: 11, employeeIds: [12] }, 7);
    await new Promise((r) => setImmediate(r));
    const bodies = notifications.sendToUsers.mock.calls.map((c: any[]) => c[1].body as string);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(b).not.toContain('փակվել');
    expect(bodies.some((b: string) => b.includes('պատասխանատու'))).toBe(true);
    expect(bodies.some((b: string) => b.includes('աշխատակիցների մեջ'))).toBe(true);
  });

  it('DTO: the status field accepts ACTIVE / INACTIVE and refuses anything else', async () => {
    const okInactive = plainToInstance(CreateWarehouseDto, { name: 'Ա', code: 'A', status: 'INACTIVE' });
    expect(await validate(okInactive)).toHaveLength(0);
    const okAbsent = plainToInstance(CreateWarehouseDto, { name: 'Ա', code: 'A' });
    expect(await validate(okAbsent)).toHaveLength(0);
    const bad = plainToInstance(CreateWarehouseDto, { name: 'Ա', code: 'A', status: 'CLOSED' });
    expect((await validate(bad)).map((e) => e.property)).toEqual(['status']);
  });
});
