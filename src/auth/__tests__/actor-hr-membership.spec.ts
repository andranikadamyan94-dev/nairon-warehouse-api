import { WarehouseActorService } from '../actor.service';

/**
 * HR membership since the 2026-10-13 perf pass: the slim GET /entities/mine
 * (a 404 from an older hr-api falls back to GET /entities), kept two minutes,
 * one HR call per burst.
 */
describe('WarehouseActorService — HR membership lookup', () => {
  const realFetch = global.fetch;
  const prevHr = process.env.HR_SERVICE_URL;
  let calls: string[] = [];
  const install = (answer: (href: string) => Response) => {
    calls = [];
    global.fetch = (async (url: any) => {
      calls.push(String(url));
      return answer(String(url));
    }) as typeof fetch;
  };
  beforeAll(() => (process.env.HR_SERVICE_URL = 'http://hr.test'));
  afterAll(() => {
    global.fetch = realFetch;
    process.env.HR_SERVICE_URL = prevHr;
  });

  const usersPrisma: any = { getUserWorkspaces: async () => ({ wildcard: false, entityIds: [] }) };
  const homes = (svc: WarehouseActorService, userId = 5) => (svc as any).fromHr(userId, 'Bearer t') as Promise<number[]>;

  it('reads /api/entities/mine, once for a burst, and keeps it', async () => {
    install(() => new Response(JSON.stringify([{ id: 4, name: 'A' }]), { status: 200 }));
    const svc = new WarehouseActorService(usersPrisma);
    expect(await Promise.all([homes(svc), homes(svc), homes(svc)])).toEqual([[4], [4], [4]]);
    expect(await homes(svc)).toEqual([4]);
    expect(calls).toEqual(['http://hr.test/api/entities/mine']);
    expect(WarehouseActorService.FRESH_MS).toBe(2 * 60_000);
  });

  it('falls back to /api/entities on a 404', async () => {
    install((href) =>
      href.endsWith('/mine') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify([{ id: 9 }]), { status: 200 }),
    );
    expect(await homes(new WarehouseActorService(usersPrisma))).toEqual([9]);
    expect(calls).toEqual(['http://hr.test/api/entities/mine', 'http://hr.test/api/entities']);
  });
});
