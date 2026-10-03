import { HttpException } from '@nestjs/common';

import { AssetCustodyController } from './asset-custody.controller';
import { AssetCustodyService, PERM } from './asset-custody.service';
import { HolderScope } from '../common/holder-scope.service';
import { DelegatedWriteMembership } from '../auth/delegated-write.membership';

/**
 * POST /asset-requests on somebody else's behalf (`forUserId`), 2026-10-03.
 *
 * Before, an approver or issuer could file a request for any person id at all,
 * in any organisation. Now the person must belong to the organisation the
 * request is filed in (X-Entity-ID), as HR's org tree places them
 * (members/internal — the custody reads' rule), and be active:
 *
 *   right           on somebody else's behalf needs approve or issue (403);
 *   one workspace   no organisation named is a 400;
 *   member          a person HR does not place in it is a 400;
 *   active          a deactivated person is a 400, as before;
 *   HR down         a 503, never assumed either way.
 *
 * Asking for oneself does not ask HR (AuthGuard already checked the
 * organisation against the person's own).
 *
 * HR: organisation 3 has 39, 40, 42, 44 and 45; 5 has 77. 45 is deactivated.
 */
const ENTITY = 3;
const OTHER = 5;
const ME = 39; // request_assets only
const COLLEAGUE = 40;
const APPROVER = 42;
const ISSUER = 44;
const GONE = 45;
const STRANGER = 77; // a member of OTHER only
const ADMIN = 41; // super-admin flag, no grant of their own
const LAPTOP = 7;

const MEMBERS: Record<number, number[]> = { [ENTITY]: [ME, COLLEAGUE, APPROVER, ISSUER, GONE, ADMIN], [OTHER]: [STRANGER] };

const outcome = async (attempt: () => Promise<unknown> | unknown) => {
  try {
    await attempt();
    return 'ok';
  } catch (e) {
    if (e instanceof HttpException) return `${e.getStatus()} ${JSON.stringify(e.getResponse())}`;
    throw e;
  }
};

function world(opts: { hrDown?: boolean } = {}) {
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
    isDeactivated: jest.fn(async (userId: number) => userId === GONE),
  };
  const notifications: any = { send: jest.fn(async () => undefined), sendToUsers: jest.fn(async () => undefined) };
  const objects: any = { crmObject: jest.fn(async () => undefined) };
  const membership = new DelegatedWriteMembership();
  const hr = jest.fn(async (url: string) => {
    if (opts.hrDown) throw new Error('ECONNREFUSED');
    const m = /^http:\/\/hr\.test\/api\/entities\/(\d+)\/members\/internal\?userIds=([\d,]+)$/.exec(url)!;
    const asked = m[2].split(',').map(Number);
    return { ok: true, status: 200, json: async () => asked.filter((u) => (MEMBERS[Number(m[1])] ?? []).includes(u)) };
  });
  membership.fetcher = hr as never;
  const operations: any = {
    runOnce: jest.fn(async (_input: unknown, work: (tx: unknown) => Promise<unknown>) => ({ result: await work(prisma), replayed: false })),
  };
  const svc = new AssetCustodyService(prisma, usersPrisma, notifications, objects, new HolderScope(membership, objects));
  const controller = new AssetCustodyController(svc, usersPrisma, operations);
  return { controller, writes, hr };
}

const request = (userId: number, entityId: number | null = ENTITY) => ({
  user: { id: userId },
  actor: { userId, declared: entityId },
  headers: entityId ? { 'x-entity-id': String(entityId) } : {},
});

describe('POST /asset-requests for somebody else — the person must belong to the organisation', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INTERNAL_SECRET = 's3cret';
    process.env.HR_SERVICE_URL = 'http://hr.test';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it.each([
    ['an approver', APPROVER],
    ['an issuer', ISSUER],
  ])('%s files for a colleague of the organisation, which HR is asked about', async (_, as) => {
    const w = world();
    const row: any = await w.controller.createRequest({ itemId: LAPTOP, forUserId: COLLEAGUE } as any, request(as));
    expect(row).toMatchObject({ entityId: ENTITY, requestedBy: as, forUserId: COLLEAGUE, kind: 'PERSONAL' });
    expect(w.hr).toHaveBeenCalledTimes(1);
    expect(w.hr.mock.calls[0][0]).toBe(`http://hr.test/api/entities/${ENTITY}/members/internal?userIds=${COLLEAGUE}`);
    expect((w.hr.mock.calls[0] as any)[1].headers['x-internal-secret']).toBe('s3cret');
  });

  it('a person of another organisation is refused, and nothing is filed', async () => {
    const w = world();
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: STRANGER } as any, request(APPROVER)))).toBe(
      '400 {"message":"Աշխատակիցը չի պատկանում ընտրված կազմակերպությանը","error":"Bad Request","statusCode":400}',
    );
    // Nor does a super-admin flag stand in for membership.
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: STRANGER } as any, request(ADMIN)))).toMatch(/^400 .*չի պատկանում/);
    // Named in their own organisation, the same person is fine.
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: STRANGER } as any, request(APPROVER, OTHER)))).toBe('ok');
    expect(w.writes.map((d) => [d.entityId, d.forUserId])).toEqual([[OTHER, STRANGER]]);
  });

  it('a person id nobody has is refused the same way', async () => {
    const w = world();
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: 9999 } as any, request(APPROVER)))).toMatch(/^400 .*չի պատկանում/);
    expect(w.writes).toEqual([]);
  });

  it('a deactivated member is refused', async () => {
    const w = world();
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: GONE } as any, request(APPROVER)))).toMatch(
      /^400 .*Աշխատակիցն ապաակտիվացված է/,
    );
    expect(w.writes).toEqual([]);
  });

  it('without approve or issue, on somebody else\'s behalf is refused before HR is asked', async () => {
    const w = world();
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: COLLEAGUE } as any, request(ME)))).toMatch(
      /^403 .*Ուրիշի համար հայտ ներկայացնելու իրավունք չկա/,
    );
    expect(w.hr).not.toHaveBeenCalled();
    expect(w.writes).toEqual([]);
  });

  it('with no organisation named there is nobody to check against: refused', async () => {
    const w = world();
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: COLLEAGUE } as any, request(APPROVER, null)))).toMatch(
      /^400 .*ընտրեք կազմակերպությունը/,
    );
    expect(w.hr).not.toHaveBeenCalled();
    expect(w.writes).toEqual([]);
  });

  it('HR unreachable is a 503 — never assumed', async () => {
    const w = world({ hrDown: true });
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: COLLEAGUE } as any, request(APPROVER)))).toMatch(/^503 /);
    expect(w.writes).toEqual([]);
  });

  it('for oneself (named or not) HR is not asked, as before', async () => {
    const w = world();
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP } as any, request(ME)))).toBe('ok');
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: ME } as any, request(ME)))).toBe('ok');
    expect(await outcome(() => w.controller.createRequest({ itemId: LAPTOP, forUserId: APPROVER } as any, request(APPROVER, null)))).toBe('ok');
    expect(w.hr).not.toHaveBeenCalled();
    expect(w.writes.map((d) => d.forUserId)).toEqual([ME, ME, APPROVER]);
  });
});
