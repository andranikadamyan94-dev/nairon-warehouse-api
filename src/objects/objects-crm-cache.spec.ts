import { ObjectsService } from './objects.service';

/** W1 (performance audit 2026-10-13): the CRM object catalogue is shared, time-boxed and remembers gone ids. */
describe('ObjectsService · CRM catalogue cache', () => {
  const realFetch = global.fetch;
  let calls: number;
  let rows: any[];
  let svc: ObjectsService;
  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'test-secret';
    calls = 0;
    rows = [{ id: 1, code: 'O-1', name: 'Ա' }];
    global.fetch = jest.fn(async (_u: any, init: any) => {
      calls++;
      expect(init.signal).toBeDefined();
      return { ok: true, json: async () => rows } as any;
    }) as any;
    svc = new ObjectsService({} as any);
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('concurrent readers share one CRM read', async () => {
    await Promise.all([svc.crmObjects(), svc.crmObjects(), svc.crmObject(1)]);
    expect(calls).toBe(1);
  });

  it('a new object is found past the cache; a gone one stops busting it', async () => {
    await svc.crmObjects();
    rows = [...rows, { id: 2, code: 'O-2', name: 'Բ' }];
    expect((await svc.crmObject(2))?.name).toBe('Բ');
    expect(calls).toBe(2);
    expect(await svc.crmObject(99)).toBeUndefined();
    expect(await svc.crmObject(99)).toBeUndefined();
    expect(await svc.crmObjectsCovering([1, 99])).toHaveLength(2);
    expect(calls).toBe(3);
  });

  it('a read for a decision still goes past everything', async () => {
    await svc.crmObject(99);
    await svc.crmObjectFresh(99);
    expect(calls).toBe(3);
  });
});

/** The object page's three reads share one CRM task-id lookup (performance audit 2026-10-13). */
describe('ObjectsService · object page reads', () => {
  const realFetch = global.fetch;
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('summary + materials + movements opened together ask CRM for the task ids once, same answers', async () => {
    process.env.INTERNAL_SECRET = 'test-secret';
    const urls: string[] = [];
    global.fetch = jest.fn(async (url: any) => {
      urls.push(String(url));
      const body = String(url).endsWith('/task-ids') ? { taskIds: [5] } : [{ id: 13, code: 'O-13', name: 'Ա', plannedCost: 100 }];
      return { ok: true, json: async () => body } as any;
    }) as any;
    const rows = [
      { id: 1, itemId: 7, type: 'OUT', quantity: -2, totalCost: 20, taskId: 5, createdAt: new Date(1), item: { name: 'Բետոն' }, warehouse: null },
    ];
    const prisma: any = {
      inventoryMovement: { findMany: jest.fn(async () => rows), count: jest.fn(async () => 1) },
      objectEstimateLine: { findMany: jest.fn(async () => []) },
    };
    const svc = new ObjectsService(prisma);
    const [summary, materials, movements] = await Promise.all([svc.summary(13), svc.materials(13), svc.movements(13)]);
    expect(urls.filter((u) => u.endsWith('/13/task-ids'))).toHaveLength(1);
    expect(summary.actualMaterialCost).toBe(20);
    expect(materials[0]).toMatchObject({ itemId: 7, issuedQuantity: 2, netCost: 20, taskIds: [5] });
    expect(movements).toEqual({ data: rows, total: 1, page: 1, limit: 20 });
    expect(prisma.inventoryMovement.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ objectId: 13 }, { taskId: { in: [5] }, type: { in: ['OUT', 'IN'] } }],
    });
  });
});
