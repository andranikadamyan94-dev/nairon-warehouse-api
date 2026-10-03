import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { ResponsibilitiesController } from './responsibilities.controller';
import { ResponsibilitiesService } from './responsibilities.service';
import { DelegatedWriteMembership } from '../auth/delegated-write.membership';
import { HolderScope } from '../common/holder-scope.service';
import { WarehouseActor } from '../auth/actor';
import { AssetCustodyController } from '../asset-custody/asset-custody.controller';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

/**
 * GET /responsibilities/user/:userId (org sweep 2026-10-02, hole 5). It had no
 * check at all: anyone signed in read anyone's custody — assets and serials.
 *
 * Organisation 3's members, per HR: 32 and 41. Person 77 is in organisation 9.
 */
const MEMBERS: Record<number, number[]> = { 3: [32, 41], 9: [77] };

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

const build = (hr: 'up' | 'down' = 'up') => {
  // Person 41 (organisation 3), person 77 (organisation 9), object 600 (filed
  // under 3), object 700 (under 9), object 800 (under none).
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
  const OBJECTS: Record<number, number | null> = { 600: 3, 700: 9, 800: null };
  const objects: any = { crmObject: jest.fn(async (id: number) => (id in OBJECTS ? { id, entityId: OBJECTS[id] } : undefined)) };
  const membership = new DelegatedWriteMembership();
  const fetcher = jest.fn(async (url: string, init: { headers: Record<string, string> }) => {
    if (hr === 'down') throw new Error('ECONNREFUSED');
    const m = /\/api\/entities\/(\d+)\/members\/internal\?userIds=([\d,]+)$/.exec(url);
    expect(init.headers['x-internal-secret']).toBe('s3cret');
    const entityId = Number(m![1]);
    const asked = m![2].split(',').map(Number);
    return { ok: true, status: 200, json: async () => asked.filter((u) => (MEMBERS[entityId] ?? []).includes(u)) };
  });
  membership.fetcher = fetcher as never;
  const service = new ResponsibilitiesService(prisma, new HolderScope(membership, objects));
  return { controller: new ResponsibilitiesController(service), prisma, fetcher };
};

describe('GET /responsibilities/user/:userId — whose holdings', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INTERNAL_SECRET = 's3cret';
    process.env.HR_SERVICE_URL = 'http://hr.test';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('shows your own, with no right, no organisation, and without asking HR', async () => {
    const { controller, fetcher } = build();
    await expect(controller.getUserResponsibilities(41, actor({ userId: 41, declared: null }))).resolves.toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses somebody else's to a person with no responsibility right — nothing read", async () => {
    const { controller, prisma, fetcher } = build();
    await expect(controller.getUserResponsibilities(41, actor({ permissionNames: ['view_items'] }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(prisma.assetCustody.findMany).not.toHaveBeenCalled();
  });

  it("refuses somebody else's when no organisation is declared, right or not", async () => {
    const { controller, prisma } = build();
    await expect(
      controller.getUserResponsibilities(41, actor({ permissionNames: ['view_responsibilities'], declared: null })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.getUserResponsibilities(41, actor({ isSuperAdmin: true, isGlobalSuperAdmin: true, declared: null })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.assetCustody.findMany).not.toHaveBeenCalled();
  });

  it.each(['view_responsibilities', 'manage_responsibilities', 'view_asset_custody', 'issue_assets', 'approve_asset_requests', 'manage_warehouse'])(
    'shows a member of the organisation to a holder of %s there',
    async (right) => {
      const { controller, fetcher } = build();
      const rows = await controller.getUserResponsibilities(41, actor({ permissionNames: [right] }));
      expect(rows).toEqual([expect.objectContaining({ userId: 41, assetId: 9 })]);
      expect(fetcher).toHaveBeenCalledWith('http://hr.test/api/entities/3/members/internal?userIds=41', expect.anything());
    },
  );

  it("is not found for somebody outside the organisation — another organisation's person, right or super admin", async () => {
    const { controller, prisma } = build();
    await expect(
      controller.getUserResponsibilities(77, actor({ permissionNames: ['manage_responsibilities'] })),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.getUserResponsibilities(77, actor({ isSuperAdmin: true }))).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.assetCustody.findMany).not.toHaveBeenCalled();
  });

  it('asks HR about the organisation declared, not one the right was found in elsewhere', async () => {
    const { controller } = build();
    // Person 77 belongs to 9; acting in 9 with the right there shows them.
    await expect(
      controller.getUserResponsibilities(77, actor({ declared: 9, home: { wildcard: false, entityIds: [3, 9] }, permissionNames: ['view_responsibilities'] })),
    ).resolves.toEqual([expect.objectContaining({ userId: 77, assetId: 10 })]);
  });

  it('HR unreachable is a 503, never an answer either way', async () => {
    const { controller, prisma } = build('down');
    await expect(
      controller.getUserResponsibilities(41, actor({ permissionNames: ['view_responsibilities'] })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.assetCustody.findMany).not.toHaveBeenCalled();
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

describe('GET /responsibilities — the register, in an organisation', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INTERNAL_SECRET = 's3cret';
    process.env.HR_SERVICE_URL = 'http://hr.test';
  });
  afterEach(() => {
    process.env = { ...env };
  });
  const ids = (rows: any[]) => rows.map((r) => r.id).sort();

  it("holds only the organisation's members and its objects (and objects filed under none)", async () => {
    const { controller, fetcher } = build();
    expect(ids(await controller.getAll(actor({ permissionNames: ['view_responsibilities'] })))).toEqual([5, 7, 9]);
    // One HR call for all the people.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('http://hr.test/api/entities/3/members/internal?userIds=41,77');
  });

  it('is the whole register with no organisation sent (today\'s behaviour), without asking HR', async () => {
    const { controller, fetcher } = build();
    expect(ids(await controller.getAll(actor({ declared: null })))).toEqual([5, 6, 7, 8, 9]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is the whole register for a global super-admin, organisation or not', async () => {
    const { controller, fetcher } = build();
    expect(ids(await controller.getAll(actor({ isSuperAdmin: true, isGlobalSuperAdmin: true })))).toEqual([5, 6, 7, 8, 9]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a super-admin of one organisation is still held to it', async () => {
    const { controller } = build();
    expect(ids(await controller.getAll(actor({ isSuperAdmin: true, declared: 9, home: { wildcard: false, entityIds: [9] } })))).toEqual([6, 8, 9]);
  });

  it('HR unreachable is a 503, not an unfiltered register', async () => {
    const { controller } = build('down');
    await expect(controller.getAll(actor({ permissionNames: ['view_responsibilities'] }))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
