import { HttpException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { AssetCustodyController } from './asset-custody.controller';
import { AssetCustodyService, PERM } from './asset-custody.service';

/**
 * The assistant's preflights for one's own asset request (2026-10-01, coverage
 * gaps batch 4): «Նոր հայտ» for oneself, and «Չեղարկել» one's own request.
 *
 * Each runs the mutation's own check, so for the requester the preflight and
 * the mutation answer alike — asked of the route handlers side by side. Where
 * they differ, on purpose, it is pinned here:
 *
 *   for oneself     somebody else's or an object's request is refused;
 *   literal right   a super-admin flag does not stand in for request_assets;
 *   one workspace   an organization must be named, and a request filed in
 *                   another one reads as not found;
 *   own only        only the person who filed it withdraws it here.
 *
 * And none of them writes or notifies anything. The create mutation now files
 * at most once per Idempotency-Key and tells approvers once, after the commit.
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
const ME = 39;
const COLLEAGUE = 40;
const ADMIN = 41; // super-admin of ENTITY, no grant of their own
const APPROVER = 42;
const NO_RIGHT = 43;

const LAPTOP = 7;
const CEMENT = 8;
const T0 = new Date('2026-09-30T08:00:00Z');

function world() {
  const grants: Record<number, string[]> = {
    [ME]: [PERM.request],
    [COLLEAGUE]: [PERM.request],
    [APPROVER]: [PERM.approve],
  };
  const writes: string[] = [];
  const sent: string[] = [];
  const items = [
    { id: LAPTOP, name: 'Նոութբուք Dell', code: 'LAP-01', unit: 'PIECE', type: 'ASSET' },
    { id: CEMENT, name: 'Ցեմենտ M400', code: 'CEM-400', unit: 'KG', type: 'CONSUMABLE' },
  ];
  const base = { kind: 'PERSONAL', forObjectId: null, itemId: LAPTOP, quantity: 1, reason: 'Աշխատանքի համար', decidedBy: null, decidedAt: null, decisionNote: null, createdAt: T0, updatedAt: T0 };
  const requests: any[] = [
    { ...base, id: 1, entityId: ENTITY, requestedBy: ME, forUserId: ME, status: 'PENDING', custodies: [] },
    { ...base, id: 2, entityId: ENTITY, requestedBy: ME, forUserId: ME, status: 'APPROVED', quantity: 2, custodies: [{ id: 9, releasedAt: null }] },
    { ...base, id: 3, entityId: ENTITY, requestedBy: ME, forUserId: ME, status: 'ISSUED', custodies: [] },
    { ...base, id: 4, entityId: ENTITY, requestedBy: COLLEAGUE, forUserId: COLLEAGUE, status: 'PENDING', custodies: [] },
    { ...base, id: 5, entityId: OTHER, requestedBy: ME, forUserId: ME, status: 'PENDING', custodies: [] },
    { ...base, id: 6, entityId: null, requestedBy: ME, forUserId: ME, status: 'PENDING', custodies: [] },
  ];
  const prisma: any = {
    item: { findUnique: jest.fn(async ({ where }: any) => items.find((i) => i.id === where.id) ?? null) },
    assetRequest: {
      findUnique: jest.fn(async ({ where }: any) => {
        const r = requests.find((x) => x.id === where.id);
        return r ? { ...r, item: items.find((i) => i.id === r.itemId) } : null;
      }),
      count: jest.fn(async ({ where }: any) =>
        requests.filter((r) => r.requestedBy === where.requestedBy && r.itemId === where.itemId && where.status.in.includes(r.status)).length,
      ),
      create: jest.fn(async ({ data }: any) => {
        writes.push('assetRequest.create');
        const row = { id: 100 + writes.length, status: 'PENDING', ...data, item: items.find((i) => i.id === data.itemId) };
        requests.push({ ...row, custodies: [], createdAt: T0, updatedAt: T0 });
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        writes.push(`assetRequest.update ${where.id} ${data.status}`);
        return { id: where.id, ...data };
      }),
    },
  };
  const usersPrisma: any = {
    getUserAccessInfo: jest.fn(async (userId: number) => ({
      isSuperAdmin: userId === ADMIN,
      isGlobalSuperAdmin: false,
      permissionNames: grants[userId] ?? [],
    })),
    getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id, firstName: 'Անի', lastName: `${id}` }))),
    isDeactivated: jest.fn(async () => false),
  };
  const notifications: any = {
    send: jest.fn(async (n: any) => sent.push(`send ${n.title}`)),
    sendToUsers: jest.fn(async (_ids: number[], n: any) => sent.push(`sendToUsers ${n.title}`)),
  };
  const objects: any = { crmObject: jest.fn(async (id: number) => ({ id, code: 'OBJ', name: 'Օբյեկտ', responsibleId: COLLEAGUE })), crmObjectFresh: jest.fn(async (id: number) => ({ id, responsibleId: COLLEAGUE })) };
  // No key is sent in most cases: run the work directly (keys are pinned below).
  const keys = new Map<string, unknown>();
  const operations: any = {
    runOnce: jest.fn(async (input: { key?: string }, work: (tx: unknown) => Promise<unknown>) => {
      if (input.key && keys.has(input.key)) return { result: keys.get(input.key), replayed: true };
      const result = await work(prisma);
      if (input.key) keys.set(input.key, result);
      return { result, replayed: false };
    }),
  };
  // HR's org tree: everybody here belongs to ENTITY (membership itself: asset-request-for-someone.spec.ts).
  const holders: any = { isMember: jest.fn(async (entityId: number) => entityId === ENTITY) };
  const svc = new AssetCustodyService(prisma, usersPrisma, notifications, objects, holders);
  const controller = new AssetCustodyController(svc, usersPrisma, operations);
  return { controller, requests, writes, sent, operations };
}

const request = (userId: number, entityId: number | null = ENTITY) => ({
  user: { id: userId },
  actor: { userId, declared: entityId },
  headers: entityId ? { 'x-entity-id': String(entityId) } : {},
});
const flush = () => new Promise((r) => setImmediate(r));

describe('the two preflights sit beside their mutations, behind the same guard', () => {
  const proto = AssetCustodyController.prototype as any;
  it.each([
    ['preflightCreateRequest', 'asset-requests/preflight/create', 'createRequest'],
    ['preflightCancelRequest', 'asset-requests/:id/preflight/cancel', 'cancel'],
  ])('%s at %s carries what %s carries', (preflight, path, mutation) => {
    expect(Reflect.getMetadata(PATH_METADATA, proto[preflight])).toBe(path);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto[preflight])).toEqual(Reflect.getMetadata(PERMISSIONS_KEY, proto[mutation]));
  });
});

describe('POST /asset-requests/preflight/create — assertMayRequest(), as POST /asset-requests', () => {
  it.each([
    ['an asset, for oneself', ME, { itemId: LAPTOP, quantity: 1 }],
    ['a consumable is not an asset', ME, { itemId: CEMENT }],
    ['an item that does not exist', ME, { itemId: 404 }],
  ])('%s: the preflight answers as the mutation does', async (_, as, dto) => {
    expect(await outcome(() => world().controller.preflightCreateRequest(dto as any, request(as)))).toBe(
      await outcome(() => world().controller.createRequest(dto as any, request(as))),
    );
  });

  it('answers the request as the card shows it, and writes and notifies nothing', async () => {
    const w = world();
    const answer = await w.controller.preflightCreateRequest({ itemId: LAPTOP, quantity: 2, reason: '  Նոր աշխատակից  ' } as any, request(ME));
    expect(answer).toMatchObject(PREFLIGHT_OK);
    expect(answer.request).toEqual({
      kind: 'PERSONAL',
      item: { id: LAPTOP, name: 'Նոութբուք Dell', code: 'LAP-01', unit: 'PIECE' },
      quantity: 2,
      reason: 'Նոր աշխատակից',
      forUser: { id: ME, name: `Անի ${ME}` },
      entityId: ENTITY,
      openForSameItem: 4, // #1, #2, #5, #6 — the person's open requests for the same laptop
    });
    await flush();
    expect(w.writes).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it('for oneself only: on somebody else\'s behalf, or for an object, stays on the screen', async () => {
    const w = world();
    expect(await outcome(() => w.controller.preflightCreateRequest({ itemId: LAPTOP, forUserId: COLLEAGUE } as any, request(APPROVER)))).toMatch(/^400 /);
    expect(await outcome(() => w.controller.preflightCreateRequest({ itemId: LAPTOP, forObjectId: 12 } as any, request(ME)))).toMatch(/^400 /);
    // The screen does both for an approver.
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: COLLEAGUE } as any, request(APPROVER)))).toBe('ok');
    // Naming oneself is the same as naming nobody.
    expect(await outcome(() => w.controller.preflightCreateRequest({ itemId: LAPTOP, forUserId: ME } as any, request(ME)))).toBe('ok');
  });

  it('literal: a super-admin without request_assets of their own is refused (the screen files it)', async () => {
    const w = world();
    expect(await outcome(() => w.controller.preflightCreateRequest({ itemId: LAPTOP } as any, request(ADMIN)))).toMatch(/^403 /);
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP } as any, request(ADMIN)))).toBe('ok');
    expect(await outcome(() => w.controller.preflightCreateRequest({ itemId: LAPTOP } as any, request(NO_RIGHT)))).toMatch(/^403 /);
  });

  it('one workspace: with no organization named there is no card', async () => {
    expect(await outcome(() => world().controller.preflightCreateRequest({ itemId: LAPTOP } as any, request(ME, null)))).toMatch(/^400 /);
  });
});

describe('POST /asset-requests — one request per Idempotency-Key, approvers told once after it committed', () => {
  it('files in the organization named, and tells approvers', async () => {
    const w = world();
    const row: any = await w.controller.createRequest({ itemId: LAPTOP } as any, request(ME));
    await flush();
    expect(row).toMatchObject({ entityId: ENTITY, requestedBy: ME, forUserId: ME, kind: 'PERSONAL', status: 'PENDING' });
    expect(w.writes).toEqual(['assetRequest.create']);
    expect(w.sent).toEqual(['send Նոր գույքի հայտ']);
  });

  it('the same key twice is one request and one notification', async () => {
    const w = world();
    const first: any = await w.controller.createRequest({ itemId: LAPTOP } as any, request(ME), 'op-1');
    const again: any = await w.controller.createRequest({ itemId: LAPTOP } as any, request(ME), 'op-1');
    await flush();
    expect(again.id).toBe(first.id);
    expect(w.writes).toEqual(['assetRequest.create']);
    expect(w.sent).toEqual(['send Նոր գույքի հայտ']);
    expect(w.operations.runOnce).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'op-1', route: 'POST /asset-requests' }),
      expect.any(Function),
    );
  });

  it('the object route keeps filing and announcing as before', async () => {
    const w = world();
    await w.controller.createObjectRequest(12, { itemId: LAPTOP } as any, request(COLLEAGUE));
    await flush();
    expect(w.writes).toEqual(['assetRequest.create']);
    expect(w.sent).toEqual(['send Նոր գույքի հայտ']);
  });
});

describe('POST /asset-requests/:id/preflight/cancel — cancellable(), as PATCH /asset-requests/:id/cancel', () => {
  it.each([
    ['one\'s own, waiting', ME, 1],
    ['one\'s own, approved', ME, 2],
    ['one\'s own, already issued', ME, 3],
    ['one that does not exist', ME, 404],
  ])('%s: the preflight answers as the mutation does', async (_, as, id) => {
    expect(await outcome(() => world().controller.preflightCancelRequest(id, request(as)))).toBe(
      await outcome(() => world().controller.cancel(id, request(as))),
    );
  });

  it('answers from → to, what is already handed out, and the material pin; writes nothing', async () => {
    const w = world();
    const answer = await w.controller.preflightCancelRequest(2, request(ME));
    expect(answer).toMatchObject({ ...PREFLIGHT_OK, from: 'APPROVED', to: 'CANCELLED' });
    expect(answer.request).toEqual({
      id: 2,
      item: { id: LAPTOP, name: 'Նոութբուք Dell', unit: 'PIECE' },
      quantity: 2,
      reason: 'Աշխատանքի համար',
      status: 'APPROVED',
      forUser: { id: ME, name: `Անի ${ME}` },
      issuedOpen: 1,
      createdAt: T0.toISOString(),
      material: { requestId: 2, status: 'APPROVED', requestedBy: ME, entityId: ENTITY, updatedAt: T0.toISOString() },
    });
    expect(w.writes).toEqual([]);
  });

  it('somebody else\'s: refused like the mutation refuses it, with the rule said', async () => {
    expect(await outcome(() => world().controller.cancel(4, request(ME)))).toMatch(/^403 /);
    expect(await outcome(() => world().controller.preflightCancelRequest(4, request(ME)))).toMatch(/^403 .*Ձեր ներկայացրած հայտը/);
  });

  it('own only: a super-admin withdrawing somebody else\'s stays on the screen', async () => {
    expect(await outcome(() => world().controller.preflightCancelRequest(1, request(ADMIN)))).toMatch(/^403 /);
    expect(await outcome(() => world().controller.cancel(1, request(ADMIN)))).toBe('ok');
  });

  it('one workspace: a request filed in another organization reads as not found; one with none is the person\'s own', async () => {
    expect(await outcome(() => world().controller.preflightCancelRequest(5, request(ME)))).toMatch(/^404 /);
    expect(await outcome(() => world().controller.preflightCancelRequest(5, request(ME, OTHER)))).toBe('ok');
    expect(await outcome(() => world().controller.preflightCancelRequest(6, request(ME)))).toBe('ok');
  });

  it('a yes grants nothing: decided in between, the mutation refuses', async () => {
    const w = world();
    expect(await outcome(() => w.controller.preflightCancelRequest(1, request(ME)))).toBe('ok');
    w.requests.find((r) => r.id === 1).status = 'REJECTED';
    expect(await outcome(() => w.controller.cancel(1, request(ME)))).toMatch(/^400 /);
  });
});
