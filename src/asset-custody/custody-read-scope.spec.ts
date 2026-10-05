import { ForbiddenException } from '@nestjs/common';

import { AssetCustodyController } from './asset-custody.controller';
import { AssetCustodyService } from './asset-custody.service';

/**
 * Custody reads are not held to the organisation acted in — the warehouse is
 * global (owner decision 2026-10-05, undoing the 2026-10-02 scoping):
 *   GET /custody?holderUserId=   — a custody right shows anybody's; HR is never asked;
 *   GET /custody (whole)         — every organisation's holders; neither HR nor CRM's catalogue is asked.
 *
 * An object's reads are the CRM object page's tabs (owner, later 2026-10-05,
 * objects/object-page-rights.ts) and follow the tab's own rule:
 *   GET /custody/object/:id, GET /custody?holderObjectId=   — view_object_assets, the object's responsible
 *                                                              person (CRM's internal card), or a super admin;
 *   GET /asset-requests?forObjectId=                         — view_object_requests, the responsible person,
 *                                                              or a super admin.
 * The custody rights no longer open them; the general warehouse rights never did.
 *
 * Person 41 belongs to organisation 3 and 77 to 9; CRM files object 600 under
 * 3 and 700 under 9 — facts this register no longer asks about. CRM's card
 * names 32 as the responsible person of object 600 and 41 of 700.
 */
const ROWS = [
  { id: 5, assetId: 9, holderUserId: 41, holderObjectId: null },
  { id: 6, assetId: 10, holderUserId: 77, holderObjectId: null },
  { id: 7, assetId: 11, holderUserId: null, holderObjectId: 600, originObjectId: null },
  { id: 8, assetId: 12, holderUserId: null, holderObjectId: 700, originObjectId: null },
];

const REQUESTS = [
  { id: 1, requestedBy: 32, forUserId: null, forObjectId: 600, status: 'PENDING' },
  { id: 2, requestedBy: 44, forUserId: null, forObjectId: 600, status: 'APPROVED' },
  { id: 3, requestedBy: 41, forUserId: null, forObjectId: 700, status: 'PENDING' },
  { id: 4, requestedBy: 51, forUserId: 51, forObjectId: null, status: 'PENDING' },
];

const RESPONSIBLE: Record<number, number> = { 600: 32, 700: 41 };

const RESPONSIBLE_OF_600 = 32; // no warehouse right at all
const CUSTODY_VIEWER = 50; // view_asset_custody — the register, not the object page
const NOBODY = 51;
const ASSETS_TAB = 60; // view_object_assets
const REQUESTS_TAB = 61; // view_object_requests
const KEEPER = 62; // the general warehouse rights, no object right
const ADMIN = 99; // super-admin flag, no grant of their own

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
    assetRequest: {
      findMany: jest.fn(async ({ where }: any) =>
        REQUESTS.filter((r) => {
          if (where.forObjectId !== undefined) return r.forObjectId === where.forObjectId;
          if (where.OR) return where.OR.some((c: any) => (c.requestedBy !== undefined && r.requestedBy === c.requestedBy) || (c.forUserId !== undefined && r.forUserId === c.forUserId));
          return true;
        }),
      ),
    },
  };
  // CRM's object catalogue: any call from these reads is a regression. The
  // responsible person comes from CRM's internal card, through ObjectsService.card.
  const objects: any = {
    crmObject: jest.fn(async () => {
      throw new Error('CRM catalogue must not be asked');
    }),
    crmObjectFresh: jest.fn(async () => {
      throw new Error('CRM catalogue must not be asked');
    }),
    card: jest.fn(async (objectId: number) => {
      if (!RESPONSIBLE[objectId]) throw new Error('Օբյեկտը չի գտնվել');
      return { id: objectId, code: `O-${objectId}`, name: 'object', projectId: null, projectName: null, entityId: null, responsibleId: RESPONSIBLE[objectId] };
    }),
  };
  const perms: Record<number, string[]> = {
    [RESPONSIBLE_OF_600]: [],
    [CUSTODY_VIEWER]: ['view_asset_custody'],
    [NOBODY]: [],
    [ASSETS_TAB]: ['view_object_assets'],
    [REQUESTS_TAB]: ['view_object_requests'],
    [KEEPER]: ['view_resources', 'manage_inventory', 'manage_reservations', 'manage_warehouses', 'manage_warehouse'],
    [ADMIN]: [],
  };
  const usersPrisma: any = {
    getUserAccessInfo: jest.fn(async (userId: number) => ({ isSuperAdmin: userId === ADMIN, permissionNames: perms[userId] ?? [] })),
    getUsersByIds: jest.fn(async () => []),
  };
  const service = new AssetCustodyService(prisma, usersPrisma, {} as any, objects);
  const controller = new AssetCustodyController(service, usersPrisma, {} as any);
  // Nothing here goes over the network any more: not HR, not CRM with the caller's token.
  const net = jest.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
    throw new Error(`unexpected network call: ${String(url)}`);
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
      expect(ids(await controller.list({ holderUserId: '77' }, req(CUSTODY_VIEWER, 3)))).toEqual([6]);
      expect(net).not.toHaveBeenCalled();
    });

    it('shows a member of the organisation acted in just the same', async () => {
      const { controller, net } = build();
      expect(ids(await controller.list({ holderUserId: '41' }, req(CUSTODY_VIEWER, 3)))).toEqual([5]);
      expect(ids(await controller.list({ holderUserId: '41' }, req(CUSTODY_VIEWER, null)))).toEqual([5]);
      expect(net).not.toHaveBeenCalled();
    });

    it('still refuses somebody with no custody right (403), nothing read', async () => {
      const { controller, prisma } = build();
      await expect(controller.list({ holderUserId: '41' }, req(NOBODY, 3))).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.assetCustody.findMany).not.toHaveBeenCalled();
    });

    it("an object right is not a custody right: it opens nobody's part of the register", async () => {
      const { controller } = build();
      await expect(controller.list({ holderUserId: '41' }, req(ASSETS_TAB, 3))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('GET /custody — the whole register', () => {
    it("holds every organisation's holders in an organisation, without asking HR or CRM", async () => {
      const { controller, net, objects } = build();
      expect(ids(await controller.list({}, req(CUSTODY_VIEWER, 3)))).toEqual([5, 6, 7, 8]);
      expect(net).not.toHaveBeenCalled();
      expect(objects.crmObject).not.toHaveBeenCalled();
      expect(objects.card).not.toHaveBeenCalled();
    });

    it('and with no organisation sent (the warehouse client)', async () => {
      const { controller, net } = build();
      expect(ids(await controller.list({}, req(CUSTODY_VIEWER, null)))).toEqual([5, 6, 7, 8]);
      expect(net).not.toHaveBeenCalled();
    });

    it('still needs a custody right — an object right or the general warehouse rights are not one', async () => {
      const { controller } = build();
      await expect(controller.list({}, req(NOBODY, 3))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.list({}, req(ASSETS_TAB, 3))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.list({}, req(KEEPER, 3))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('GET /custody/object/:objectId (and ?holderObjectId=) — the object page\'s «Գույք» tab', () => {
    it('200 for view_object_assets, any object, without asking CRM', async () => {
      const { controller, net, objects } = build();
      expect(ids(await controller.forObject(600, req(ASSETS_TAB, 3)))).toEqual([7]);
      expect(ids(await controller.forObject(700, req(ASSETS_TAB, null)))).toEqual([8]);
      expect(net).not.toHaveBeenCalled();
      expect(objects.card).not.toHaveBeenCalled();
      expect(objects.crmObject).not.toHaveBeenCalled();
    });

    it('200 for a super admin with no grant of their own', async () => {
      const { controller, objects } = build();
      expect(ids(await controller.forObject(600, req(ADMIN, 3)))).toEqual([7]);
      expect(objects.card).not.toHaveBeenCalled();
    });

    it("200 for the object's responsible person (CRM's internal card), with no warehouse right at all", async () => {
      const { controller, net, objects } = build();
      expect(ids(await controller.forObject(600, req(RESPONSIBLE_OF_600, 3)))).toEqual([7]);
      expect(ids(await controller.forObject(600, req(RESPONSIBLE_OF_600, null)))).toEqual([7]);
      expect(objects.card).toHaveBeenCalledWith(600);
      // The card, not the caller's token against CRM's own GET.
      expect(net).not.toHaveBeenCalled();
    });

    it("403 for the responsible person of ANOTHER object, and for an object CRM does not know", async () => {
      const { controller } = build();
      await expect(controller.forObject(700, req(RESPONSIBLE_OF_600, 3))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.forObject(999, req(RESPONSIBLE_OF_600, 3))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403 for a custody viewer: the custody rights no longer open an object\'s reads', async () => {
      const { controller, prisma } = build();
      await expect(controller.forObject(600, req(CUSTODY_VIEWER, 3))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.forObject(700, req(CUSTODY_VIEWER, null))).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.assetCustody.findMany).not.toHaveBeenCalled();
    });

    it('403 for a warehouse keeper (the general rights, even manage_warehouse) and for nobody', async () => {
      const { controller } = build();
      await expect(controller.forObject(600, req(KEEPER, 3))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.forObject(600, req(NOBODY, 3))).rejects.toBeInstanceOf(ForbiddenException);
      // The other tab's right opens nothing here.
      await expect(controller.forObject(600, req(REQUESTS_TAB, 3))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('?holderObjectId= follows the same rule', async () => {
      const { controller, objects } = build();
      expect(ids(await controller.list({ holderObjectId: '700' }, req(ASSETS_TAB, 3)))).toEqual([8]);
      expect(ids(await controller.list({ holderObjectId: '600' }, req(RESPONSIBLE_OF_600, 3)))).toEqual([7]);
      expect(ids(await controller.list({ holderObjectId: '600' }, req(ADMIN, null)))).toEqual([7]);
      await expect(controller.list({ holderObjectId: '600' }, req(NOBODY, 3))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.list({ holderObjectId: '600' }, req(CUSTODY_VIEWER, 3))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.list({ holderObjectId: '700' }, req(RESPONSIBLE_OF_600, 3))).rejects.toBeInstanceOf(ForbiddenException);
      expect(objects.crmObject).not.toHaveBeenCalled();
    });
  });

  describe('GET /asset-requests?forObjectId= — the object page\'s «Պահեստային հայտեր» tab', () => {
    it('200 for view_object_requests, without asking CRM', async () => {
      const { controller, objects } = build();
      expect(ids(await controller.listRequests({ forObjectId: '600' }, req(REQUESTS_TAB, 3)))).toEqual([1, 2]);
      expect(objects.card).not.toHaveBeenCalled();
    });

    it('200 for a super admin', async () => {
      const { controller } = build();
      expect(ids(await controller.listRequests({ forObjectId: '700' }, req(ADMIN, 3)))).toEqual([3]);
    });

    it("200 for the object's responsible person — every request of the object, not only their own", async () => {
      const { controller, objects } = build();
      expect(ids(await controller.listRequests({ forObjectId: '600' }, req(RESPONSIBLE_OF_600, 3)))).toEqual([1, 2]);
      expect(objects.card).toHaveBeenCalledWith(600);
      await expect(controller.listRequests({ forObjectId: '700' }, req(RESPONSIBLE_OF_600, 3))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403 for a custody viewer, a keeper, the other tab\'s right, and nobody', async () => {
      const { controller, prisma } = build();
      for (const who of [CUSTODY_VIEWER, KEEPER, ASSETS_TAB, NOBODY]) {
        await expect(controller.listRequests({ forObjectId: '600' }, req(who, 3))).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(prisma.assetRequest.findMany).not.toHaveBeenCalled();
    });

    it('the general queue (no object filter) is as it was: a custody viewer sees it, the object right does not', async () => {
      const { controller, objects } = build();
      expect(ids(await controller.listRequests({}, req(CUSTODY_VIEWER, 3)))).toEqual([1, 2, 3, 4]);
      // Without a custody right the list is one's own.
      expect(ids(await controller.listRequests({}, req(REQUESTS_TAB, 3)))).toEqual([]);
      expect(ids(await controller.listRequests({}, req(NOBODY, 3)))).toEqual([4]);
      expect(objects.card).not.toHaveBeenCalled();
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
