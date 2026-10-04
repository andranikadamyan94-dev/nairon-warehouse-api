import { ForbiddenException } from '@nestjs/common';

import { ResponsibilitiesController } from './responsibilities.controller';
import { ResponsibilitiesService } from './responsibilities.service';
import { decideHoldingsRead } from './holdings-access';
import { WarehouseActor } from '../auth/actor';
import { AssetCustodyController } from '../asset-custody/asset-custody.controller';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

/**
 * GET /responsibilities/user/:userId and GET /responsibilities. The warehouse
 * is global (owner decision 2026-10-05): your own holdings are always yours
 * to read, somebody else's need a responsibility / custody right, and that is
 * all — no organisation has to be declared, the person is not looked up in
 * HR's org tree, and the register is never narrowed to an organisation.
 *
 * Person 41 belongs to organisation 3 and 77 to 9 (per HR, which is not
 * asked). Objects 600 (filed under 3), 700 (under 9) and 800 (under none)
 * hold assets too.
 */
const actor = (over: Partial<WarehouseActor> = {}): WarehouseActor => ({
  userId: 32,
  isSuperAdmin: false,
  readOnly: false,
  isGlobalSuperAdmin: false,
  permissionNames: [],
  home: { wildcard: false, entityIds: [3] },
  declared: 3,
  ...over,
});

const build = () => {
  const rows = [
    { id: 5, assetId: 9, holderUserId: 41, holderObjectId: null, assignedAt: new Date(0), asset: { serialNumber: 'SN-1' } },
    { id: 6, assetId: 10, holderUserId: 77, holderObjectId: null, assignedAt: new Date(0), asset: { serialNumber: 'SN-2' } },
    { id: 7, assetId: 11, holderUserId: null, holderObjectId: 600, assignedAt: new Date(0), asset: {} },
    { id: 8, assetId: 12, holderUserId: null, holderObjectId: 700, assignedAt: new Date(0), asset: {} },
    { id: 9, assetId: 13, holderUserId: null, holderObjectId: 800, assignedAt: new Date(0), asset: {} },
  ];
  const prisma: any = {
    assetCustody: {
      findMany: jest.fn(async ({ where }: any = {}) =>
        where?.holderUserId === undefined ? rows : rows.filter((r) => r.holderUserId === where.holderUserId),
      ),
    },
  };
  const service = new ResponsibilitiesService(prisma);
  // Any HR or CRM call from these reads is a regression — and would be a 503 with nothing to answer it.
  const net = jest.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
    throw new Error(`unexpected network call: ${url}`);
  });
  return { controller: new ResponsibilitiesController(service), prisma, net };
};

describe('GET /responsibilities/user/:userId — whose holdings', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INTERNAL_SECRET = 's3cret';
    process.env.HR_SERVICE_URL = 'http://hr.test';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...env };
  });

  it('shows your own, with no right, no organisation, and without asking anybody', async () => {
    const { controller, net } = build();
    await expect(controller.getUserResponsibilities(41, actor({ userId: 41, declared: null }))).resolves.toHaveLength(1);
    expect(net).not.toHaveBeenCalled();
  });

  it("refuses somebody else's to a person with no responsibility right — nothing read", async () => {
    const { controller, prisma, net } = build();
    await expect(controller.getUserResponsibilities(41, actor({ permissionNames: ['view_items'] }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(net).not.toHaveBeenCalled();
    expect(prisma.assetCustody.findMany).not.toHaveBeenCalled();
  });

  it("shows somebody else's to a right holder with no organisation declared (no «Ընտրեք կազմակերպությունը» any more)", async () => {
    const { controller } = build();
    await expect(
      controller.getUserResponsibilities(41, actor({ permissionNames: ['view_responsibilities'], declared: null })),
    ).resolves.toEqual([expect.objectContaining({ userId: 41, assetId: 9 })]);
    await expect(
      controller.getUserResponsibilities(41, actor({ isSuperAdmin: true, isGlobalSuperAdmin: true, declared: null })),
    ).resolves.toHaveLength(1);
  });

  it.each(['view_responsibilities', 'manage_responsibilities', 'view_asset_custody', 'issue_assets', 'approve_asset_requests', 'manage_warehouse'])(
    'shows a colleague to a holder of %s, without asking HR',
    async (right) => {
      const { controller, net } = build();
      const rows = await controller.getUserResponsibilities(41, actor({ permissionNames: [right] }));
      expect(rows).toEqual([expect.objectContaining({ userId: 41, assetId: 9 })]);
      expect(net).not.toHaveBeenCalled();
    },
  );

  it("shows another organisation's person to a right holder acting elsewhere — right or super admin, HR not asked", async () => {
    const { controller, net } = build();
    await expect(
      controller.getUserResponsibilities(77, actor({ permissionNames: ['manage_responsibilities'] })),
    ).resolves.toEqual([expect.objectContaining({ userId: 77, assetId: 10 })]);
    await expect(controller.getUserResponsibilities(77, actor({ isSuperAdmin: true }))).resolves.toHaveLength(1);
    expect(net).not.toHaveBeenCalled();
  });

  it('the rule knows no organisation: own, allowed, or refused for want of a right', () => {
    expect(decideHoldingsRead(actor({ userId: 41, declared: null }), 41)).toEqual({ kind: 'own' });
    expect(decideHoldingsRead(actor({ permissionNames: ['view_responsibilities'], declared: null }), 77)).toEqual({ kind: 'allowed' });
    expect(decideHoldingsRead(actor({ permissionNames: ['view_items'] }), 77)).toEqual({ kind: 'refused', because: 'no-right' });
  });

  it("leaves HR's deactivation check alone: the custody internal route is public behind the internal secret", async () => {
    const openForUser = jest.fn(async () => [{ id: 5 }]);
    const custody = new AssetCustodyController({ openForUser } as any, {} as any, {} as any);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AssetCustodyController.prototype.openInternal)).toBe(true);
    await expect(custody.openInternal(41, 's3cret')).resolves.toEqual([{ id: 5 }]);
    await expect(custody.openInternal(41, 'wrong')).rejects.toBeInstanceOf(ForbiddenException);
    expect(openForUser).toHaveBeenCalledTimes(1);
  });
});

describe('GET /responsibilities — the register', () => {
  afterEach(() => jest.restoreAllMocks());
  const ids = (rows: any[]) => rows.map((r) => r.id).sort();

  it("holds every organisation's holders — people and objects — whichever organisation is acted in", async () => {
    const { controller, net } = build();
    // The handler takes nothing: the organisation acted in cannot narrow it.
    expect(ResponsibilitiesController.prototype.getAll.length).toBe(0);
    expect(ids(await controller.getAll())).toEqual([5, 6, 7, 8, 9]);
    expect(net).not.toHaveBeenCalled();
  });

  it('is never a 503: HR and CRM are not consulted, so their being down cannot matter', async () => {
    const { controller, net } = build();
    await expect(controller.getAll()).resolves.toHaveLength(5);
    expect(net).not.toHaveBeenCalled();
  });
});
