import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { AssetCustodyController } from './asset-custody.controller';
import { AssetCustodyService } from './asset-custody.service';
import { HolderScope } from '../common/holder-scope.service';
import { DelegatedWriteMembership } from '../auth/delegated-write.membership';

/**
 * Custody reads, org sweep follow-up (2026-10-02):
 *   GET /custody?holderUserId=   — somebody else's needs HR membership in the organisation acted in;
 *   GET /custody (whole)         — only the organisation's holders, in an organisation;
 *   GET /custody/object/:id      — a custody right or CRM opening the object; another organisation's is not found.
 * With no X-Entity-ID (the warehouse client) the register and holder reads are as before.
 *
 * HR: organisation 3 has 32 and 41; 9 has 77. CRM: object 600 is filed under 3,
 * 700 under 9, 800 under none. CRM lets person 32 open object 600.
 */
const MEMBERS: Record<number, number[]> = { 3: [32, 41], 9: [77] };
const OBJECTS: Record<number, number | null> = { 600: 3, 700: 9, 800: null };
const ROWS = [
  { id: 5, assetId: 9, holderUserId: 41, holderObjectId: null },
  { id: 6, assetId: 10, holderUserId: 77, holderObjectId: null },
  { id: 7, assetId: 11, holderUserId: null, holderObjectId: 600, originObjectId: null },
  { id: 8, assetId: 12, holderUserId: null, holderObjectId: 700, originObjectId: null },
];

const build = () => {
  const prisma: any = {
    assetCustody: {
      findMany: jest.fn(async ({ where }: any) =>
        ROWS.filter((r) => {
          if (where.OR) return where.OR.some((c: any) => c.holderObjectId === r.holderObjectId);
          if (where.holderUserId !== undefined && r.holderUserId !== where.holderUserId) return false;
          if (where.holderObjectId !== undefined && r.holderObjectId !== where.holderObjectId) return false;
          return true;
        }),
      ),
    },
  };
  const objects: any = { crmObject: jest.fn(async (id: number) => (id in OBJECTS ? { id, entityId: OBJECTS[id] } : undefined)) };
  const membership = new DelegatedWriteMembership();
  const hr = jest.fn(async (url: string) => {
    const m = /\/api\/entities\/(\d+)\/members\/internal\?userIds=([\d,]+)$/.exec(url)!;
    const asked = m[2].split(',').map(Number);
    return { ok: true, status: 200, json: async () => asked.filter((u) => (MEMBERS[Number(m[1])] ?? []).includes(u)) };
  });
  membership.fetcher = hr as never;
  const perms: Record<number, string[]> = { 32: [], 50: ['view_asset_custody'], 51: [] };
  const usersPrisma: any = {
    getUserAccessInfo: jest.fn(async (userId: number) => ({ isSuperAdmin: false, permissionNames: perms[userId] ?? [] })),
    getUsersByIds: jest.fn(async () => []),
  };
  const service = new AssetCustodyService(prisma, usersPrisma, {} as any, objects, new HolderScope(membership, objects));
  const controller = new AssetCustodyController(service, usersPrisma, {} as any);
  const crm = jest.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
    const ok = String(url) === 'http://crm.test/api/construction-objects/600' && init.headers.Authorization === 'Bearer t32';
    return { ok, status: ok ? 200 : 404 } as any;
  });
  return { controller, hr, crm, prisma };
};

/** A request as AuthGuard leaves it: the verified organisation on request.actor. */
const req = (userId: number, declared: number | null, extra: Record<string, unknown> = {}) => ({
  user: { id: userId },
  headers: { authorization: `Bearer t${userId}`, ...(declared ? { 'x-entity-id': String(declared) } : {}) },
  actor: { userId, declared, isGlobalSuperAdmin: false, ...extra },
});
const ids = (rows: any[]) => rows.map((r) => r.id).sort();

describe('custody reads — organisation scope', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INTERNAL_SECRET = 's3cret';
    process.env.HR_SERVICE_URL = 'http://hr.test';
    process.env.CRM_API_URL = 'http://crm.test';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...env };
  });

  describe('GET /custody?holderUserId=', () => {
    it("shows a member's holdings to a custody viewer acting in their organisation", async () => {
      const { controller } = build();
      expect(ids(await controller.list({ holderUserId: '41' }, req(50, 3)))).toEqual([5]);
    });

    it("is not found for somebody outside the organisation acted in — nothing read", async () => {
      const { controller, prisma } = build();
      await expect(controller.list({ holderUserId: '77' }, req(50, 3))).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.assetCustody.findMany).not.toHaveBeenCalled();
    });

    it('with no organisation sent, is as before: the right alone, HR not asked', async () => {
      const { controller, hr } = build();
      expect(ids(await controller.list({ holderUserId: '77' }, req(50, null)))).toEqual([6]);
      expect(hr).not.toHaveBeenCalled();
    });

    it('still refuses somebody with no custody right (403, as before)', async () => {
      const { controller } = build();
      await expect(controller.list({ holderUserId: '41' }, req(51, 3))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('GET /custody — the whole register', () => {
    it("holds only the organisation's holders in an organisation", async () => {
      const { controller } = build();
      expect(ids(await controller.list({}, req(50, 3)))).toEqual([5, 7]);
    });

    it('is the whole register with no organisation sent (the warehouse client)', async () => {
      const { controller, hr } = build();
      expect(ids(await controller.list({}, req(50, null)))).toEqual([5, 6, 7, 8]);
      expect(hr).not.toHaveBeenCalled();
    });

    it('is the whole register for a global super-admin', async () => {
      const { controller } = build();
      expect(ids(await controller.list({}, req(50, 3, { isGlobalSuperAdmin: true })))).toEqual([5, 6, 7, 8]);
    });
  });

  describe('GET /custody/object/:objectId (and ?holderObjectId=)', () => {
    it('shows an object of the organisation to a custody viewer, without asking CRM', async () => {
      const { controller, crm } = build();
      expect(ids(await controller.forObject(600, req(50, 3)))).toEqual([7]);
      expect(crm).not.toHaveBeenCalled();
    });

    it('shows it to somebody with no warehouse right whom CRM lets open the object (the object page)', async () => {
      const { controller, crm } = build();
      expect(ids(await controller.forObject(600, req(32, 3)))).toEqual([7]);
      expect(crm).toHaveBeenCalledWith(
        'http://crm.test/api/construction-objects/600',
        expect.objectContaining({ headers: { Authorization: 'Bearer t32', 'x-entity-id': '3' } }),
      );
    });

    it('refuses somebody with no right whom CRM does not let open it', async () => {
      const { controller } = build();
      await expect(controller.forObject(600, req(51, 3))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("is not found for another organisation's object, right or not", async () => {
      const { controller, prisma } = build();
      await expect(controller.forObject(700, req(50, 3))).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.assetCustody.findMany).not.toHaveBeenCalled();
    });

    it('does not hold an object filed under no organisation to one', async () => {
      const { controller } = build();
      await expect(controller.forObject(800, req(50, 3))).resolves.toEqual([]);
    });

    it('with no organisation sent, a custody right still opens it; no right does not (it used to be open to all)', async () => {
      const { controller } = build();
      expect(ids(await controller.forObject(700, req(50, null)))).toEqual([8]);
      await expect(controller.forObject(700, req(51, null))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('?holderObjectId= follows the same rule (it used to need nothing)', async () => {
      const { controller } = build();
      await expect(controller.list({ holderObjectId: '700' }, req(50, 3))).rejects.toBeInstanceOf(NotFoundException);
      await expect(controller.list({ holderObjectId: '600' }, req(51, 3))).rejects.toBeInstanceOf(ForbiddenException);
      expect(ids(await controller.list({ holderObjectId: '600' }, req(32, 3)))).toEqual([7]);
    });
  });

  it('GET /custody/mine is untouched: your own, no right, no organisation', async () => {
    const { controller, hr } = build();
    await expect(controller.mine(req(41, null))).resolves.toEqual([expect.objectContaining({ id: 5 })]);
    expect(hr).not.toHaveBeenCalled();
  });
});
