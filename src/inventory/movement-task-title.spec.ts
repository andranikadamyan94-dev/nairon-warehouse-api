import { TaskLabelsService } from '../common/task-labels.service';
import { InventoryService } from './inventory.service';

/**
 * #2616 (owner, 2026-10-09): the movements report's «Առաջադրանք» column shows
 * the task TITLE («#2325 · Կարգավիճակի սխալ պահպանում»), so the list answers
 * `taskTitle` and `taskLabel` next to `taskId`. Titles come from CRM's task
 * card through TaskLabelsService: one round per distinct task per list (never
 * one call per row), cached 120 s; CRM unreachable or the task gone → id only.
 */

const CARDS: Record<number, string> = { 2325: 'Կարգավիճակի սխալ պահպանում', 2616: 'Շարժերի հաշվետվություն' };

function crm(behaviour: 'ok' | 'down' | '404' = 'ok') {
  const calls: string[] = [];
  global.fetch = jest.fn(async (url: string) => {
    calls.push(String(url));
    if (behaviour === 'down') throw new Error('ECONNREFUSED');
    const id = Number(String(url).match(/project-tasks\/(\d+)\/internal$/)?.[1]);
    if (behaviour === '404' || !CARDS[id]) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ id, title: CARDS[id], projectId: 7 }) };
  }) as any;
  return calls;
}

function world(rows: any[]) {
  const prisma: any = {
    inventoryMovement: { findMany: jest.fn(async () => rows), count: jest.fn(async () => rows.length) },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  const users: any = { getUsersByIds: jest.fn(async () => [{ id: 1, firstName: 'Admin', lastName: 'Nairon' }]) };
  const objects: any = { crmObjects: jest.fn(async () => []) };
  const service = new InventoryService(prisma, {} as any, users, objects, undefined, new TaskLabelsService());
  return service;
}

const row = (id: number, taskId: number | null) => ({ id, itemId: 5, quantity: 2, type: 'OUT', taskId, objectId: null, performedBy: 1, createdAt: new Date() });
const realFetch = global.fetch;
beforeEach(() => { process.env.INTERNAL_SECRET = 'test-secret'; });
afterEach(() => { global.fetch = realFetch; });

describe('inventory movements · task title (#2616)', () => {
  it('answers taskTitle and the «#id · title» label; one CRM card per distinct task, none for rows without a task', async () => {
    const calls = crm();
    const res = await world([row(1, 2325), row(2, 2325), row(3, 2616), row(4, null)]).getMovements({ limit: '100' });
    expect(res.data.map((r: any) => r.taskLabel)).toEqual(['#2325 · Կարգավիճակի սխալ պահպանում', '#2325 · Կարգավիճակի սխալ պահպանում', '#2616 · Շարժերի հաշվետվություն', null]);
    expect(res.data.map((r: any) => r.taskTitle)).toEqual(['Կարգավիճակի սխալ պահպանում', 'Կարգավիճակի սխալ պահպանում', 'Շարժերի հաշվետվություն', null]);
    expect(res.data[0].taskId).toBe(2325);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/\/api\/project-tasks\/2325\/internal$/);
  });

  it('CRM unreachable → id only, no error', async () => {
    crm('down');
    const res = await world([row(1, 2325)]).getMovements({});
    expect(res.data[0]).toMatchObject({ taskId: 2325, taskTitle: null, taskLabel: '#2325' });
  });

  it('task gone (404) → id only', async () => {
    crm('404');
    const res = await world([row(1, 2325)]).getMovements({});
    expect(res.data[0].taskLabel).toBe('#2325');
  });

  it('rows without any task ask CRM for nothing', async () => {
    const calls = crm();
    await world([row(1, null), row(2, null)]).getMovements({});
    expect(calls).toHaveLength(0);
  });
});

describe('TaskLabelsService · cache and batching', () => {
  it('a second list within 120 s reuses the titles; a miss is asked again', async () => {
    const calls = crm();
    const svc = new TaskLabelsService();
    await svc.titles([2325, 999]);
    await svc.titles([2325, 999]);
    expect(calls.filter((c) => c.includes('/2325/'))).toHaveLength(1);
    expect(calls.filter((c) => c.includes('/999/'))).toHaveLength(2);
  });

  it('asks at most BATCH cards at a time', async () => {
    let inFlight = 0, peak = 0;
    global.fetch = jest.fn(async (url: string) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const id = Number(String(url).match(/project-tasks\/(\d+)\/internal$/)?.[1]);
      return { ok: true, status: 200, json: async () => ({ id, title: `T${id}` }) };
    }) as any;
    const map = await new TaskLabelsService().titles(Array.from({ length: 20 }, (_, i) => 100 + i));
    expect(map.size).toBe(20);
    expect(peak).toBeLessThanOrEqual(TaskLabelsService.BATCH);
    expect(TaskLabelsService.label(100, map.get(100)?.title)).toBe('#100 · T100');
  });
});
