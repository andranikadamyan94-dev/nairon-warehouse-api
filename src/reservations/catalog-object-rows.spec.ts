import { ReservationsService } from './reservations.service';

/**
 * Object requests through the catalog (2026-10-08): the stocked lines of a
 * checkout filed for a construction object become reservations that follow
 * the object rules createForObject set — stamped with the object and its
 * project, drawn from the project's warehouse (else main), the object's
 * organization as requester — while still being the submission's rows. A
 * plain checkout keeps making object-less main-pool rows.
 */

const CARD = { id: 600, code: 'O-600', name: 'Արաբկիր', projectId: 20, projectName: 'Բնակելի շենք', entityId: 1, responsibleId: 32 };
const PROJECT_WAREHOUSE = 3;

function world(opts: { projectWarehouse?: number | null; free?: boolean } = {}) {
  const rows: any[] = [];
  const history: any[] = [];
  const db: any = {
    item: { findMany: async () => [{ id: 7, type: 'CONSUMABLE', name: 'Ցեմենտ' }, { id: 8, type: 'CONSUMABLE', name: 'Ներկ' }] },
    resourceReservation: {
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
  (svc as any).objectWarehouse = jest.fn(async (card: any) => (card.projectId === 20 ? (opts.projectWarehouse ?? null) : null));
  return { svc, rows, history, requesters };
}

const INPUT = {
  submissionId: 55,
  number: 'REQ-1052',
  lines: [{ itemId: 7, quantity: 3 }, { itemId: 8, quantity: 1.5 }],
  projectId: 20,
  projectName: 'Բնակելի շենք',
  entityId: 1,
  purpose: 'Հիմքի բետոնացում',
  neededBy: new Date('2099-12-01T00:00:00.000Z'),
  performedBy: 32,
};

describe('createForCatalog with an object card', () => {
  it('every row carries the object, its project, the project’s warehouse and the submission', async () => {
    const w = world({ projectWarehouse: PROJECT_WAREHOUSE });
    const { created } = await w.svc.createForCatalog({ ...INPUT, object: CARD });
    expect(created).toHaveLength(2);
    for (const r of w.rows) {
      expect(r).toMatchObject({ objectId: 600, projectId: 20, projectName: 'Բնակելի շենք', warehouseId: PROJECT_WAREHOUSE, submissionId: 55, taskId: null, status: 'APPROVED', requesterWorkspaceId: 5 });
    }
    // The shelf asked is the project's.
    for (const call of ((w.svc as any).stillReservable as jest.Mock).mock.calls) expect(call[5]).toBe(PROJECT_WAREHOUSE);
    expect(w.history[0]).toMatchObject({ toStatus: 'APPROVED', performedBy: 32 });
    expect(w.history[0].reason).toContain('REQ-1052');
    expect(w.history[0].reason).toContain('Արաբկիր');
    expect(w.history[0].reason).not.toContain('O-600');
  });

  it('no project warehouse: main (null), and the object’s organization when the project names no requester', async () => {
    const w = world({ projectWarehouse: null });
    w.requesters.forRequest.mockResolvedValue(null);
    await w.svc.createForCatalog({ ...INPUT, object: CARD });
    expect(w.rows[0]).toMatchObject({ objectId: 600, warehouseId: null, requesterWorkspaceId: 1 });
  });

  it('short on the shelf: PENDING for the warehouse to decide, as any object request', async () => {
    const w = world({ projectWarehouse: PROJECT_WAREHOUSE, free: false });
    const { created } = await w.svc.createForCatalog({ ...INPUT, object: CARD });
    expect(created.map((c: any) => c.status)).toEqual(['PENDING', 'PENDING']);
  });

  it('a plain checkout is untouched: no object, main pool, the project as named', async () => {
    const w = world({ projectWarehouse: PROJECT_WAREHOUSE });
    await w.svc.createForCatalog({ ...INPUT, object: null });
    expect(w.rows[0]).toMatchObject({ objectId: null, warehouseId: null, projectId: 20, requesterWorkspaceId: 9 });
    expect((w.svc as any).objectWarehouse).not.toHaveBeenCalled();
  });
});
