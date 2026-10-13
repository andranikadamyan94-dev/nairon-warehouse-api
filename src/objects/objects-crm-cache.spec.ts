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
