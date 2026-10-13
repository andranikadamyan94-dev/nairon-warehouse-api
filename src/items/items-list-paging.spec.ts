import { ItemsService } from './items.service';

/**
 * GET /items — the sub-warehouse search (performance audit 2026-10-13, bug 2)
 * and the opt-in page for the Ռեսուրսներ list (C10). Row-for-row equality of
 * the page with the old full list is checked against a real database by
 * test-scripts/resources-paging-parity.mjs.
 */
describe('ItemsService.findAll', () => {
  const make = (rows: any[] = []) => {
    const findMany = jest.fn(async () => rows);
    const count = jest.fn(async () => rows.length);
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    (svc as any).prisma = {
      item: { findMany, count },
      warehouseStock: { findMany: jest.fn(async () => [{ itemId: 3, quantity: 4 }]) },
      asset: { groupBy: jest.fn(async () => [{ itemId: 8, _count: { id: 1 } }]) },
    };
    (svc as any).categoriesService = { getDescendantIds: jest.fn(async (id: number) => [id, id + 1]) };
    return { svc, findMany, count };
  };
  const SEARCH = {
    OR: [
      { name: { contains: 'բետ', mode: 'insensitive' } },
      { secondaryName: { contains: 'բետ', mode: 'insensitive' } },
      { code: { contains: 'բետ', mode: 'insensitive' } },
    ],
  };

  it('a sub-warehouse keeps the search: both OR-lists are AND terms', async () => {
    const { svc, findMany } = make();
    await svc.findAll({ warehouseId: '5', search: 'բետ' } as any);
    const where = (findMany.mock.calls[0] as any)[0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([
        SEARCH,
        { OR: [{ id: { in: [3, 8] } }, { variants: { some: { id: { in: [3, 8] } } } }] },
        { parentItemId: null },
      ]),
    );
  });

  it('without paged the answer is the array, as before', async () => {
    const { svc } = make([{ id: 1, quantity: 2, variants: [], images: [], _count: { assets: 0 } }]);
    await expect(svc.findAll({} as any)).resolves.toEqual([
      expect.objectContaining({ id: 1, quantity: 2, coverUrl: null }),
    ]);
  });

  it('paged=1 counts and reads the shown rows only, and brings their matching variants under them', async () => {
    const parent = { id: 9, quantity: 0, parentItemId: null, variants: [{ id: 10, quantity: 3 }], images: [], _count: { assets: 0 } };
    const child = { id: 10, quantity: 3, parentItemId: 9, variants: [], images: [], _count: { assets: 0 } };
    const { svc, findMany, count } = make();
    findMany
      .mockResolvedValueOnce([{ id: 9 }] as any)
      .mockResolvedValueOnce([parent] as any)
      .mockResolvedValueOnce([child] as any);
    count.mockResolvedValueOnce(31);
    const res: any = await svc.findAll({ paged: '1', skip: 20, take: 10, includeVariants: '1', search: 'բետ' } as any);
    const matching = { AND: [SEARCH] };
    // The matching parents by id — a negated relation filter loses rows on NULL columns.
    expect((findMany.mock.calls[0] as any)[0].where).toEqual({ AND: [matching, { variants: { some: matching } }] });
    const shown = { AND: [matching, { OR: [{ parentItemId: null }, { parentItemId: { notIn: [9] } }] }] };
    expect(count).toHaveBeenCalledWith({ where: shown });
    expect((findMany.mock.calls[1] as any)[0]).toMatchObject({ where: shown, skip: 20, take: 10, orderBy: { id: 'desc' } });
    expect((findMany.mock.calls[2] as any)[0].where).toEqual({ AND: [matching, { parentItemId: { in: [9] } }] });
    expect(res.total).toBe(31);
    expect(res.items).toEqual([expect.objectContaining({ id: 9, quantity: 3, variants: [expect.objectContaining({ id: 10 })] })]);
  });

  it('paged take is clamped to 100', async () => {
    const { svc, findMany } = make();
    await svc.findAll({ paged: '1', take: 5000 } as any);
    expect((findMany.mock.calls[0] as any)[0].take).toBe(100);
  });
});

describe('ItemsService.options — ids', () => {
  it('reads exactly the asked ids, variants included', async () => {
    const findMany = jest.fn(async () => []);
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    (svc as any).prisma = { item: { findMany } };
    await svc.options({ ids: '4,x,4,12', search: 'zzz' });
    expect((findMany.mock.calls[0] as any)[0].where).toEqual({ id: { in: [4, 12] } });
    await expect(svc.options({ ids: '' })).resolves.toEqual([]);
  });
});
