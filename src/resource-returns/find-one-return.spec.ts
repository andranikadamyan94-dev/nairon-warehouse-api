import { HttpException } from '@nestjs/common';

import { WarehouseActor } from '../auth/actor';
import { ResourceReturnsService } from './resource-returns.service';

/**
 * GET /resource-returns/:id (2026-10-08): one return, by the list's own rule —
 * what a notification link opens. The person who asked for it reads it (the
 * notice goes to them), so does anyone on its task and warehouse staff; anyone
 * else gets the same 404 as a return that does not exist.
 *
 * ME filed return 1; COLLEAGUE is on its task 2451; STRANGER is neither and
 * holds no warehouse right; KEEPER is warehouse staff off the task.
 */

const status = async (attempt: () => Promise<unknown>) => {
  try {
    await attempt();
    return 200;
  } catch (e) {
    if (e instanceof HttpException) return e.getStatus();
    throw e;
  }
};

const ENTITY = 3;
const OTHER = 5;
const ME = 39;
const COLLEAGUE = 40;
const STRANGER = 41;
const KEEPER = 50;

const actor = (userId: number, over: Partial<WarehouseActor> = {}): WarehouseActor => ({
  userId,
  isSuperAdmin: false,
  readOnly: false,
  isGlobalSuperAdmin: false,
  permissionNames: [],
  home: { wildcard: false, entityIds: [OTHER] },
  declared: OTHER,
  ...over,
});

function service() {
  const rows: any[] = [
    {
      id: 1,
      status: 'PENDING',
      requestedBy: ME,
      reservation: { id: 70, taskId: 2451, requesterWorkspaceId: ENTITY, item: { id: 5, name: 'Ցեմենտ', category: { entityId: 1 } } },
    },
  ];
  const prisma: any = {
    resourceReturn: { findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null) },
  };
  const onTask = new Set([COLLEAGUE]);
  const reservations: any = { isOnTask: jest.fn(async (_taskId: number, userId: number) => onTask.has(userId)) };
  const stub: any = {};
  return new ResourceReturnsService(prisma, stub, stub, reservations);
}

describe('GET /resource-returns/:id — what a notification link opens', () => {
  it('the person who asked for the return reads it, without any warehouse right', async () => {
    expect(await status(() => service().findOne(1, actor(ME)))).toBe(200);
  });

  it('so does anyone on its task, and warehouse staff', async () => {
    expect(await status(() => service().findOne(1, actor(COLLEAGUE)))).toBe(200);
    expect(await status(() => service().findOne(1, actor(KEEPER, { permissionNames: ['manage_resource_returns', 'view_reservations'] })))).toBe(200);
  });

  it('anyone else gets the same 404 as a return that does not exist', async () => {
    expect(await status(() => service().findOne(1, actor(STRANGER)))).toBe(404);
    expect(await status(() => service().findOne(999, actor(ME)))).toBe(404);
  });
});
