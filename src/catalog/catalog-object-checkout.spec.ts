import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Logger } from '@nestjs/common';

import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

/**
 * Object requests through the catalog (2026-10-08).
 *
 * The CRM object page's «Հայտ կատալոգից» opens the warehouse catalog with
 * the object; the checkout then names it (CheckoutDto.objectId). Who may
 * name it is what POST /reservations/object/:id asked: the object's
 * responsible person as CRM's internal card names them — or the desk
 * (manage_reservations / a super admin). The object decides the project;
 * a project that disagrees with the object's is refused. Stocked lines
 * reach createForCatalog with the card, so the rows carry the object.
 *
 * Reading an object's submissions (GET /catalog/submissions/object/:id)
 * follows the «Պահեստային հայտեր» tab's rule: view_object_requests, the
 * responsible person, or a super admin.
 *
 * CRM's card: object 600 (project 20) is the responsibility of 32; object
 * 601 has nobody responsible; 999 is unknown.
 */

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

const RESPONSIBLE = 32;
const DESK = 40; // manage_reservations
const TAB = 61; // view_object_requests
const NOBODY = 51;
const ADMIN = 99;

const CARD_600 = { id: 600, code: 'O-600', name: 'Արաբկիր', projectId: 20, projectName: 'Բնակելի շենք', entityId: 1, responsibleId: RESPONSIBLE };
const CARD_601 = { id: 601, code: 'O-601', name: 'Հարթակ', projectId: null, projectName: null, entityId: 1, responsibleId: null };

const PERMS: Record<number, string[]> = {
  [RESPONSIBLE]: ['page_warehouse'],
  [DESK]: ['page_warehouse', 'manage_reservations'],
  [TAB]: ['view_object_requests'],
  [NOBODY]: ['page_warehouse', 'manage_warehouse', 'view_warehouse'],
  [ADMIN]: [],
};
const actor = (userId: number): any => ({
  userId,
  isSuperAdmin: userId === ADMIN,
  isGlobalSuperAdmin: userId === ADMIN,
  readOnly: false,
  permissionNames: PERMS[userId] ?? [],
  home: { wildcard: userId === ADMIN, entityIds: [1] },
  declared: 1,
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
        subs.filter((s) => (where.id != null ? s.id === where.id : where.objectId != null ? s.objectId === where.objectId : true)),
      ),
      delete: jest.fn(async () => undefined),
    },
    resourceReservation: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => undefined) },
    purchaseRequisition: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => undefined) },
    $queryRaw: jest.fn(async () => [{ nextval: 1052 }]),
  };
  const users: any = { getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id, firstName: 'Ա', lastName: `${id}` }))) };
  const reservations: any = {
    createForCatalog: jest.fn(async (input: any) => ({
      created: input.lines.map((l: any, i: number) => ({ id: 700 + i, itemId: l.itemId, quantity: l.quantity, status: 'APPROVED', itemName: `#${l.itemId}`, objectId: input.object?.id ?? null })),
    })),
  };
  const requisitions: any = {
    create: jest.fn(async (dto: any) => ({ id: 300, status: 'PENDING_APPROVAL', title: dto.title, comment: dto.comment, lines: [] })),
    announceSubmitted: jest.fn(),
  };
  const objects: any = {
    crmObjectsFresh: jest.fn(async () => [
      { ...CARD_600, status: 'IN_PROGRESS' },
      { ...CARD_601, status: 'PLANNED' },
      { id: 602, code: 'O-602', name: 'Այլ', projectId: 21, entityId: 1, status: 'PLANNED', responsibleId: 77 },
    ]),
    crmObjects: jest.fn(async () => objects.crmObjectsFresh()),
  };
  const svc = new CatalogService(prisma, users, reservations, requisitions, {} as any, {} as any, undefined, undefined, objects);
  (svc as any).directory = jest.fn(async () => ({ unitOf: new Map(), entityName: new Map() }));
  (svc as any).crmProjectNames = jest.fn(async () => new Map([[20, 'Բնակելի շենք']]));
  // 7 is on the shelf (10), 8 is out — the second becomes a purchase line.
  (svc as any).freeStock = jest.fn(async () => new Map([[7, 10], [8, 0]]));
  const net = jest.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
    const m = String(url).match(/^http:\/\/crm\.test\/api\/construction-objects\/internal\/(\d+)\/card$/);
    if (!m || init?.headers?.['x-internal-secret'] !== 's3cret') throw new Error(`unexpected network call: ${String(url)}`);
    const id = Number(m[1]);
    const card = id === 600 ? CARD_600 : id === 601 ? CARD_601 : null;
    if (!card) return { ok: false, status: 404 } as any;
    return { ok: true, status: 200, json: async () => card } as any;
  });
  const controller = new CatalogController(svc);
  return { svc, controller, prisma, reservations, requisitions, subs, net };
}

afterEach(() => jest.restoreAllMocks());

const CART = { lines: [{ itemId: 7, quantity: 3 }, { itemId: 8, quantity: 2 }], purpose: 'Հիմքի բետոնացում', neededBy: '2099-12-01' };

describe('POST /catalog/checkout with objectId', () => {
  it('the responsible person: the submission carries the object and ITS project; the stock rows are made with the card; the purchase line names the object', async () => {
    const w = world();
    const view = await w.controller.checkout({ ...CART, objectId: 600 } as any, RESPONSIBLE, actor(RESPONSIBLE));
    expect(w.prisma.catalogSubmission.create).toHaveBeenCalledTimes(1);
    expect(w.prisma.catalogSubmission.create.mock.calls[0][0].data).toMatchObject({ objectId: 600, projectId: 20, projectName: 'Բնակելի շենք', createdBy: RESPONSIBLE });
    expect(w.reservations.createForCatalog).toHaveBeenCalledTimes(1);
    const input = w.reservations.createForCatalog.mock.calls[0][0];
    expect(input.object).toEqual(CARD_600);
    expect(input.lines).toEqual([{ itemId: 7, quantity: 3 }]);
    expect(input.projectId).toBe(20);
    // The requisition for the out-of-stock line: the object in its title and comment (no object column).
    expect(w.requisitions.create).toHaveBeenCalledTimes(1);
    const dto = w.requisitions.create.mock.calls[0][0];
    expect(dto.title).toBe('Կատալոգ · REQ-1052 · Արաբկիր');
    expect(dto.comment).toContain('Օբյեկտ՝ Արաբկիր');
    expect(dto.comment).not.toContain('O-600');
    expect(dto.lines.map((l: any) => l.itemId)).toEqual([8]);
    expect(view.objectId).toBe(600);
    expect(view.object).toEqual({ id: 600, code: 'O-600', name: 'Արաբկիր' });
    expect(view.projectId).toBe(20);
  });

  it('the project is the object’s even when the cart named none', async () => {
    const w = world();
    await w.controller.checkout({ ...CART, objectId: 600, projectId: undefined } as any, RESPONSIBLE, actor(RESPONSIBLE));
    expect(w.prisma.catalogSubmission.create.mock.calls[0][0].data.projectId).toBe(20);
  });

  it('a matching projectId is accepted; a different one is refused (400) before anything is written', async () => {
    const ok = world();
    await expect(ok.controller.checkout({ ...CART, objectId: 600, projectId: 20 } as any, RESPONSIBLE, actor(RESPONSIBLE))).resolves.toBeTruthy();
    jest.restoreAllMocks();
    const w = world();
    await expect(w.controller.checkout({ ...CART, objectId: 600, projectId: 21 } as any, RESPONSIBLE, actor(RESPONSIBLE))).rejects.toBeInstanceOf(BadRequestException);
    expect(w.prisma.catalogSubmission.create).not.toHaveBeenCalled();
    expect(w.reservations.createForCatalog).not.toHaveBeenCalled();
  });

  it('someone else — even with the general warehouse rights — is refused (403), nothing written', async () => {
    const w = world();
    await expect(w.controller.checkout({ ...CART, objectId: 600 } as any, NOBODY, actor(NOBODY))).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.prisma.catalogSubmission.create).not.toHaveBeenCalled();
  });

  it('the desk (manage_reservations) and a super admin may order for any object', async () => {
    for (const who of [DESK, ADMIN]) {
      const w = world();
      const view = await w.controller.checkout({ ...CART, objectId: 600 } as any, who, actor(who));
      expect(view.objectId).toBe(600);
      jest.restoreAllMocks();
    }
  });

  it('an object without a responsible person cannot be ordered for (400); an unknown object is 404', async () => {
    const w = world();
    await expect(w.controller.checkout({ ...CART, objectId: 601 } as any, ADMIN, actor(ADMIN))).rejects.toBeInstanceOf(BadRequestException);
    await expect(w.controller.checkout({ ...CART, objectId: 999 } as any, ADMIN, actor(ADMIN))).rejects.toMatchObject({ status: 404 });
    expect(w.prisma.catalogSubmission.create).not.toHaveBeenCalled();
  });

  it('a plain checkout (no objectId) is untouched: no CRM call, no object on the rows', async () => {
    const w = world();
    const view = await w.controller.checkout({ ...CART, projectId: 20, projectName: 'Բնակելի շենք' } as any, NOBODY, actor(NOBODY));
    expect(w.net).not.toHaveBeenCalled();
    expect(view.objectId).toBeNull();
    expect(view.object).toBeNull();
    expect(w.reservations.createForCatalog.mock.calls[0][0].object).toBeNull();
  });
});

describe('GET /catalog/submissions/object/:objectId', () => {
  const seeded = () => {
    const w = world();
    w.subs.push(
      { id: 1, number: 'REQ-1001', createdBy: RESPONSIBLE, entityId: 1, objectId: 600, projectId: 20, purpose: 'p', neededBy: new Date('2099-12-01'), createdAt: new Date(), cancelledAt: null, reminders: [] },
      { id: 2, number: 'REQ-1002', createdBy: NOBODY, entityId: 1, objectId: null, projectId: null, purpose: 'q', neededBy: new Date('2099-12-01'), createdAt: new Date(), cancelledAt: null, reminders: [] },
    );
    return w;
  };

  it('is not behind a permission guard: the service decides (responsible person without any right)', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, CatalogController.prototype.forObject)).toBeUndefined();
  });

  it('the object’s responsible person reads the object’s submissions, and only those', async () => {
    const w = seeded();
    const out = await w.controller.forObject(600, actor(RESPONSIBLE));
    expect(out.map((v) => v.number)).toEqual(['REQ-1001']);
    expect(out[0].object).toEqual({ id: 600, code: 'O-600', name: 'Արաբկիր' });
  });

  it('view_object_requests and a super admin read without CRM being asked', async () => {
    for (const who of [TAB, ADMIN]) {
      const w = seeded();
      expect((await w.controller.forObject(600, actor(who))).map((v) => v.number)).toEqual(['REQ-1001']);
      expect(w.net).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    }
  });

  it('anyone else — the general warehouse rights included — is refused (403); so is an object CRM does not know', async () => {
    const w = seeded();
    await expect(w.controller.forObject(600, actor(NOBODY))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.controller.forObject(999, actor(RESPONSIBLE))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('GET /catalog/objects — the cart’s object picker', () => {
  it('a responsible person sees their own objects; the desk and a super admin see every object', async () => {
    const w = world();
    expect((await w.controller.objects(actor(RESPONSIBLE))).map((o) => o.id)).toEqual([600]);
    expect((await w.controller.objects(actor(NOBODY))).map((o) => o.id)).toEqual([]);
    expect((await w.controller.objects(actor(DESK))).map((o) => o.id)).toEqual([600, 601, 602]);
    expect((await w.controller.objects(actor(ADMIN))).map((o) => o.id)).toEqual([600, 601, 602]);
    expect((await w.controller.objects(actor(RESPONSIBLE)))[0]).toMatchObject({ code: 'O-600', name: 'Արաբկիր', projectId: 20, projectName: 'Բնակելի շենք' });
  });

  it('is opened by the catalog right (page_warehouse / view_warehouse)', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, CatalogController.prototype.objects)).toEqual(['page_warehouse', 'view_warehouse']);
  });
});
