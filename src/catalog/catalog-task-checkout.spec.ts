import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';

import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

/**
 * Task requests through the catalog (2026-10-08).
 *
 * The CRM task modal's «Հայտ կատալոգից» opens the warehouse catalog with the
 * task (/catalog?taskId=); its «Ընտրել կատալոգից» drawer checks out from
 * inside CRM. Either way the checkout names the task (CheckoutDto.taskId).
 * Who may name it is isOnTask's rule (owner 2026-10-08, kept): the task's
 * creator or one of its role slots — or the desk (manage_reservations / a
 * super admin). The task decides the project (a project that disagrees is
 * refused) and the object (the task's, so costs land on it). Stocked lines
 * reach createForCatalog with the card, so the rows are task rows; the
 * purchase line's requisition is bound to the task.
 *
 * Reading a task's submissions (GET /catalog/submissions/task/:id) follows
 * GET /reservations/task/:id: on the task, the warehouse readers, the queue,
 * or the task's own company.
 *
 * CRM's card: task 500 (project 20, object 600) was created by 30, executor
 * 31, acceptor 32; task 501 (project 21, no object) has nobody; 999 is
 * unknown.
 */

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

const CREATOR = 30;
const EXECUTOR = 31;
const ACCEPTOR = 32;
const DESK = 40; // manage_reservations
const READER = 41; // view_reservations
const QUEUE = 42; // view_catalog_requests
const NOBODY = 51;
const OUTSIDE = 52; // page_warehouse in another company
const ADMIN = 99;

const TASK_500 = { id: 500, title: 'Հիմքի բետոնացում', projectId: 20, objectId: 600, createdById: CREATOR, executors: [{ id: EXECUTOR }], acceptors: [{ id: ACCEPTOR }], responsibles: [] };
const TASK_501 = { id: 501, title: 'Առանց մարդկանց', projectId: 21, objectId: null, createdById: null, executors: [], acceptors: [], responsibles: [] };

const PERMS: Record<number, string[]> = {
  [CREATOR]: ['page_warehouse'],
  [EXECUTOR]: ['page_warehouse', 'view_warehouse'],
  [ACCEPTOR]: ['page_warehouse'],
  [DESK]: ['page_warehouse', 'manage_reservations'],
  [READER]: ['view_reservations'],
  [QUEUE]: ['view_catalog_requests'],
  [NOBODY]: ['page_warehouse'],
  [OUTSIDE]: ['page_warehouse'],
  [ADMIN]: [],
};
const actor = (userId: number): any => ({
  userId,
  isSuperAdmin: userId === ADMIN,
  isGlobalSuperAdmin: userId === ADMIN,
  readOnly: false,
  permissionNames: PERMS[userId] ?? [],
  home: { wildcard: userId === ADMIN, entityIds: [userId === OUTSIDE ? 2 : 1] },
  declared: userId === OUTSIDE ? 2 : 1,
});

function world() {
  process.env.CRM_API_URL = 'http://crm.test';
  process.env.INTERNAL_SECRET = 's3cret';
  const subs: any[] = [];
  const prisma: any = {
    item: {
      findMany: jest.fn(async ({ where }: any) =>
        [
          { id: 7, name: 'Ցեմենտ', code: 'C-7', unit: 'KG', stockingMode: 'STOCKED', type: 'CONSUMABLE', variantLabel: null, variants: [] },
          { id: 8, name: 'Ներկ', code: 'P-8', unit: 'LITER', stockingMode: 'STOCKED', type: 'CONSUMABLE', variantLabel: null, variants: [] },
        ].filter((i) => where.id.in.includes(i.id)),
      ),
    },
    catalogSubmission: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 100 + subs.length, ...data, createdAt: new Date(), cancelledAt: null, reminders: [] };
        subs.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        subs.filter((s) => (where.id != null ? s.id === where.id : where.taskId != null ? s.taskId === where.taskId : true)),
      ),
      delete: jest.fn(async () => undefined),
    },
    resourceReservation: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => undefined) },
    purchaseRequisition: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => undefined) },
    $queryRaw: jest.fn(async () => [{ nextval: 1060 }]),
  };
  const users: any = { getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id, firstName: 'Ա', lastName: `${id}` }))) };
  const cards: Record<number, any> = { 500: TASK_500, 501: TASK_501 };
  const reservations: any = {
    createForCatalog: jest.fn(async (input: any) => ({
      created: input.lines.map((l: any, i: number) => ({
        id: 700 + i, itemId: l.itemId, quantity: l.quantity, status: 'APPROVED', itemName: `#${l.itemId}`,
        taskId: input.task?.id ?? null, objectId: input.task?.objectId ?? input.object?.id ?? null, projectId: input.projectId,
      })),
    })),
    // The real one trims CRM's answer the same way (ReservationsService.taskCard).
    taskCard: jest.fn(async (id: number) => {
      const t = cards[id];
      if (!t) throw Object.assign(new Error('not found'), { status: 404 });
      const ids = (role: string) => (t[role] ?? []).map((u: any) => u.id);
      return { id: t.id, title: t.title, projectId: t.projectId, objectId: t.objectId, createdById: t.createdById, people: [...ids('executors'), ...ids('acceptors'), ...ids('responsibles')] };
    }),
    isOnTask: jest.fn(async (id: number, userId: number) => {
      const t = cards[id];
      return !!t && (t.createdById === userId || ['executors', 'acceptors', 'responsibles'].some((r) => t[r].some((u: any) => u.id === userId)));
    }),
    requesterOfProject: jest.fn(async (projectId: number) => (projectId === 20 ? 1 : null)),
  };
  const requisitions: any = {
    create: jest.fn(async (dto: any) => ({ id: 300, status: 'PENDING_APPROVAL', title: dto.title, comment: dto.comment, taskId: dto.taskId ?? null, lines: [] })),
    announceSubmitted: jest.fn(),
  };
  const objects: any = {
    crmObjects: jest.fn(async () => [{ id: 600, code: 'O-600', name: 'Արաբկիր', projectId: 20, entityId: 1, status: 'IN_PROGRESS', responsibleId: 77 }]),
    crmObjectsFresh: jest.fn(async () => objects.crmObjects()),
  };
  const svc = new CatalogService(prisma, users, reservations, requisitions, {} as any, {} as any, undefined, undefined, objects);
  (svc as any).directory = jest.fn(async () => ({ unitOf: new Map(), entityName: new Map() }));
  (svc as any).crmProjectNames = jest.fn(async () => new Map([[20, 'Բնակելի շենք'], [21, 'Այլ նախագիծ']]));
  // 7 is on the shelf (10), 8 is out — the second becomes a purchase line.
  (svc as any).freeStock = jest.fn(async () => new Map([[7, 10], [8, 0]]));
  const net = jest.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
    throw new Error(`unexpected network call: ${String(url)}`);
  });
  const controller = new CatalogController(svc);
  return { svc, controller, prisma, reservations, requisitions, subs, net };
}

afterEach(() => jest.restoreAllMocks());

const CART = { lines: [{ itemId: 7, quantity: 3 }, { itemId: 8, quantity: 2 }], purpose: 'Հիմքի բետոնացում', neededBy: '2099-12-01' };

describe('POST /catalog/checkout with taskId', () => {
  it('a role-slot person (executor): 201 — the submission carries the task, ITS project and ITS object; the stock rows are made with the card as task rows; the purchase line is bound to the task', async () => {
    const w = world();
    const view = await w.controller.checkout({ ...CART, taskId: 500 } as any, EXECUTOR, actor(EXECUTOR));
    expect(w.prisma.catalogSubmission.create).toHaveBeenCalledTimes(1);
    expect(w.prisma.catalogSubmission.create.mock.calls[0][0].data).toMatchObject({ taskId: 500, objectId: 600, projectId: 20, projectName: 'Բնակելի շենք', createdBy: EXECUTOR });
    expect(w.reservations.createForCatalog).toHaveBeenCalledTimes(1);
    const input = w.reservations.createForCatalog.mock.calls[0][0];
    expect(input.task).toMatchObject({ id: 500, projectId: 20, objectId: 600 });
    expect(input.taskProjectName).toBe('Բնակելի շենք');
    expect(input.object).toBeNull();
    expect(input.lines).toEqual([{ itemId: 7, quantity: 3 }]);
    expect(input.projectId).toBe(20);
    expect(w.requisitions.create).toHaveBeenCalledTimes(1);
    const dto = w.requisitions.create.mock.calls[0][0];
    expect(dto.title).toBe('Կատալոգ · REQ-1060 · Առաջադրանք #500');
    expect(dto.comment).toContain('Առաջադրանք՝ #500 Հիմքի բետոնացում');
    expect(dto.taskId).toBe(500);
    expect(dto.lines.map((l: any) => l.itemId)).toEqual([8]);
    expect(view.taskId).toBe(500);
    expect(view.task).toEqual({ id: 500, title: 'Հիմքի բետոնացում', projectId: 20 });
    expect(view.projectId).toBe(20);
    expect(view.objectId).toBe(600);
    expect(view.object).toEqual({ id: 600, code: 'O-600', name: 'Արաբկիր' });
  });

  it('the creator and the acceptor may ask too; the project is the task’s even when the cart named none', async () => {
    for (const who of [CREATOR, ACCEPTOR]) {
      const w = world();
      const view = await w.controller.checkout({ ...CART, taskId: 500, projectId: undefined } as any, who, actor(who));
      expect(view.taskId).toBe(500);
      expect(w.prisma.catalogSubmission.create.mock.calls[0][0].data.projectId).toBe(20);
      jest.restoreAllMocks();
    }
  });

  it('a matching projectId is accepted; a mismatching one is refused (400) before anything is written', async () => {
    const ok = world();
    await expect(ok.controller.checkout({ ...CART, taskId: 500, projectId: 20 } as any, EXECUTOR, actor(EXECUTOR))).resolves.toBeTruthy();
    jest.restoreAllMocks();
    const w = world();
    await expect(w.controller.checkout({ ...CART, taskId: 500, projectId: 21 } as any, EXECUTOR, actor(EXECUTOR))).rejects.toBeInstanceOf(BadRequestException);
    expect(w.prisma.catalogSubmission.create).not.toHaveBeenCalled();
    expect(w.reservations.createForCatalog).not.toHaveBeenCalled();
  });

  it('an objectId that is not the task’s object is refused (400); the task’s own is accepted without the responsible-person rule', async () => {
    const w = world();
    await expect(w.controller.checkout({ ...CART, taskId: 500, objectId: 601 } as any, EXECUTOR, actor(EXECUTOR))).rejects.toBeInstanceOf(BadRequestException);
    expect(w.prisma.catalogSubmission.create).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    const ok = world();
    const view = await ok.controller.checkout({ ...CART, taskId: 500, objectId: 600 } as any, EXECUTOR, actor(EXECUTOR));
    expect(view.objectId).toBe(600);
    expect(ok.net).not.toHaveBeenCalled(); // no object card fetched: the task vouches for its object
  });

  it('an outsider — on no slot, even with the catalog right — is refused (403), nothing written', async () => {
    const w = world();
    await expect(w.controller.checkout({ ...CART, taskId: 500 } as any, NOBODY, actor(NOBODY))).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.prisma.catalogSubmission.create).not.toHaveBeenCalled();
    expect(w.reservations.createForCatalog).not.toHaveBeenCalled();
  });

  it('the desk (manage_reservations) and a super admin may order for any task', async () => {
    for (const who of [DESK, ADMIN]) {
      const w = world();
      const view = await w.controller.checkout({ ...CART, taskId: 500 } as any, who, actor(who));
      expect(view.taskId).toBe(500);
      jest.restoreAllMocks();
    }
  });

  it('an unknown task is 404; a bad id is 400', async () => {
    const w = world();
    await expect(w.controller.checkout({ ...CART, taskId: 999 } as any, ADMIN, actor(ADMIN))).rejects.toMatchObject({ status: 404 });
    await expect(w.controller.checkout({ ...CART, taskId: -1 } as any, ADMIN, actor(ADMIN))).rejects.toBeInstanceOf(BadRequestException);
    expect(w.prisma.catalogSubmission.create).not.toHaveBeenCalled();
  });

  it('a plain checkout (no taskId) is untouched: no task on the rows, no CRM call', async () => {
    const w = world();
    const view = await w.controller.checkout({ ...CART, projectId: 20, projectName: 'Բնակելի շենք' } as any, NOBODY, actor(NOBODY));
    expect(w.reservations.taskCard).not.toHaveBeenCalled();
    expect(view.taskId).toBeNull();
    expect(view.task).toBeNull();
    expect(w.reservations.createForCatalog.mock.calls[0][0].task).toBeNull();
  });
});

describe('GET /catalog/tasks/:taskId (the chip)', () => {
  it('answers the card — title, project name, object name — to someone on the task; refuses an outsider (403)', async () => {
    const w = world();
    await expect(w.controller.task(500, actor(EXECUTOR))).resolves.toEqual({
      id: 500, title: 'Հիմքի բետոնացում', projectId: 20, projectName: 'Բնակելի շենք', objectId: 600, objectName: 'Արաբկիր',
    });
    await expect(w.controller.task(500, actor(NOBODY))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('GET /catalog/submissions/task/:taskId', () => {
  const seeded = () => {
    const w = world();
    w.subs.push(
      { id: 1, number: 'REQ-1001', createdBy: EXECUTOR, entityId: 1, taskId: 500, objectId: 600, projectId: 20, purpose: 'p', neededBy: new Date('2099-12-01'), createdAt: new Date(), cancelledAt: null, reminders: [] },
      { id: 2, number: 'REQ-1002', createdBy: NOBODY, entityId: 1, taskId: null, objectId: null, projectId: null, purpose: 'q', neededBy: new Date('2099-12-01'), createdAt: new Date(), cancelledAt: null, reminders: [] },
    );
    return w;
  };

  it('the task’s people, the reservation readers, the queue, a super admin and the task’s own company read the task’s submissions only', async () => {
    for (const who of [CREATOR, EXECUTOR, ACCEPTOR, READER, QUEUE, ADMIN, NOBODY]) {
      const w = seeded();
      const list = await w.controller.forTask(500, actor(who));
      expect(list.map((v) => v.id)).toEqual([1]);
      expect(list[0].taskId).toBe(500);
      expect(list[0].task).toEqual({ id: 500, title: 'Հիմքի բետոնացում', projectId: 20 });
      jest.restoreAllMocks();
    }
  });

  it('someone from another company, on no slot and with no warehouse right, is refused (403)', async () => {
    const w = seeded();
    await expect(w.controller.forTask(500, actor(OUTSIDE))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
