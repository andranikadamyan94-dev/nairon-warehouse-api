import { AssetsService } from './assets.service';

/**
 * 2026-10-08 (owner): «Պատասխանատու» on the «Ակտիվներ» form is read-only — the
 * live custody holder. Asset custody is the only writer of the asset's
 * `responsibleUserId` mirror, so the asset routes drop whatever a client still
 * sends for it, on create and on update; every other field is written as before.
 */
function build() {
  const writes: { op: string; data: any }[] = [];
  const asset = { id: 1, itemId: 2, status: 'AVAILABLE', responsibleUserId: 77, item: { id: 2, name: 'Drill' } };
  const db: any = {
    asset: {
      findFirst: async () => asset,
      findUnique: async () => asset,
      create: async ({ data }: any) => { writes.push({ op: 'create', data }); return { id: 9, ...data }; },
      update: async ({ data }: any) => { writes.push({ op: 'update', data }); return { ...asset, ...data }; },
    },
  };
  const workspaces: any = { of: async () => null };
  const svc = new AssetsService(db, workspaces, {} as any);
  return { svc, writes };
}

const actor = { userId: 3, isAdmin: true, permissions: [] } as any;

describe('assets create/update ignore responsibleUserId', () => {
  it('update keeps notes/status but drops responsibleUserId', async () => {
    const { svc, writes } = build();
    await svc.update(1, { notes: 'scratched', status: 'MAINTENANCE' as any, responsibleUserId: 5 }, actor);
    expect(writes).toHaveLength(1);
    expect(writes[0].data).toEqual({ notes: 'scratched', status: 'MAINTENANCE' });
    expect(writes[0].data).not.toHaveProperty('responsibleUserId');
  });

  it('an update that only names a responsible person writes nothing about it', async () => {
    const { svc, writes } = build();
    await svc.update(1, { responsibleUserId: 5 }, actor);
    expect(writes[0].data).toEqual({});
  });

  it('create drops responsibleUserId and keeps the rest', async () => {
    const { svc, writes } = build();
    await svc.create({ itemId: 2, serialNumber: 'SN-1', responsibleUserId: 5 }, actor);
    expect(writes[0].data).toEqual({ itemId: 2, serialNumber: 'SN-1' });
  });
});
