import { HttpException } from '@nestjs/common';

import { AssetCustodyController } from './asset-custody.controller';
import { AssetCustodyService, PERM } from './asset-custody.service';

/**
 * POST /asset-requests on somebody else's behalf (`forUserId`).
 *
 * 2026-10-03 made the person belong to the organisation the request was filed
 * in (X-Entity-ID), as HR's org tree placed them, and refused a request with
 * no organisation named. Withdrawn on 2026-10-05 — "the warehouse is global":
 * the warehouse client has no organisation picker, so the header there is a
 * stored value nobody chose, and a colleague of another organisation is as
 * real a holder as one's own. What stays:
 *
 *   right     on somebody else's behalf needs approve or issue (403);
 *   exists    a person id nobody has is a 400;
 *   active    a deactivated person is a 400 — the users database says
 *             (filterActive); nothing is asked of HR, nothing of anybody;
 *   stamp     the row carries the organisation the browser selected, if any.
 *
 * Users: 39 (request_assets only), 40, 42 (approver) and 44 (issuer) of
 * organisation 3; 77 of organisation 5; 45 is deactivated; 9999 does not exist.
 */
const ENTITY = 3;
const ME = 39; // request_assets only
const COLLEAGUE = 40;
const APPROVER = 42;
const ISSUER = 44;
const GONE = 45;
const STRANGER = 77; // of organisation 5
const ADMIN = 41; // super-admin flag, no grant of their own
const LAPTOP = 7;

const ACTIVE = [ME, COLLEAGUE, APPROVER, ISSUER, STRANGER, ADMIN];

const outcome = async (attempt: () => Promise<unknown> | unknown) => {
  try {
    await attempt();
    return 'ok';
  } catch (e) {
    if (e instanceof HttpException) return `${e.getStatus()} ${JSON.stringify(e.getResponse())}`;
    throw e;
  }
};

function world() {
  const grants: Record<number, string[]> = { [ME]: [PERM.request], [APPROVER]: [PERM.approve], [ISSUER]: [PERM.issue] };
  const writes: any[] = [];
  const prisma: any = {
    item: { findUnique: jest.fn(async ({ where }: any) => (where.id === LAPTOP ? { id: LAPTOP, name: 'Նոութբուք', type: 'ASSET' } : null)) },
    assetRequest: {
      create: jest.fn(async ({ data }: any) => {
        writes.push(data);
        return { id: 100 + writes.length, status: 'PENDING', ...data, item: { name: 'Նոութբուք' } };
      }),
    },
  };
  const usersPrisma: any = {
    getUserAccessInfo: jest.fn(async (userId: number) => ({ isSuperAdmin: userId === ADMIN, permissionNames: grants[userId] ?? [] })),
    getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id, firstName: 'Անի', lastName: `${id}` }))),
    filterActive: jest.fn(async (ids: number[]) => ids.filter((id) => ACTIVE.includes(id))),
  };
  const notifications: any = { send: jest.fn(async () => undefined), sendToUsers: jest.fn(async () => undefined) };
  const objects: any = { crmObject: jest.fn(async () => undefined) };
  const operations: any = {
    runOnce: jest.fn(async (_input: unknown, work: (tx: unknown) => Promise<unknown>) => ({ result: await work(prisma), replayed: false })),
  };
  const svc = new AssetCustodyService(prisma, usersPrisma, notifications, objects);
  const controller = new AssetCustodyController(svc, usersPrisma, operations);
  // Neither HR nor anybody else is asked: the users database is the whole check.
  const net = jest.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
    throw new Error(`nothing outside the warehouse must be asked: ${url}`);
  });
  return { controller, writes, net, filterActive: usersPrisma.filterActive as jest.Mock };
}

const request = (userId: number, entityId: number | null = ENTITY) => ({
  user: { id: userId },
  actor: { userId, declared: entityId },
  headers: entityId ? { 'x-entity-id': String(entityId) } : {},
});

describe('POST /asset-requests for somebody else — the person exists and is active; no organisation, no membership', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['an approver', APPROVER],
    ['an issuer', ISSUER],
  ])('%s files for a colleague, stamped with the selected organisation; the users database is asked, HR is not', async (_, as) => {
    const w = world();
    const row: any = await w.controller.createRequest({ itemId: LAPTOP, forUserId: COLLEAGUE } as any, request(as));
    expect(row).toMatchObject({ entityId: ENTITY, requestedBy: as, forUserId: COLLEAGUE, kind: 'PERSONAL' });
    expect(w.filterActive).toHaveBeenCalledWith([COLLEAGUE]);
    expect(w.net).not.toHaveBeenCalled();
  });

  it('E · an active colleague of another organisation, with no organisation selected, is accepted', async () => {
    const w = world();
    const row: any = await w.controller.createRequest({ itemId: LAPTOP, forUserId: STRANGER } as any, request(APPROVER, null));
    expect(row).toMatchObject({ entityId: null, requestedBy: APPROVER, forUserId: STRANGER, kind: 'PERSONAL' });
    // With one selected, the same person is accepted and the row is stamped with it — membership is not asked.
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: STRANGER } as any, request(ISSUER)))).toBe('ok');
    expect(w.writes.map((d) => [d.entityId, d.forUserId])).toEqual([
      [null, STRANGER],
      [ENTITY, STRANGER],
    ]);
    expect(w.net).not.toHaveBeenCalled();
  });

  it('E · a deactivated person is still refused, and nothing is filed', async () => {
    const w = world();
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: GONE } as any, request(APPROVER)))).toMatch(
      /^400 .*չի գտնվել կամ ապաակտիվացված է/,
    );
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: GONE } as any, request(APPROVER, null)))).toMatch(/^400 /);
    expect(w.writes).toEqual([]);
  });

  it('a person id nobody has is refused the same way', async () => {
    const w = world();
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: 9999 } as any, request(APPROVER)))).toMatch(
      /^400 .*չի գտնվել կամ ապաակտիվացված է/,
    );
    expect(w.writes).toEqual([]);
  });

  it("without approve or issue, on somebody else's behalf is refused before anybody is looked up", async () => {
    const w = world();
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: COLLEAGUE } as any, request(ME)))).toMatch(
      /^403 .*Ուրիշի համար հայտ ներկայացնելու իրավունք չկա/,
    );
    expect(w.filterActive).not.toHaveBeenCalled();
    expect(w.writes).toEqual([]);
  });

  it('a super-admin flag carries the approve / issue right for others, as before', async () => {
    const w = world();
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: STRANGER } as any, request(ADMIN, null)))).toBe('ok');
  });

  it('for oneself (named or not), with or without an organisation, as before', async () => {
    const w = world();
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP } as any, request(ME)))).toBe('ok');
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: ME } as any, request(ME)))).toBe('ok');
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: APPROVER } as any, request(APPROVER, null)))).toBe('ok');
    expect(w.writes.map((d) => d.forUserId)).toEqual([ME, ME, APPROVER]);
    expect(w.net).not.toHaveBeenCalled();
  });
});
