import { NotFoundException } from '@nestjs/common';

import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';
import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

/**
 * GET /procurement/:id (org sweep 2026-10-02, hole 6). It answered any order —
 * supplier, lines, prices — to a procurement right holder of any organisation.
 *
 * Order 1 is filed under organisation 3, order 2 under 9, order 3 under none.
 */
const ORDERS: Record<number, any> = {
  1: { id: 1, entityId: 3, supplier: { name: 'A' }, items: [{ unitPrice: 10 }] },
  2: { id: 2, entityId: 9, supplier: { name: 'B' }, items: [{ unitPrice: 20 }] },
  3: { id: 3, entityId: null, supplier: { name: 'C' }, items: [] },
};

const build = () => {
  const prisma: any = { procurementOrder: { findUnique: jest.fn(async ({ where }: any) => ORDERS[where.id] ?? null) } };
  const service = new ProcurementService(prisma, {} as any, {} as any, {} as any, {} as any);
  return new ProcurementController(service);
};

const acting = (declared: number | null) => ({ declared }) as any;

describe('GET /procurement/:id — only the organisation acted in', () => {
  it('shows an order filed under the organisation the caller acts in', async () => {
    await expect(build().findOne(1, acting(3))).resolves.toMatchObject({ id: 1, supplier: { name: 'A' } });
  });

  it("is not found for another organisation's order", async () => {
    await expect(build().findOne(2, acting(3))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is not found for an order filed under an organisation when none is declared', async () => {
    await expect(build().findOne(1, acting(null))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps showing an order filed under no organisation, as the requisition read does', async () => {
    await expect(build().findOne(3, acting(3))).resolves.toMatchObject({ id: 3 });
    await expect(build().findOne(3, acting(null))).resolves.toMatchObject({ id: 3 });
  });

  it('missing and refused read the same', async () => {
    const missing = await build().findOne(404, acting(3)).catch((e) => e);
    const refused = await build().findOne(2, acting(3)).catch((e) => e);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(refused.message).toBe(missing.message);
  });

  it('still needs a procurement read right (route guard)', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, ProcurementController.prototype.findOne)).toEqual(
      expect.arrayContaining(['view_procurement', 'manage_procurement']),
    );
  });

  it("leaves finance's internal read alone: any order, behind the internal secret", async () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ProcurementController.prototype.findOneInternal)).toBe(true);
    await expect(build().findOneInternal(2)).resolves.toMatchObject({ id: 2, entityId: 9 });
  });
});
