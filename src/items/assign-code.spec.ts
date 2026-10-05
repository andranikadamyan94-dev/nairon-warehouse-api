import { ConflictException, NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { ItemsController } from './items.controller';
import { ItemsService, systemItemCode } from './items.service';

/**
 * POST /items/:id/assign-code — owner, 2026-10-02. Items made before
 * auto-numbering (item 151 and its neighbours) have an empty code; this gives
 * them the code create would have given them, and nothing else. An existing
 * code is never changed.
 */

const ACTOR = { userId: 7 } as any;

function world(rows: { id: number; code: string | null; name?: string }[]) {
  const items = rows.map((r) => ({ name: 'Ապրանք', category: null, _count: { assets: 0 }, ...r }));
  const writes: unknown[] = [];
  const prisma: any = {
    item: {
      findFirst: jest.fn(async ({ where }: any) => items.find((i) => i.id === where.id) ?? null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        writes.push({ where, data });
        if (items.some((i) => i.id !== where.id && i.code === data.code)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = items.find((i) => i.id === where.id && i.code === where.code);
        if (!row) return { count: 0 };
        row.code = data.code;
        return { count: 1 };
      }),
      update: jest.fn(async () => {
        throw new Error('assign-code must not use an unconditional update');
      }),
    },
  };
  const workspaces: any = { of: jest.fn(async () => ({})), ofCategory: jest.fn(async () => ({})) };
  // The catalog (2026-10) writes an item and its attributes/variants in one transaction.
  prisma.$transaction = async (work: (tx: any) => Promise<unknown>) => work(prisma);
  const service = new ItemsService(prisma, {} as any, { check: jest.fn() } as any, workspaces, {} as any /* files (catalog) */);
  const operations: any = {
    runOnce: jest.fn(async (_input: unknown, work: (tx: any) => Promise<unknown>) => ({
      result: await work(prisma),
      replayed: false,
    })),
  };
  const controller = new ItemsController(service, operations);
  return { items, writes, prisma, service, controller, operations, workspaces };
}

describe('items · assign the system code to an item without one', () => {
  it('the code is the one create issues: RES- and the id, six digits', () => {
    expect(systemItemCode(151)).toBe('RES-000151');
    expect(systemItemCode(42)).toBe('RES-000042');
  });

  it('routes and permissions: same permission as changing the item', () => {
    const proto = ItemsController.prototype as any;
    expect(Reflect.getMetadata(PATH_METADATA, proto.assignCode)).toBe(':id/assign-code');
    expect(Reflect.getMetadata(PATH_METADATA, proto.preflightAssignCode)).toBe('preflight/assign-code/:id');
    const update = Reflect.getMetadata(PERMISSIONS_KEY, proto.update);
    expect(update).toEqual(['manage_items']);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.assignCode)).toEqual(update);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.preflightAssignCode)).toEqual(update);
  });

  it('gives a NULL-code item RES-<id> and returns it', async () => {
    const w = world([{ id: 151, code: null }]);
    const out: any = await w.controller.assignCode(151, ACTOR, 'op-1');
    expect(out.code).toBe('RES-000151');
    expect(w.items[0].code).toBe('RES-000151');
    expect(w.operations.runOnce).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'op-1', route: 'POST /items/:id/assign-code', body: { id: 151 } }),
      expect.any(Function),
    );
    expect(w.workspaces.of).toHaveBeenCalledWith('item', 151);
  });

  it('treats a blank code ("" or spaces) as empty and conditions the write on it', async () => {
    const w = world([{ id: 12, code: '' }, { id: 13, code: '  ' }]);
    await w.service.assignCode(12, ACTOR);
    await w.service.assignCode(13, ACTOR);
    expect(w.items.map((i) => i.code)).toEqual(['RES-000012', 'RES-000013']);
    expect(w.writes).toEqual([
      { where: { id: 12, code: '' }, data: { code: 'RES-000012' } },
      { where: { id: 13, code: '  ' }, data: { code: 'RES-000013' } },
    ]);
  });

  it('never changes an existing code — refused in Armenian with the code, nothing written', async () => {
    const w = world([{ id: 20, code: 'OLD-7' }]);
    const err = await w.service.assignCode(20, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({
        message: 'Կոդն արդեն կա՝ OLD-7, այն փոխել հնարավոր չէ։',
        reason: 'ITEM_CODE_EXISTS',
        code: 'OLD-7',
      }),
    );
    expect(w.writes).toEqual([]);
    expect(w.items[0].code).toBe('OLD-7');
  });

  it('a second call after success is refused, not re-issued', async () => {
    const w = world([{ id: 151, code: null }]);
    await w.service.assignCode(151, ACTOR);
    const err = await w.service.assignCode(151, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe('RES-000151');
  });

  it('a race lost between the read and the write is refused with the winner\'s code', async () => {
    const w = world([{ id: 151, code: null }]);
    w.prisma.item.updateMany.mockImplementationOnce(async () => {
      w.items[0].code = 'RES-000151';
      return { count: 0 };
    });
    const err = await w.service.assignCode(151, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().message).toBe('Կոդն արդեն կա՝ RES-000151, այն փոխել հնարավոր չէ։');
  });

  it('a code typed by hand onto another item is not overwritten or guessed around', async () => {
    const w = world([{ id: 151, code: null }, { id: 9, code: 'RES-000151' }]);
    const err = await w.service.assignCode(151, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().reason).toBe('ITEM_CODE_TAKEN');
    expect(w.items.map((i) => i.code)).toEqual([null, 'RES-000151']);
  });

  it('an unknown item is 404', async () => {
    const w = world([]);
    await expect(w.service.assignCode(5, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the preflight asks the same question and writes nothing', async () => {
    const w = world([{ id: 151, code: null }, { id: 20, code: 'OLD-7' }]);
    await expect(w.controller.preflightAssignCode(151, ACTOR)).resolves.toBe(PREFLIGHT_OK);
    await expect(w.controller.preflightAssignCode(20, ACTOR)).rejects.toBeInstanceOf(ConflictException);
    expect(w.writes).toEqual([]);
    expect(w.items[0].code).toBeNull();
  });

  it('update() still drops code — this route is the only way to fill one', async () => {
    const w = world([{ id: 151, code: null }]);
    w.prisma.item.update.mockImplementationOnce(async ({ data }: any) => ({ id: 151, ...data }));
    await w.service.update(151, { code: 'X-1', name: 'Նոր' } as any, ACTOR);
    expect(w.prisma.item.update.mock.calls[0][0].data).toEqual({ name: 'Նոր' });
  });
});
