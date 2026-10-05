import { ForbiddenException } from '@nestjs/common';

import { AssetCustodyController } from './asset-custody.controller';
import { AssetCustodyService } from './asset-custody.service';

/**
 * Custody reads are not held to the organisation acted in — the warehouse is
 * global (owner decision 2026-10-05, undoing the 2026-10-02 scoping):
 *   GET /custody?holderUserId=   — a custody right shows anybody's; HR is never asked;
 *   GET /custody (whole)         — every organisation's holders; neither HR nor CRM's catalogue is asked;
 *   GET /custody/object/:id      — a custody right opens any object; without one, CRM letting the person open it.
 *
 * Person 41 belongs to organisation 3 and 77 to 9; CRM files object 600 under
 * 3 and 700 under 9 — facts this register no longer asks about. CRM lets
 * person 32 open object 600.
 */
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
  // CRM's object catalogue: any call from these reads is a regression.
  const objects: any = {
    crmObject: jest.fn(async () => {
      throw new Error('CRM catalogue must not be asked');
    }),
  };
  const perms: Record<number, string[]> = { 32: [], 50: ['view_asset_custody'], 51: [] };
  const usersPrisma: any = {
    getUserAccessInfo: jest.fn(async (userId: number) => ({ isSuperAdmin: false, permissionNames: perms[userId] ?? [] })),
    getUsersByIds: jest.fn(async () => []),
  };
  const service = new AssetCustodyService(prisma, usersPrisma, {} as any, objects, {} as any);
  const controller = new AssetCustodyController(service, usersPrisma, {} as any);
  const net = jest.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
    // HR's org tree is never asked here any more; CRM's own object GET is the one call left.
    if (String(url).includes('/members/internal')) throw new Error('HR must not be asked');
    const ok = String(url) === 'http://crm.test/api/construction-objects/600' && init?.headers?.Authorization === 'Bearer t32';
    return { ok, status: ok ? 200 : 404 } as any;
  });
  return { controller, net, objects, prisma };
};

/** A request as AuthGuard leaves it: the verified organisation on request.actor. */
const req = (userId: number, declared: number | null) => ({
  user: { id: userId },
  headers: { authorization: `Bearer t${userId}`, ...(declared ? { 'x-entity-id': String(declared) } : {}) },
  actor: { userId, declared, isGlobalSuperAdmin: false },
});
const ids = (rows: any[]) => rows.map((r) => r.id).sort();

describe('custody reads — the warehouse is global', () => {
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
    it("shows another organisation's person to a custody viewer acting in organisation 3, without asking HR", async () => {
      const { controller, net } = build();
      expect(ids(await controller.list({ holderUserId: '77' }, req(50, 3)))).toEqual([6]);
      expect(net).not.toHaveBeenCalled();
    });

    it('shows a member of the organisation acted in just the same', async () => {
      const { controller, net } = build();
      expect(ids(await controller.list({ holderUserId: '41' }, req(50, 3)))).toEqual([5]);
      expect(ids(await controller.list({ holderUserId: '41' }, req(50, null)))).toEqual([5]);
      expect(net).not.toHaveBeenCalled();
    });

    it('still refuses somebody with no custody right (403), nothing read', async () => {
      const { controller, prisma } = build();
      await expect(controller.list({ holderUserId: '41' }, req(51, 3))).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.assetCustody.findMany).not.toHaveBeenCalled();
    });
  });

  describe('GET /custody — the whole register', () => {
    it("holds every organisation's holders in an organisation, without asking HR or CRM", async () => {
      const { controller, net, objects } = build();
      expect(ids(await controller.list({}, req(50, 3)))).toEqual([5, 6, 7, 8]);
      expect(net).not.toHaveBeenCalled();
      expect(objects.crmObject).not.toHaveBeenCalled();
    });

    it('and with no organisation sent (the warehouse client)', async () => {
      const { controller, net } = build();
      expect(ids(await controller.list({}, req(50, null)))).toEqual([5, 6, 7, 8]);
      expect(net).not.toHaveBeenCalled();
    });

    it('still needs a custody right', async () => {
      const { controller } = build();
      await expect(controller.list({}, req(51, 3))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('GET /custody/object/:objectId (and ?holderObjectId=)', () => {
    it("answers 200 for another organisation's object to a custody viewer, without asking CRM", async () => {
      const { controller, net, objects } = build();
      expect(ids(await controller.forObject(700, req(50, 3)))).toEqual([8]);
      expect(net).not.toHaveBeenCalled();
      expect(objects.crmObject).not.toHaveBeenCalled();
    });

    it('shows it to somebody with no warehouse right whom CRM lets open the object (the object page)', async () => {
      const { controller, net } = build();
      expect(ids(await controller.forObject(600, req(32, 3)))).toEqual([7]);
      expect(net).toHaveBeenCalledWith(
        'http://crm.test/api/construction-objects/600',
        expect.objectContaining({ headers: { Authorization: 'Bearer t32', 'x-entity-id': '3' } }),
      );
    });

    it('refuses somebody with no right whom CRM does not let open it', async () => {
      const { controller } = build();
      await expect(controller.forObject(600, req(51, 3))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('with no organisation sent, a custody right opens any object; no right does not', async () => {
      const { controller } = build();
      expect(ids(await controller.forObject(700, req(50, null)))).toEqual([8]);
      await expect(controller.forObject(700, req(51, null))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('?holderObjectId= follows the same rule', async () => {
      const { controller, objects } = build();
      expect(ids(await controller.list({ holderObjectId: '700' }, req(50, 3)))).toEqual([8]);
      await expect(controller.list({ holderObjectId: '600' }, req(51, 3))).rejects.toBeInstanceOf(ForbiddenException);
      expect(ids(await controller.list({ holderObjectId: '600' }, req(32, 3)))).toEqual([7]);
      expect(objects.crmObject).not.toHaveBeenCalled();
    });
  });

  it('GET /custody/mine is untouched: your own, no right, no organisation', async () => {
    const { controller, net } = build();
    await expect(controller.mine(req(41, null))).resolves.toEqual([expect.objectContaining({ id: 5 })]);
    expect(net).not.toHaveBeenCalled();
  });

  it('the holder-scope helper of 2026-10-02 is gone with the filtering', () => {
    expect(() => jest.requireActual('../common/holder-scope.service')).toThrow(/Cannot find module/);
  });
});
