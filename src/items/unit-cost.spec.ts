import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateItemDto } from './dto/update-item.dto';
import { ItemsService } from './items.service';

/**
 * WH08-01 (QA, 2026-10-09): the unit cost typed on the item form never reached
 * the row — create and update name their fields one by one and `unitCost` was
 * not among them. The edit form showed it empty, and every issue of the item
 * froze a cost of 0 onto the object (#2042).
 */

const ACTOR = { userId: 7 } as any;

function world(row: Record<string, unknown> = {}) {
  const stored: Record<string, any> = {
    id: 334,
    name: 'Պահեստային գործիք',
    type: 'CONSUMABLE',
    unit: 'pcs',
    categoryId: 3,
    quantity: 10,
    unitCost: null,
    catalogVisible: true,
    parentItemId: null,
    variants: [],
    ...row,
  };
  const prisma: any = {
    item: {
      create: jest.fn(async ({ data }: any) => {
        Object.assign(stored, data);
        return { id: stored.id };
      }),
      update: jest.fn(async ({ data }: any) => Object.assign(stored, data)),
      updateMany: jest.fn(async () => ({ count: 0 })),
      findFirst: jest.fn(async () => ({ ...stored })),
    },
    itemAttribute: { createMany: jest.fn(), deleteMany: jest.fn() },
  };
  prisma.$transaction = async (work: (tx: any) => Promise<unknown>) => work(prisma);
  const workspaces: any = { of: jest.fn(async () => ({})), ofCategory: jest.fn(async () => ({})) };
  const service = new ItemsService(prisma, {} as any, { check: jest.fn() } as any, workspaces, {} as any);
  return { service, prisma, stored };
}

describe('items · unit cost is stored and read back', () => {
  it('create keeps the unit cost it was given', async () => {
    const { service, prisma } = world();
    const item = await service.create({ name: 'Գործիք', type: 'CONSUMABLE', quantity: 10, unitCost: 1000 } as any, ACTOR);
    expect(prisma.item.create.mock.calls[0][0].data.unitCost).toBe(1000);
    expect(item.unitCost).toBe(1000);
  });

  it('create without a cost stores none', async () => {
    const { service, prisma } = world();
    await service.create({ name: 'Գործիք', type: 'CONSUMABLE' } as any, ACTOR);
    expect(prisma.item.create.mock.calls[0][0].data.unitCost).toBeNull();
  });

  it('update writes the new cost, and the edit form reads it back', async () => {
    const { service } = world({ unitCost: 1000 });
    await service.update(334, { unitCost: 1234 } as any, ACTOR);
    await expect(service.findOne(334)).resolves.toMatchObject({ unitCost: 1234 });
  });

  it('an explicit null clears it; leaving it out keeps it', async () => {
    const cleared = world({ unitCost: 1000 });
    await cleared.service.update(334, { unitCost: null } as any, ACTOR);
    expect(cleared.stored.unitCost).toBeNull();

    const kept = world({ unitCost: 1000 });
    await kept.service.update(334, { notes: 'x' } as any, ACTOR);
    expect(kept.prisma.item.update.mock.calls[0][0].data).not.toHaveProperty('unitCost');
    expect(kept.stored.unitCost).toBe(1000);
  });

  it('the request keeps a number and an emptied field as null', async () => {
    const dto = plainToInstance(UpdateItemDto, { unitCost: '1234' });
    expect(dto.unitCost).toBe(1234);
    expect(await validate(dto)).toHaveLength(0);
    expect(plainToInstance(UpdateItemDto, { unitCost: null }).unitCost).toBeNull();
    const negative = plainToInstance(UpdateItemDto, { unitCost: -5 });
    expect((await validate(negative)).map((e) => e.property)).toEqual(['unitCost']);
  });
});
