import { crmProjects, crmProjectNameMap, resetCrmProjectsCache } from './crm-projects';

/** W1 (performance audit 2026-10-13): one shared, cached, time-boxed read of CRM's projects. */
describe('crmProjects', () => {
  const realFetch = global.fetch;
  let calls: number;
  let rows: any[];
  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'test-secret';
    resetCrmProjectsCache();
    calls = 0;
    rows = [{ id: 1, name: 'Ա', entityId: 3, parentId: null, budget: 9, members: [] }];
    global.fetch = jest.fn(async (_url: any, init: any) => {
      calls++;
      expect(init.signal).toBeDefined(); // time-boxed
      return { ok: true, json: async () => rows } as any;
    }) as any;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('reads CRM once for concurrent and repeated callers, keeping only what the warehouse uses', async () => {
    const [a, b] = await Promise.all([crmProjects(), crmProjects()]);
    await crmProjects();
    expect(calls).toBe(1);
    expect(a).toEqual([{ id: 1, name: 'Ա', entityId: 3, parentId: null }]);
    expect(b).toBe(a);
  });

  it('reads past the cache once for a project it lacks, then remembers it is gone', async () => {
    await crmProjects();
    rows = [...rows, { id: 2, name: 'Բ' }];
    expect((await crmProjectNameMap(2)).get(2)).toBe('Բ');
    expect(calls).toBe(2);
    await crmProjects(99);
    await crmProjects(99);
    expect(calls).toBe(3);
  });

  it('throws when CRM fails and does not cache the failure', async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(async () => ({ ok: false, status: 500 }) as any);
    await expect(crmProjects()).rejects.toThrow('CRM projects 500');
    expect(await crmProjects()).toHaveLength(1);
  });
});
