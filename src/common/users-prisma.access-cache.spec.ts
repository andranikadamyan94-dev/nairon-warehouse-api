import { UsersPrismaService } from './users-prisma.service';

/** The per-request access read is cached 20 s per (userId, entityId) — performance audit 2026-10-13. */
describe('UsersPrismaService access cache', () => {
  it('asks the users DB once for repeated and concurrent reads of the same pair', async () => {
    const svc = new (UsersPrismaService as any)() as UsersPrismaService;
    const q = jest.fn().mockResolvedValue([{ name: 'view_items', isSuperAdmin: false, urEntityId: 0, readOnly: false }]);
    (svc as any).$queryRaw = q;
    const [a, b] = await Promise.all([svc.getUserAccessInfo(5, 0), svc.getUserAccessInfo(5, 0)]);
    const c = await svc.getUserAccessInfo(5, 0);
    expect(q).toHaveBeenCalledTimes(1);
    expect(a.permissionNames).toEqual(['view_items']);
    expect(c).toEqual(b);
    // A copy each time: a caller mutating its list cannot poison the cache.
    a.permissionNames.push('manage_warehouse');
    expect((await svc.getUserAccessInfo(5, 0)).permissionNames).toEqual(['view_items']);
  });

  it('keys by entity and leaves department-scoped reads uncached', async () => {
    const svc = new (UsersPrismaService as any)() as UsersPrismaService;
    const q = jest.fn().mockResolvedValue([{ name: 'x', isSuperAdmin: false, urEntityId: 0, readOnly: false }]);
    (svc as any).$queryRaw = q;
    await svc.getUserAccessInfo(5, 0);
    await svc.getUserAccessInfo(5, 3);
    await svc.getUserAccessInfo(5, 3, [1]);
    await svc.getUserAccessInfo(5, 3, [1]);
    expect(q).toHaveBeenCalledTimes(4);
  });

  it('caches workspaces per user', async () => {
    const svc = new (UsersPrismaService as any)() as UsersPrismaService;
    const q = jest.fn().mockResolvedValue([{ entityId: 0 }, { entityId: 2 }]);
    (svc as any).$queryRaw = q;
    expect(await svc.getUserWorkspaces(9)).toEqual({ wildcard: true, entityIds: [2] });
    await svc.getUserWorkspaces(9);
    expect(q).toHaveBeenCalledTimes(1);
  });
});
