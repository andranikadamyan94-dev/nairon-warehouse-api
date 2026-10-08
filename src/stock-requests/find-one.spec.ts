import { NotFoundException } from '@nestjs/common';
import { StockRequestsService } from './stock-requests.service';

/**
 * GET /stock-requests/:id — what a notification link opens (2026-10-08).
 * Same visibility as the list: main-side staff read any request, anybody
 * else only one of a warehouse they belong to; the rest is a 404.
 */
describe('StockRequestsService.findOne', () => {
  function world(accessible: 'all' | number[]) {
    const prisma: any = {
      stockRequest: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 6 ? { id: 6, warehouseId: 2, createdBy: 14, decidedBy: null, items: [] } : null),
      },
    };
    const warehouses: any = { accessibleWarehouseIds: jest.fn(async () => accessible) };
    const users: any = { getUsersByIds: jest.fn(async () => [{ id: 14, firstName: 'Աննա', lastName: 'Ա.' }]) };
    return { svc: new StockRequestsService(prisma, warehouses, {} as any, users), warehouses };
  }
  const member = { isSuperAdmin: false, permissionNames: [] };

  it('main-side staff read any request, with the creator\'s name', async () => {
    const { svc, warehouses } = world([]);
    const row = await svc.findOne(6, 40, { isSuperAdmin: false, permissionNames: ['manage_stock_transfers'] });
    expect(row).toMatchObject({ id: 6, createdByName: 'Աննա Ա.' });
    expect(warehouses.accessibleWarehouseIds).not.toHaveBeenCalled();
  });

  it('a member of the request\'s warehouse reads it', async () => {
    const { svc } = world([2]);
    await expect(svc.findOne(6, 14, member)).resolves.toMatchObject({ id: 6 });
  });

  it('somebody else, or an id that does not exist → 404', async () => {
    await expect(world([3]).svc.findOne(6, 15, member)).rejects.toBeInstanceOf(NotFoundException);
    await expect(world('all').svc.findOne(99, 15, member)).rejects.toBeInstanceOf(NotFoundException);
  });
});
