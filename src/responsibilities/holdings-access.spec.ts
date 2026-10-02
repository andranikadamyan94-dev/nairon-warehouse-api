import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { ResponsibilitiesController } from './responsibilities.controller';
import { ResponsibilitiesService } from './responsibilities.service';
import { DelegatedWriteMembership } from '../auth/delegated-write.membership';
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
  isGlobalSuperAdmin: false,
  permissionNames: [],
  home: { wildcard: false, entityIds: [3] },
  declared: 3,
  ...over,
});

const build = (hr: 'up' | 'down' = 'up') => {
  const rows = [{ id: 5, assetId: 9, holderUserId: 41, assignedAt: new Date(0), asset: { serialNumber: 'SN-1' } }];
  const prisma: any = {
    assetCustody: { findMany: jest.fn(async ({ where }: any) => rows.filter((r) => r.holderUserId === where.holderUserId)) },
  };
  const membership = new DelegatedWriteMembership();
  const fetcher = jest.fn(async (url: string, init: { headers: Record<string, string> }) => {
    if (hr === 'down') throw new Error('ECONNREFUSED');
    const m = /\/api\/entities\/(\d+)\/members\/internal\?userIds=(\d+)$/.exec(url);
    expect(init.headers['x-internal-secret']).toBe('s3cret');
    const [entityId, userId] = [Number(m![1]), Number(m![2])];
    return { ok: true, status: 200, json: async () => ((MEMBERS[entityId] ?? []).includes(userId) ? [userId] : []) };
  });
  membership.fetcher = fetcher as never;
  const service = new ResponsibilitiesService(prisma, membership);
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
    ).resolves.toEqual([]);
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
