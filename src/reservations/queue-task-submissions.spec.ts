import { BadRequestException } from '@nestjs/common';

import { ReservationsService } from './reservations.service';
import { TASK_REQUEST_PURPOSE } from '../catalog/catalog.rules';
import { warehouseLinks } from '../common/notifications/notifications.service';

/**
 * Owner 2026-10-08: every reservation belongs to a request in the one queue
 * («Ապրանքների հարցումներ» → «Հաստատում»). The deprecated task routes the AI
 * tools still use — POST /reservations and PATCH /reservations/task/:id —
 * file / attach a CatalogSubmission («Առաջադրանքի հայտ»), GET /reservations/:id
 * names the submission so a ?reservation= link can open the request, the
 * notice links point at the queue, and the post-issue rules the queue now
 * drives (reclaim, release) are unchanged.
 */

function world(opts: { openSubmission?: { id: number; number: string } | null } = {}) {
  const subs: any[] = [];
  const rows: any[] = [];
  const history: any[] = [];
  const db: any = {
    item: {
      findMany: jest.fn(async () => [{ id: 7, unit: 'KG', type: 'CONSUMABLE' }, { id: 8, unit: 'PIECE', type: 'CONSUMABLE' }]),
      findUnique: jest.fn(async ({ where }: any) => ({ name: `Item ${where.id}`, unit: 'KG', category: { entityId: 1 } })),
    },
    catalogSubmission: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 900 + subs.length, number: data.number, ...data };
        subs.push(row);
        return { id: row.id, number: row.number };
      }),
      findFirst: jest.fn(async () => opts.openSubmission ?? null),
    },
    resourceReservation: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 700 + rows.length, ...data };
        rows.push(row);
        return row;
      }),
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    reservationStatusHistory: { create: jest.fn(async ({ data }: any) => history.push(data)) },
    reservationAllocation: { findMany: jest.fn(async () => []), aggregate: jest.fn(async () => ({ _sum: { quantity: 0 } })) },
    $queryRaw: jest.fn(async () => [{ nextval: 1070 }]),
  };
  db.$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(db);
  const notifications = { send: jest.fn(async () => undefined) };
  const availability = { checkAvailability: jest.fn(async () => ({ unavailableResources: [] })) };
  const requesters = { forRequest: jest.fn(async () => 5), ofProject: jest.fn(async () => 5) };
  const svc = new ReservationsService(db, availability as any, {} as any, notifications as any, {} as any, {} as any, requesters as any);
  (svc as any).resolveTaskWarehouse = jest.fn(async () => ({ warehouseId: null, objectId: 600 }));
  (svc as any).stillReservable = jest.fn(async () => true);
  return { svc, db, subs, rows, history, notifications };
}

const DTO = {
  taskId: 500,
  projectId: 20,
  projectName: 'Բնակելի շենք',
  entityId: 1,
  startDate: '2026-10-09T08:00:00.000Z',
  endDate: '2026-10-12T17:00:00.000Z',
  resources: [{ itemId: 7, quantity: 3 }, { itemId: 8, quantity: 1 }],
};

describe('POST /reservations (deprecated task route) files a submission', () => {
  it('one CatalogSubmission per call — the task, its project and object, purpose «Առաջադրանքի հայտ», the caller, the end day — and every row carries it', async () => {
    const w = world();
    const out = await w.svc.create(DTO as any, 30);
    expect(w.db.catalogSubmission.create).toHaveBeenCalledTimes(1);
    const data = w.db.catalogSubmission.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ number: 'REQ-1070', taskId: 500, projectId: 20, projectName: 'Բնակելի շենք', objectId: 600, entityId: 1, createdBy: 30, purpose: TASK_REQUEST_PURPOSE });
    expect(data.neededBy.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(w.rows).toHaveLength(2);
    for (const r of w.rows) expect(r.submissionId).toBe(900);
    expect(out.created).toHaveLength(2);
    expect(out.submission).toEqual({ id: 900, number: 'REQ-1070' });
  });

  it('a request that names only a project still files one (taskId null); the requester company is the submission’s organisation when the body names none', async () => {
    const w = world();
    (w.svc as any).resolveTaskWarehouse = jest.fn(async () => ({ warehouseId: null, objectId: null }));
    await w.svc.create({ ...DTO, taskId: undefined, entityId: undefined } as any, 30);
    expect(w.db.catalogSubmission.create.mock.calls[0][0].data).toMatchObject({ taskId: null, objectId: null, entityId: 5 });
  });
});

describe('PATCH /reservations/task/:id (deprecated) attaches new rows to the task’s open request', () => {
  it('the task has an open submission: new rows join it, nothing new is filed', async () => {
    const w = world({ openSubmission: { id: 55, number: 'REQ-1055' } });
    await w.svc.updateTaskReservations(500, DTO as any, 30);
    expect(w.db.catalogSubmission.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { taskId: 500, cancelledAt: null } }));
    expect(w.db.catalogSubmission.create).not.toHaveBeenCalled();
    expect(w.rows).toHaveLength(2);
    for (const r of w.rows) expect(r.submissionId).toBe(55);
  });

  it('no open submission: ONE is filed for the edit, and both new rows carry it', async () => {
    const w = world({ openSubmission: null });
    await w.svc.updateTaskReservations(500, DTO as any, 30);
    expect(w.db.catalogSubmission.create).toHaveBeenCalledTimes(1);
    expect(w.db.catalogSubmission.create.mock.calls[0][0].data).toMatchObject({ taskId: 500, purpose: TASK_REQUEST_PURPOSE, createdBy: 30 });
    for (const r of w.rows) expect(r.submissionId).toBe(900);
  });

  it('an edit that creates no row files nothing', async () => {
    const w = world({ openSubmission: null });
    await w.svc.updateTaskReservations(500, { ...DTO, resources: [] } as any, 30);
    expect(w.db.catalogSubmission.findFirst).not.toHaveBeenCalled();
    expect(w.db.catalogSubmission.create).not.toHaveBeenCalled();
  });
});

describe('GET /reservations/:id names the request it belongs to', () => {
  const build = (submissionId: number | null, acceptedQuantity = 0) => {
    const db: any = {
      resourceReservation: {
        findUnique: jest.fn(async ({ select }: any) =>
          select?.quantity && Object.keys(select).length === 1
            ? { quantity: 3 }
            : { id: 41, itemId: 7, quantity: 3, status: 'ALLOCATED', submissionId, acceptedQuantity, taskId: 500, item: { id: 7, type: 'CONSUMABLE', category: { id: 1, name: 'c', entityId: 1 } }, allocations: [], statusHistory: [], allocationHistory: [], returns: [] }),
      },
      reservationAllocation: { aggregate: jest.fn(async () => ({ _sum: { quantity: 3 } })) },
      resourceReturn: { aggregate: jest.fn(async () => ({ _sum: { quantity: 0 } })) },
      purchaseRequisitionLine: { findMany: jest.fn(async () => []) },
    };
    const svc = new ReservationsService(db, {} as any, {} as any, { send: async () => undefined } as any, {} as any, {} as any, {} as any);
    (svc as any).assertMayReadById = jest.fn(async () => undefined);
    return { svc, db };
  };

  it('submissionId is on the answer (55); a row older than the migrations answers null, never undefined', async () => {
    expect((await build(55).svc.getOne(41, {} as any))?.submissionId).toBe(55);
    const old = await build(null).svc.getOne(41, {} as any);
    expect(old).toHaveProperty('submissionId', null);
  });

  it('the notice links a reservation to the queue, where the page resolves the request (?reservation=)', () => {
    expect(warehouseLinks.reservation(41)).toBe('/goods-requests?tab=approve&reservation=41');
    expect((new ReservationsService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any).reservationsPath([])).toBe('/goods-requests?tab=approve');
  });
});

describe('the post-issue rules the queue drives keep their guards', () => {
  it('reclaim: more than the issued-but-unaccepted remainder is refused (400), nothing written', async () => {
    const updates: any[] = [];
    const db: any = {
      resourceReservation: {
        findUnique: jest.fn(async () => ({ id: 41, status: 'ALLOCATED', acceptedQuantity: 2, item: { type: 'CONSUMABLE', name: 'Ցեմենտ' } })),
        update: jest.fn(async (a: any) => updates.push(a)),
      },
      reservationAllocation: { findMany: jest.fn(async () => [{ id: 9, quantity: 3 }]), update: jest.fn(async (a: any) => updates.push(a)) },
    };
    db.$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(db);
    const svc = new ReservationsService(db, {} as any, {} as any, { send: async () => undefined } as any, {} as any, {} as any, {} as any);
    await expect(svc.reclaim(41, 3, 2, false)).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it('release: once acceptance has started a consumable allocation cannot be released whole (400) — «Հետ վերցնել» is the way', async () => {
    const db: any = {
      reservationAllocation: {
        findUnique: jest.fn(async () => ({ id: 9, quantity: 3, reservationId: 41, reservation: { id: 41, acceptedQuantity: 1, itemId: 7, item: { type: 'CONSUMABLE' } } })),
      },
    };
    const svc = new ReservationsService(db, {} as any, {} as any, { send: async () => undefined } as any, {} as any, {} as any, {} as any);
    await expect(svc.releaseAllocation(9, 3)).rejects.toThrow('Հետ վերցնել');
  });
});
