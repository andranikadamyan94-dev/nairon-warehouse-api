import { NotFoundException } from '@nestjs/common';

import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';
import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';

/**
 * GET /procurement/:id/position (2026-10-08): the list page a notification
 * link opens so the order's row can be expanded. It must walk the list's own
 * filters and sort — the same where/orderBy findAll pages with.
 */
const build = (ids: number[], existing: number[] = ids) => {
  const prisma: any = {
    procurementOrder: {
      findMany: jest.fn(async () => ids.map((id) => ({ id }))),
      count: jest.fn(async ({ where }: any) => (where?.id !== undefined ? (existing.includes(where.id) ? 1 : 0) : ids.length)),
    },
  };
  const service = new ProcurementService(prisma, {} as any, {} as any, {} as any, {} as any);
  return { service, prisma, controller: new ProcurementController(service) };
};

describe('procurement order position', () => {
  // 45 orders, newest first: ids 45..1.
  const newestFirst = Array.from({ length: 45 }, (_, i) => 45 - i);

  it('gives the page under the requested page size', async () => {
    const { service } = build(newestFirst);
    await expect(service.positionOf(45, { limit: '20' })).resolves.toEqual({ inList: true, page: 1 });
    await expect(service.positionOf(26, { limit: '20' })).resolves.toEqual({ inList: true, page: 1 });
    await expect(service.positionOf(25, { limit: '20' })).resolves.toEqual({ inList: true, page: 2 });
    await expect(service.positionOf(3, { limit: '20' })).resolves.toEqual({ inList: true, page: 3 });
    await expect(service.positionOf(3, { limit: '10' })).resolves.toEqual({ inList: true, page: 5 });
  });

  it('walks the same filters and sort the list pages with, ids only', async () => {
    const { service, prisma } = build(newestFirst);
    await service.positionOf(3, { status: 'ORDERED', supplierId: '7', sortBy: 'status', sortOrder: 'asc', limit: '20' });
    expect(prisma.procurementOrder.findMany).toHaveBeenCalledWith({
      where: { status: 'ORDERED', supplierId: 7 },
      orderBy: [{ status: 'asc' }, { id: 'desc' }],
      select: { id: true },
    });
    await service.findAll({ status: 'ORDERED', supplierId: '7', sortBy: 'status', sortOrder: 'asc', limit: '20' });
    const [listArgs] = prisma.procurementOrder.findMany.mock.calls[1];
    expect(listArgs.where).toEqual({ status: 'ORDERED', supplierId: 7 });
    expect(listArgs.orderBy).toEqual([{ status: 'asc' }, { id: 'desc' }]);
  });

  it('says when the filters leave an existing order out, and 404s a missing one', async () => {
    const { service } = build([5, 4], [9, 5, 4]);
    await expect(service.positionOf(9, { status: 'DRAFT' })).resolves.toEqual({ inList: false, page: null });
    await expect(service.positionOf(77, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is open to whoever may read the list', () => {
    const list = Reflect.getMetadata(PERMISSIONS_KEY, ProcurementController.prototype.findAll);
    const position = Reflect.getMetadata(PERMISSIONS_KEY, ProcurementController.prototype.position);
    expect(position).toEqual(list);
  });
});
