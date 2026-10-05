import { NotFoundException } from '@nestjs/common';

import { AllocationsService } from './allocations.service';
import { AllocationsController } from './allocations.controller';
import { ReservationsService } from '../reservations/reservations.service';
import { WarehouseActor } from '../auth/actor';

/**
 * GET /allocations/:id (org sweep 2026-10-02, hole 7). It returned any
 * allocation with its reservation, skipping the read rule GET /reservations/:id
 * applies (assertMayRead). Now it is the same rule, on the allocation's
 * reservation — asked of the very same ReservationsService.
 *
 * Allocation 70 belongs to reservation 8 (task 12, requested by organisation
 * 3). Person 32 is on task 12.
 */
const ON_TASK = new Set([32]);

const build = () => {
  const reservationRow = { id: 8, taskId: 12, requesterWorkspaceId: 3, item: { id: 5, category: { entityId: null } } };
  const prisma: any = {
    resourceReservation: { findUnique: jest.fn(async ({ where }: any) => (where.id === 8 ? reservationRow : null)) },
    reservationAllocation: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 70 ? { id: 70, reservationId: 8, quantity: 1, asset: { serialNumber: 'SN-1' }, reservation: reservationRow } : null,
      ),
      aggregate: async () => ({ _sum: { quantity: 0 } }),
    },
    resourceReturn: { aggregate: async () => ({ _sum: { quantity: 0 } }) },
    purchaseRequisitionLine: { findMany: async () => [] },
  };
  const workspaces: any = { partiesOfReservation: async () => ({ requester: 3, stockOwner: null }) };
  const reservations = new ReservationsService(prisma, {} as any, {} as any, {} as any, {} as any, workspaces, {} as any);
  // CRM's internal task route, stood in: task 12 and its Կատարող slots.
  jest.spyOn(reservations as any, 'crmTask').mockImplementation(async () => ({
    id: 12,
    createdById: 0,
    executors: [...ON_TASK].map((id) => ({ id })),
    acceptors: [],
    responsibles: [],
  }));
  const allocations = new AllocationsService(prisma, {} as any, reservations);
  return { controller: new AllocationsController(allocations), allocations, reservations, prisma };
};

const actor = (over: Partial<WarehouseActor> = {}): WarehouseActor => ({
  userId: 50,
  isSuperAdmin: false,
  readOnly: false,
  isGlobalSuperAdmin: false,
  permissionNames: [],
  home: { wildcard: false, entityIds: [9] },
  declared: 9,
  ...over,
});

const CASES: [string, WarehouseActor, boolean][] = [
  ['an outsider: other organisation, not on the task, no warehouse right', actor(), false],
  ["the requester's people", actor({ home: { wildcard: false, entityIds: [3] }, declared: 3 }), true],
  ['a person on the task', actor({ userId: 32 }), true],
  ['warehouse staff (view_reservations)', actor({ permissionNames: ['view_reservations'] }), true],
  ['warehouse staff (manage_warehouse)', actor({ permissionNames: ['manage_warehouse'] }), true],
  ['a super admin', actor({ isSuperAdmin: true }), true],
];

describe('GET /allocations/:id — the reservation read rule', () => {
  it.each(CASES)('%s: as GET /reservations/:id answers', async (_who, who, allowed) => {
    const { controller, reservations } = build();
    const viaReservation = await reservations.getOne(8, who).then(() => true, () => false);
    const viaAllocation = await controller.getOne(70, who).then(() => true, () => false);
    expect(viaReservation).toBe(allowed);
    expect(viaAllocation).toBe(allowed);
  });

  it('refuses an outsider with not found, and says allocation, not reservation', async () => {
    const { controller } = build();
    const refused = await controller.getOne(70, actor()).catch((e) => e);
    const missing = await controller.getOne(71, actor()).catch((e) => e);
    expect(refused).toBeInstanceOf(NotFoundException);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(refused.message).toBe(missing.message);
    expect(refused.message).toBe('Հատկացումը չի գտնվել');
  });

  it('a missing allocation is a 404, no longer an empty 200', async () => {
    const { controller } = build();
    await expect(controller.getOne(71, actor({ isSuperAdmin: true }))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the allocation itself to someone the rule admits', async () => {
    const { controller } = build();
    await expect(controller.getOne(70, actor({ userId: 32 }))).resolves.toMatchObject({ id: 70, reservationId: 8 });
  });
});
