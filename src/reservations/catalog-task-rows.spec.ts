import { BadRequestException } from '@nestjs/common';

import { ReservationsService } from './reservations.service';

/**
 * Task requests through the catalog (2026-10-08): the stocked lines of a
 * checkout filed for a CRM task become TASK rows — stamped with the task and
 * its object, the task's project as requester, drawn from the project's
 * warehouse — while still being the submission's rows. Owner 2026-10-08: a
 * project linked to no warehouse (or to an inactive one) is served by MAIN,
 * exactly as object rows are; the old manual route keeps refusing it.
 *
 * CRM's task: 500 (project 20, object 600). Links: per case.
 */

const TASK = { id: 500, title: 'Հիմքի բետոնացում', projectId: 20, objectId: 600, createdById: 30, people: [31] };

function world(opts: { link?: { warehouseId: number; warehouse: { type: string; status: string } } | null; free?: boolean } = {}) {
  process.env.CRM_API_URL = 'http://crm.test';
  process.env.INTERNAL_SECRET = 's3cret';
  const rows: any[] = [];
  const history: any[] = [];
  const db: any = {
    item: { findMany: async () => [{ id: 7, type: 'CONSUMABLE', name: 'Ցեմենտ' }, { id: 8, type: 'CONSUMABLE', name: 'Ներկ' }] },
    resourceReservation: {
      // No row yet for the task: the binding is resolved fresh.
      findFirst: async () => null,
      create: async ({ data }: any) => {
        const row = { id: 700 + rows.length, ...data };
        rows.push(row);
        return row;
      },
    },
    reservationStatusHistory: { create: async ({ data }: any) => history.push(data) },
  };
  db.$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(db);
  const requesters = {
    forRequest: jest.fn(async ({ projectId }: any) => (projectId === 20 ? 5 : null)),
    ofProject: jest.fn(async () => 9),
  };
  const svc = new ReservationsService(db, {} as any, {} as any, { send: async () => undefined } as any, {} as any, {} as any, requesters as any);
  (svc as any).stillReservable = jest.fn(async () => opts.free ?? true);
  (svc as any).linkForProject = jest.fn(async () => opts.link ?? null);
  jest.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
    if (/\/api\/project-tasks\/500\/internal$/.test(String(url))) return { ok: true, status: 200, json: async () => ({ id: 500, projectId: 20, objectId: 600 }) } as any;
    throw new Error(`unexpected network call: ${String(url)}`);
  });
  return { svc, rows, history, requesters };
}

afterEach(() => jest.restoreAllMocks());

const INPUT = {
  submissionId: 55,
  number: 'REQ-1060',
  lines: [{ itemId: 7, quantity: 3 }, { itemId: 8, quantity: 1.5 }],
  projectId: 20,
  projectName: 'Բնակելի շենք',
  entityId: 1,
  purpose: 'Հիմքի բետոնացում',
  neededBy: new Date('2099-12-01T00:00:00.000Z'),
  performedBy: 31,
  task: TASK,
  taskProjectName: 'Բնակելի շենք',
};

describe('createForCatalog with a task card', () => {
  it('a project linked to no warehouse: the rows land on MAIN (null), stamped with the task, its object and project — no refusal', async () => {
    const w = world({ link: null });
    const { created } = await w.svc.createForCatalog(INPUT);
    expect(created).toHaveLength(2);
    for (const r of w.rows) {
      expect(r).toMatchObject({ taskId: 500, objectId: 600, projectId: 20, projectName: 'Բնակելի շենք', warehouseId: null, submissionId: 55, status: 'APPROVED', requesterWorkspaceId: 5 });
    }
    for (const call of ((w.svc as any).stillReservable as jest.Mock).mock.calls) expect(call[5]).toBeNull();
    expect(w.history[0]).toMatchObject({ toStatus: 'APPROVED', performedBy: 31 });
    expect(w.history[0].reason).toContain('REQ-1060');
    expect(w.history[0].reason).toContain('#500');
  });

  it('a project linked to an active sub-warehouse: the rows draw from it', async () => {
    const w = world({ link: { warehouseId: 3, warehouse: { type: 'PROJECT', status: 'ACTIVE' } } });
    await w.svc.createForCatalog(INPUT);
    expect(w.rows[0]).toMatchObject({ taskId: 500, objectId: 600, warehouseId: 3 });
    for (const call of ((w.svc as any).stillReservable as jest.Mock).mock.calls) expect(call[5]).toBe(3);
  });

  it('a project linked to an inactive sub-warehouse: MAIN, as object rows do', async () => {
    const w = world({ link: { warehouseId: 3, warehouse: { type: 'PROJECT', status: 'ARCHIVED' } } });
    await w.svc.createForCatalog(INPUT);
    expect(w.rows[0]).toMatchObject({ taskId: 500, warehouseId: null });
  });

  it('short on the shelf: PENDING for the warehouse to decide, as any task request', async () => {
    const w = world({ link: null, free: false });
    const { created } = await w.svc.createForCatalog(INPUT);
    expect(created.map((c: any) => c.status)).toEqual(['PENDING', 'PENDING']);
  });

  it('the manual route’s resolution still refuses an unlinked project (400) — only the catalog path falls back', async () => {
    const w = world({ link: null });
    await expect((w.svc as any).resolveTaskWarehouse(500)).rejects.toBeInstanceOf(BadRequestException);
    await expect((w.svc as any).resolveTaskWarehouse(500, { fallbackToMain: true })).resolves.toEqual({ warehouseId: null, objectId: 600 });
  });
});
