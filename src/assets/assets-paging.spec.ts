import { AssetsService } from './assets.service';

/** GET /assets honours page + limit when asked (performance audit 2026-10-13); without limit, the whole list as before. */
describe('AssetsService.findAll paging', () => {
  const rows = Array.from({ length: 23 }, (_, i) => ({ id: 23 - i, serialNumber: `S${i}` }));
  const make = () => {
    const findMany = jest.fn(async (args: any) =>
      args.take ? rows.slice(args.skip, args.skip + args.take) : rows,
    );
    const count = jest.fn(async () => rows.length);
    const svc = Object.create(AssetsService.prototype) as AssetsService;
    (svc as any).prisma = { asset: { findMany, count } };
    return { svc, findMany, count };
  };

  it('no limit → the full array, unchanged shape', async () => {
    const { svc, findMany, count } = make();
    expect(await svc.findAll({ status: 'AVAILABLE' })).toBe(rows);
    expect(findMany.mock.calls[0][0]).toEqual({ where: { status: 'AVAILABLE' }, include: { item: true }, orderBy: { createdAt: 'desc' } });
    expect(count).not.toHaveBeenCalled();
  });

  it('page + limit → the same rows the table sliced locally, with the total', async () => {
    const { svc, findMany } = make();
    const res: any = await svc.findAll({ page: '3', limit: '10', sortBy: 'serialNumber', sortOrder: 'asc' });
    expect(res).toEqual({ data: rows.slice(20, 23), total: 23, page: 3, limit: 10 });
    expect(findMany.mock.calls[0][0]).toMatchObject({ orderBy: [{ serialNumber: 'asc' }, { id: 'desc' }], skip: 20, take: 10 });
  });

  it('clamps nonsense', async () => {
    const { svc, findMany } = make();
    await svc.findAll({ page: '-4', limit: '100000' });
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 500 });
  });
});
