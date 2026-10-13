import { UsersService } from './users.service';

/** /users answers names only and asks auth once a minute (performance audit 2026-10-13). */
describe('UsersService.getAll', () => {
  const realFetch = global.fetch;
  let calls = 0;
  const make = () => new UsersService({ get: (_k: string, d: string) => d } as any);
  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'test-secret';
    calls = 0;
    global.fetch = jest.fn(async () => {
      calls++;
      return {
        ok: true,
        json: async () => [{ id: 3, firstName: 'Անի', lastName: 'Հակոբյան', email: 'a@x', roles: [{ role: { permissions: [] } }] }],
      } as any;
    }) as any;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('keeps only id and names, and reads auth once for repeated and concurrent callers', async () => {
    const svc = make();
    const [a] = await Promise.all([svc.getAll(), svc.getAll()]);
    await svc.getAll();
    expect(a).toEqual([{ id: 3, firstName: 'Անի', lastName: 'Հակոբյան' }]);
    expect(calls).toBe(1);
  });

  it('a refusal from auth is handed back as before and not remembered', async () => {
    const svc = make();
    (global.fetch as jest.Mock).mockImplementationOnce(async () => ({ ok: false, json: async () => ({ statusCode: 401 }) }) as any);
    expect(await svc.getAll()).toEqual({ statusCode: 401 });
    expect(await svc.getAll()).toHaveLength(1);
  });
});
