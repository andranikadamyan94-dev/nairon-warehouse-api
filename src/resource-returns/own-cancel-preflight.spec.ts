import { HttpException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { WarehouseActor } from '../auth/actor';
import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { ResourceWorkspaceService } from '../common/workspace/resource-workspace.service';
import { ResourceReturnsController } from './resource-returns.controller';
import { ResourceReturnsService } from './resource-returns.service';

/**
 * POST /resource-returns/:id/preflight/cancel (2026-10-01, coverage gaps
 * batch 4): «Չեղարկել» one's own pending return. cancel()'s own check — the
 * two-party rule and PENDING — behind the same guard, nothing written. Two
 * rules more: only the person who filed the return (the screen lets the whole
 * requesting side and warehouse staff), and one workspace — a return whose
 * requesting company is known and is not the one declared reads as not found.
 */

const outcome = async (attempt: () => Promise<unknown> | unknown) => {
  try {
    await attempt();
    return 'ok';
  } catch (e) {
    if (e instanceof HttpException) return `${e.getStatus()} ${JSON.stringify(e.getResponse())}`;
    throw e;
  }
};

const ENTITY = 3;
const OTHER = 5;
const ME = 39;
const COLLEAGUE = 40;
const KEEPER = 50;
const T0 = new Date('2026-09-30T08:00:00Z');

const actor = (userId: number, over: Partial<WarehouseActor> = {}): WarehouseActor => ({
  userId,
  isSuperAdmin: false,
  isGlobalSuperAdmin: false,
  permissionNames: ['view_warehouse'],
  home: { wildcard: false, entityIds: [ENTITY] },
  declared: ENTITY,
  ...over,
});

function world() {
  const writes: string[] = [];
  const reservation = (requesterWorkspaceId: number | null) => ({
    id: 70,
    taskId: 2451,
    projectName: 'ՏՏ',
    requesterWorkspaceId,
    item: { id: 5, name: 'Ցեմենտ M400', unit: 'KG', category: { entityId: 1 } },
  });
  const rows: any[] = [
    { id: 1, status: 'PENDING', quantity: 4, notes: 'Ավելացել է', requestedBy: ME, requestedAt: T0, updatedAt: T0, reservation: reservation(ENTITY) },
    { id: 2, status: 'RECEIVED', quantity: 4, notes: null, requestedBy: ME, requestedAt: T0, updatedAt: T0, reservation: reservation(ENTITY) },
    { id: 3, status: 'PENDING', quantity: 1, notes: null, requestedBy: COLLEAGUE, requestedAt: T0, updatedAt: T0, reservation: reservation(ENTITY) },
    { id: 4, status: 'PENDING', quantity: 1, notes: null, requestedBy: ME, requestedAt: T0, updatedAt: T0, reservation: reservation(OTHER) },
  ];
  const prisma: any = {
    resourceReturn: {
      findUnique: jest.fn(async ({ where, include, select }: any) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) return null;
        if (select) return { reservation: { requesterWorkspaceId: r.reservation.requesterWorkspaceId, item: { category: r.reservation.item.category } } };
        if (include) {
          const { category: _c, ...item } = r.reservation.item;
          return { ...r, reservation: { ...r.reservation, item } };
        }
        const { reservation: _r, ...bare } = r;
        return bare;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        writes.push(`resourceReturn.update ${where.id} ${data.status}`);
        return { id: where.id, ...data };
      }),
    },
  };
  const svc = new ResourceReturnsService(prisma, {} as any, new ResourceWorkspaceService(prisma), {} as any);
  const controller = new ResourceReturnsController(svc, {} as any);
  return { controller, rows, writes };
}

it('sits beside PATCH :id/cancel, behind the same guard', () => {
  const proto = ResourceReturnsController.prototype as any;
  expect(Reflect.getMetadata(PATH_METADATA, proto.preflightCancel)).toBe(':id/preflight/cancel');
  expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.preflightCancel)).toEqual(Reflect.getMetadata(PERMISSIONS_KEY, proto.cancel));
});

it.each([
  ['one\'s own, pending', 1],
  ['one\'s own, already received', 2],
  ['one that does not exist', 404],
])('%s: the preflight answers as the mutation does', async (_, id) => {
  expect(await outcome(() => world().controller.preflightCancel(id, actor(ME)))).toBe(await outcome(() => world().controller.cancel(String(id), actor(ME))));
});

it('answers the return as the card shows it, pinned to its updatedAt; writes nothing', async () => {
  const w = world();
  const answer = await w.controller.preflightCancel(1, actor(ME));
  expect(answer).toMatchObject({ ...PREFLIGHT_OK, from: 'PENDING', to: 'CANCELLED' });
  expect(answer.return).toEqual({
    id: 1,
    item: { id: 5, name: 'Ցեմենտ M400', unit: 'KG' },
    quantity: 4,
    notes: 'Ավելացել է',
    taskId: 2451,
    projectName: 'ՏՏ',
    requestedAt: T0.toISOString(),
    material: { returnId: 1, status: 'PENDING', quantity: 4, requestedBy: ME, updatedAt: T0.toISOString() },
  });
  expect(w.writes).toEqual([]);
});

it('own only: a colleague on the requesting side, or warehouse staff, stay on the screen', async () => {
  expect(await outcome(() => world().controller.cancel('3', actor(ME)))).toBe('ok');
  expect(await outcome(() => world().controller.preflightCancel(3, actor(ME)))).toMatch(/^403 /);
  const keeper = actor(KEEPER, { permissionNames: ['manage_resource_returns'] });
  expect(await outcome(() => world().controller.cancel('1', keeper))).toBe('ok');
  expect(await outcome(() => world().controller.preflightCancel(1, keeper))).toMatch(/^403 /);
});

it('one workspace: a return asked for by another company reads as not found', async () => {
  const both = actor(ME, { home: { wildcard: false, entityIds: [ENTITY, OTHER] } });
  expect(await outcome(() => world().controller.preflightCancel(4, both))).toMatch(/^404 /);
  expect(await outcome(() => world().controller.preflightCancel(4, { ...both, declared: OTHER }))).toBe('ok');
});

it('a yes grants nothing: received in between, the mutation refuses', async () => {
  const w = world();
  expect(await outcome(() => w.controller.preflightCancel(1, actor(ME)))).toBe('ok');
  w.rows[0].status = 'RECEIVED';
  expect(await outcome(() => w.controller.cancel('1', actor(ME)))).toMatch(/^400 /);
});
