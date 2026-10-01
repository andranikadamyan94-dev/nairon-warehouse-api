import { HttpException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { PurchaseRequisitionsController } from './purchase-requisitions.controller';
import { CREATE_PERMISSION, PurchaseRequisitionsService } from './purchase-requisitions.service';

/**
 * The assistant's preflights for the requester's own requisition (2026-10-01,
 * coverage gaps batch 2): «Ուղարկել» a draft, «Խմբագրել», «Չեղարկել», and a
 * comment.
 *
 * Each runs the mutation's own check function, so for the requester the
 * preflight and the mutation answer alike — asked of the route handlers side
 * by side. Where they differ, on purpose, it is pinned here:
 *
 *   own only        somebody else's requisition is refused, even to a
 *                   super-admin or a procurement officer the screen lets act;
 *   literal right   a super-admin flag does not stand in for
 *                   create_purchase_requisition when sending a draft;
 *   one workspace   a requisition of another organization reads as not found.
 *
 * And none of them writes anything.
 */

const outcome = async (attempt: () => Promise<unknown> | unknown) => {
  try {
    await attempt();
    return 'ok';
  } catch (e) {
    if (e instanceof HttpException) return `${e.getStatus()} ${JSON.stringify(e.getResponse())}`;
    throw e;
  }
};

const ENTITY = 3;
const OTHER = 5;
const REQUESTER = 39;
const COLLEAGUE = 40; // holds the right too, but these are not theirs
const ADMIN = 41; // super-admin of ENTITY, no grant of their own
const BUYER = 42; // procurement officer

const R_DRAFT = 1;
const R_PENDING = 2;
const R_SUBMITTED = 3;
const R_APPROVED = 4;
const R_OTHER_ORG = 5; // the requester's draft, filed for OTHER
const MISSING = 404;

const T0 = new Date('2026-09-30T08:00:00Z');

function world(opts: { grants?: Record<number, Record<number, string[]>> } = {}) {
  const grants: Record<number, Record<number, string[]>> = opts.grants ?? {
    [REQUESTER]: { [ENTITY]: [CREATE_PERMISSION], [OTHER]: [CREATE_PERMISSION] },
    [COLLEAGUE]: { [ENTITY]: [CREATE_PERMISSION] },
    [BUYER]: { 0: ['manage_procurement'] },
  };
  const line = (id: number, over: any = {}) => ({ id, itemId: 5, itemName: 'Cement M400', code: 'CEM-400', unit: 'KG', quantity: 40, note: null, ...over });
  const base = { createdBy: REQUESTER, entityId: ENTITY, title: 'Հիմք', comment: null, periodStart: null, periodEnd: null, createdAt: T0, updatedAt: T0, taskId: null, orderId: null };
  const rows: any[] = [
    { ...base, id: R_DRAFT, status: 'DRAFT', lines: [line(11)] },
    { ...base, id: R_PENDING, status: 'PENDING_APPROVAL', periodStart: new Date('2026-10-05'), periodEnd: new Date('2026-10-20'), lines: [line(21), line(22, { itemId: null, itemName: 'Ամրան Ø12', code: null, unit: 'METER', quantity: 300 })] },
    { ...base, id: R_SUBMITTED, status: 'SUBMITTED', lines: [line(31)] },
    { ...base, id: R_APPROVED, status: 'APPROVED', lines: [line(41)] },
    { ...base, id: R_OTHER_ORG, status: 'DRAFT', entityId: OTHER, lines: [line(51)] },
  ];
  const writes: string[] = [];
  const items = [{ id: 5, name: 'Cement M400', code: 'CEM-400', unit: 'KG', quantity: 120 }];
  const prisma: any = {
    purchaseRequisition: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) return null;
        return include ? { ...r, comments: [], attachments: [], order: null } : { ...r, lines: undefined };
      }),
      update: jest.fn(async ({ where, data }: any) => (writes.push(`requisition.update ${where.id} ${data.status ?? Object.keys(data).join(',')}`), {})),
    },
    purchaseRequisitionComment: { create: jest.fn(async () => (writes.push('comment.create'), {})) },
    item: { findMany: jest.fn(async ({ where }: any) => items.filter((i) => where.id.in.includes(i.id))) },
    resourceReservation: { count: jest.fn(async () => 0) },
    procurementOrderItem: { findMany: jest.fn(async () => []) },
  };
  const usersPrisma: any = {
    getUserAccessInfo: jest.fn(async (userId: number, entityId = 0) => ({
      isSuperAdmin: userId === ADMIN && (entityId === ENTITY || entityId === 0),
      isGlobalSuperAdmin: false,
      permissionNames: grants[userId]?.[entityId] ?? [],
    })),
    getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id, firstName: 'Անուն', lastName: `${id}` }))),
  };
  const svc = new PurchaseRequisitionsService(prisma, usersPrisma, {} as any);
  const controller = new PurchaseRequisitionsController(svc, {} as any);
  return { controller, rows, writes };
}

/** What AuthGuard leaves on the request. Unguarded routes carry no permissionNames. */
const request = (userId: number, entityId: number | null = ENTITY) => ({
  user: { id: userId },
  isSuperAdmin: userId === ADMIN,
  headers: entityId ? { 'x-entity-id': String(entityId) } : {},
});

describe('the four preflights sit beside their mutations, unguarded like them', () => {
  const proto = PurchaseRequisitionsController.prototype as any;
  it.each([
    ['preflightSubmit', ':id/preflight/submit', 'submit'],
    ['preflightUpdate', ':id/preflight/update', 'update'],
    ['preflightCancel', ':id/preflight/cancel', 'cancel'],
    ['preflightComment', ':id/preflight/comment', 'addComment'],
  ])('%s at %s carries what %s carries (no guard)', (preflight, path, mutation) => {
    expect(Reflect.getMetadata(PATH_METADATA, proto[preflight])).toBe(path);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto[preflight])).toEqual(Reflect.getMetadata(PERMISSIONS_KEY, proto[mutation]));
  });
});

describe('POST :id/preflight/submit — submittable(), as PATCH :id/submit', () => {
  const same: [string, number, number][] = [
    ['the requester, a draft', REQUESTER, R_DRAFT],
    ['somebody else', COLLEAGUE, R_DRAFT],
    ['a requisition already sent', REQUESTER, R_PENDING],
    ['a requisition that does not exist', REQUESTER, MISSING],
  ];

  it.each(same)('%s: the preflight answers as the mutation does', async (_, as, id) => {
    expect(await outcome(() => world().controller.preflightSubmit(id, request(as)))).toBe(
      await outcome(() => world().controller.submit(id, request(as))),
    );
  });

  it('refuses, as submit does, a requester who lost the right in that organization', async () => {
    const grants = { [REQUESTER]: { [OTHER]: [CREATE_PERMISSION] } };
    expect(await outcome(() => world({ grants }).controller.preflightSubmit(R_DRAFT, request(REQUESTER)))).toMatch(/^403 /);
    expect(await outcome(() => world({ grants }).controller.submit(R_DRAFT, request(REQUESTER)))).toMatch(/^403 /);
  });

  it('literal: a super-admin requester without the right of their own — the screen sends it, the preflight does not', async () => {
    const grants = { [ADMIN]: {} };
    const w = world({ grants });
    w.rows.find((r) => r.id === R_DRAFT).createdBy = ADMIN;
    const v = world({ grants });
    v.rows.find((r) => r.id === R_DRAFT).createdBy = ADMIN;
    expect(await outcome(() => v.controller.submit(R_DRAFT, request(ADMIN)))).toBe('ok');
    expect(await outcome(() => w.controller.preflightSubmit(R_DRAFT, request(ADMIN)))).toMatch(/^403 /);
  });

  it('answers the transition and the requisition as the card shows it, pinned to its last change', async () => {
    const out: any = await world().controller.preflightSubmit(R_DRAFT, request(REQUESTER));
    expect(out).toMatchObject({
      ...PREFLIGHT_OK,
      from: 'DRAFT',
      to: 'PENDING_APPROVAL',
      requisition: {
        id: R_DRAFT,
        title: 'Հիմք',
        status: 'DRAFT',
        lines: [{ itemId: 5, itemName: 'Cement M400', unit: 'KG', quantity: 40 }],
        material: { requisitionId: R_DRAFT, status: 'DRAFT', createdBy: REQUESTER, entityId: ENTITY, updatedAt: T0.toISOString() },
      },
    });
  });

  it('one workspace: the requester\'s own draft for another organization reads as not found', async () => {
    expect(await outcome(() => world().controller.preflightSubmit(R_OTHER_ORG, request(REQUESTER, ENTITY)))).toMatch(/^404 /);
    expect(await outcome(() => world().controller.preflightSubmit(R_OTHER_ORG, request(REQUESTER, OTHER)))).toBe('ok');
  });
});

describe('POST :id/preflight/update — updatable(), as PATCH :id', () => {
  const same: [string, number, number, any][] = [
    ['the requester, a draft, a new title', REQUESTER, R_DRAFT, { title: 'Նոր անվանում' }],
    ['the requester, awaiting approval, new lines', REQUESTER, R_PENDING, { lines: [{ itemId: 5, quantity: 60 }] }],
    ['somebody else', COLLEAGUE, R_PENDING, { title: 'x' }],
    ['a requisition procurement already has', REQUESTER, R_SUBMITTED, { title: 'x' }],
    ['a zero quantity', REQUESTER, R_PENDING, { lines: [{ itemId: 5, quantity: 0 }] }],
    ['an item that does not exist', REQUESTER, R_PENDING, { lines: [{ itemId: 404, quantity: 1 }] }],
    ['a period that ends before the stored start', REQUESTER, R_PENDING, { periodEnd: '2026-10-01' }],
  ];

  it.each(same)('%s: the preflight answers as the mutation does', async (_, as, id, dto) => {
    expect(await outcome(() => world().controller.preflightUpdate(id, dto, request(as)))).toBe(
      await outcome(() => world().controller.update(id, dto, request(as))),
    );
  });

  it('answers before and after: unchanged fields carried over, new lines resolved by the catalogue', async () => {
    const out: any = await world().controller.preflightUpdate(R_PENDING, { comment: '  Շտապ է ', lines: [{ itemId: 5, quantity: 60 }] }, request(REQUESTER));
    expect(out.requisition).toMatchObject({ id: R_PENDING, status: 'PENDING_APPROVAL', comment: null, periodStart: '2026-10-05', lines: [{ quantity: 40 }, { itemName: 'Ամրան Ø12', quantity: 300 }] });
    expect(out.after).toEqual({
      title: 'Հիմք',
      comment: 'Շտապ է',
      periodStart: '2026-10-05',
      periodEnd: '2026-10-20',
      lines: [{ itemId: 5, itemName: 'Cement M400', code: 'CEM-400', unit: 'KG', quantity: 60, note: null }],
      linesReplaced: true,
    });
  });
});

describe('POST :id/preflight/cancel — cancellable(), as PATCH :id/cancel', () => {
  const same: [string, number, number][] = [
    ['the requester, a draft', REQUESTER, R_DRAFT],
    ['the requester, already with procurement', REQUESTER, R_SUBMITTED],
    ['the requester, already approved', REQUESTER, R_APPROVED],
    ['somebody else', COLLEAGUE, R_SUBMITTED],
    ['a requisition that does not exist', REQUESTER, MISSING],
  ];

  it.each(same)('%s: the preflight answers as the mutation does', async (_, as, id) => {
    expect(await outcome(() => world().controller.preflightCancel(id, request(as)))).toBe(
      await outcome(() => world().controller.cancel(id, request(as))),
    );
  });

  it('own only: a super-admin may withdraw somebody else\'s on the screen, not through the assistant', async () => {
    expect(await outcome(() => world().controller.cancel(R_SUBMITTED, request(ADMIN)))).toBe('ok');
    expect(await outcome(() => world().controller.preflightCancel(R_SUBMITTED, request(ADMIN)))).toMatch(/^403 /);
  });

  it('answers where it is now and that it ends CANCELLED', async () => {
    const out: any = await world().controller.preflightCancel(R_SUBMITTED, request(REQUESTER));
    expect(out).toMatchObject({ ok: true, from: 'SUBMITTED', to: 'CANCELLED', requisition: { id: R_SUBMITTED, material: { status: 'SUBMITTED' } } });
  });
});

describe('POST :id/preflight/comment — commentable(), as POST :id/comments', () => {
  it.each([
    ['the requester', REQUESTER, R_PENDING, 'Մատակարարը փոխվել է'],
    ['the requester, nothing to say', REQUESTER, R_PENDING, '   '],
    ['a requisition that does not exist', REQUESTER, MISSING, 'x'],
  ] as const)('%s: the preflight answers as the mutation does', async (_, as, id, text) => {
    expect(await outcome(() => world().controller.preflightComment(id, { text }, request(as)))).toBe(
      await outcome(() => world().controller.addComment(id, { text }, request(as))),
    );
  });

  it('own only: procurement may comment on anybody\'s on the screen, not through the assistant', async () => {
    expect(await outcome(() => world().controller.addComment(R_SUBMITTED, { text: 'x' }, request(BUYER)))).toBe('ok');
    expect(await outcome(() => world().controller.preflightComment(R_SUBMITTED, { text: 'x' }, request(BUYER)))).toMatch(/^403 /);
  });

  it('answers the text as it will be stored', async () => {
    const out: any = await world().controller.preflightComment(R_PENDING, { text: '  Մատակարարը փոխվել է ' }, request(REQUESTER));
    expect(out).toMatchObject({ ok: true, text: 'Մատակարարը փոխվել է', requisition: { id: R_PENDING } });
  });
});

describe('none of the four writes anything', () => {
  it('whatever it answers', async () => {
    const w = world();
    for (const id of [R_DRAFT, R_PENDING, R_SUBMITTED, R_APPROVED, R_OTHER_ORG, MISSING]) {
      for (const as of [REQUESTER, COLLEAGUE, ADMIN, BUYER]) {
        await outcome(() => w.controller.preflightSubmit(id, request(as)));
        await outcome(() => w.controller.preflightUpdate(id, { title: 'x', lines: [{ itemId: 5, quantity: 2 }] }, request(as)));
        await outcome(() => w.controller.preflightCancel(id, request(as)));
        await outcome(() => w.controller.preflightComment(id, { text: 'x' }, request(as)));
      }
    }
    expect(w.writes).toEqual([]);
  });

  it('and the mutations still write exactly what they wrote', async () => {
    const w = world();
    await w.controller.submit(R_DRAFT, request(REQUESTER));
    await w.controller.cancel(R_SUBMITTED, request(REQUESTER));
    await w.controller.update(R_PENDING, { title: 'Նոր' }, request(REQUESTER));
    await w.controller.addComment(R_PENDING, { text: 'x' }, request(REQUESTER));
    expect(w.writes).toEqual([
      `requisition.update ${R_DRAFT} PENDING_APPROVAL`,
      `requisition.update ${R_SUBMITTED} CANCELLED`,
      `requisition.update ${R_PENDING} title`,
      'comment.create',
    ]);
  });
});
