import { UsersPrismaService } from './users-prisma.service';

/**
 * The audience rule (notifications phase 1, 2026-10-06), as the query states
 * it. The rule lives in SQL against the shared users DB; this pins its shape
 * (the live check was run against the local nairon_auth DB by hand):
 *  - permission holders IN the record's organisation: assignment global (0)
 *    or in that organisation, and the grant global (0) or in it;
 *  - super-admins only through an explicit grant (no `isSuperAdmin` escape);
 *  - nobody holding a read-only role;
 *  - a record with no organisation reaches global holders only.
 */
function capture() {
  const svc = Object.create(UsersPrismaService.prototype) as UsersPrismaService;
  const seen: { sql: string; values: unknown[] }[] = [];
  (svc as any).$queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    seen.push({ sql: strings.join('?'), values });
    return [];
  });
  return { svc, seen };
}

describe('getNotificationRecipients — who hears about a record', () => {
  it('scopes to the record\'s organisation: assignment and grant both global or in it', async () => {
    const { svc, seen } = capture();
    await svc.getNotificationRecipients(['manage_warehouse'], [7]);
    const { sql, values } = seen[0];
    expect(values).toEqual([[7], ['manage_warehouse']]);
    expect(sql).toMatch(/unnest\(\?::int\[\]\) AS scope\(id\)/);
    expect(sql).toMatch(/ur\."entityId" = 0 OR ur\."entityId" = scope\.id/);
    expect(sql).toMatch(/rp\."entityId" = 0 OR rp\."entityId" = scope\.id/);
  });

  it('super-admins are not added by isSuperAdmin — only an explicit grant of the permission counts', async () => {
    const { svc, seen } = capture();
    await svc.getNotificationRecipients(['manage_warehouse'], [7]);
    expect(seen[0].sql).not.toMatch(/isSuperAdmin/);
    expect(seen[0].sql).toMatch(/JOIN "Permission" p ON p\.id = rp\."permissionId"/);
    expect(seen[0].sql).not.toMatch(/LEFT JOIN/);
  });

  it('read-only roles never receive', async () => {
    const { svc, seen } = capture();
    await svc.getNotificationRecipients(['manage_warehouse'], [7]);
    expect(seen[0].sql).toMatch(/NOT EXISTS \([\s\S]*rr\."readOnly" = true/);
  });

  it('no organisation on the record → global holders only (scope 0)', async () => {
    const { svc, seen } = capture();
    await svc.getNotificationRecipients(['manage_warehouse'], [null]);
    await svc.getNotificationRecipients(['manage_warehouse'], []);
    expect(seen.map((s) => s.values[0])).toEqual([[0], [0]]);
  });

  it('several organisations: one scope each, deduplicated', async () => {
    const { svc, seen } = capture();
    await svc.getNotificationRecipients(['manage_warehouse'], [7, 3, 7, null]);
    expect(seen[0].values[0]).toEqual([7, 3, 0]);
  });

  it('no permissions → nobody, and no query', async () => {
    const { svc, seen } = capture();
    expect(await svc.getNotificationRecipients([], [7])).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});
