import { ItemsService } from './items.service';

/** GET /items/options — a lean remote-search picker read (performance audit 2026-10-13). */
describe('ItemsService.options', () => {
  const make = () => {
    const findMany = jest.fn(async () => []);
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    (svc as any).prisma = { item: { findMany } };
    return { svc, findMany };
  };

  it('defaults to 50 parents by name with the lean fields only', async () => {
    const { svc, findMany } = make();
    await svc.options({});
    expect(findMany).toHaveBeenCalledWith({
      where: { parentItemId: null },
      select: { id: true, code: true, name: true, secondaryName: true, type: true, unit: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 50,
    });
  });

  it('searches name, second name and code; clamps take; variants on request', async () => {
    const { svc, findMany } = make();
    await svc.options({ search: ' Բետ ', take: 1000, type: 'MATERIAL', includeVariants: '1' });
    const arg = (findMany.mock.calls[0] as any)[0];
    expect(arg.take).toBe(200);
    expect(arg.where).toEqual({
      type: 'MATERIAL',
      OR: [
        { name: { contains: 'Բետ', mode: 'insensitive' } },
        { secondaryName: { contains: 'Բետ', mode: 'insensitive' } },
        { code: { contains: 'Բետ', mode: 'insensitive' } },
      ],
    });
  });
});
