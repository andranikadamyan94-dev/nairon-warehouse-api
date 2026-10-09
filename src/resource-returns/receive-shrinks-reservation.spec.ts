import { ResourceReturnsService } from './resource-returns.service';

/**
 * REQ-1105 (2026-10-09): receiving a goods return must WRITE the shrunken
 * reservation — quantity, acceptedQuantity and status — not only compute it.
 * Since the 09-15 integration the patch was computed and dropped: a line of 3
 * with 1 returned stayed «3 requested», so the request page's «Ստացել եմ»
 * sent 3 (400: only 2 issued) while the task block offered nothing.
 *
 * Reservation 363: 3 requested, 3 issued (one allocation row), nothing yet
 * accepted; return #8 brings 1 back.
 */
function harness(reservation: { quantity: number; acceptedQuantity: number; status: string; warehouseId?: number | null }) {
  const writes: any[] = [];
  const tx: any = {
    $queryRawUnsafe: jest.fn(async () => [{ id: 363 }]),
    $executeRaw: jest.fn(async () => 1),
    reservationAllocation: {
      aggregate: jest.fn(async () => ({ _sum: { quantity: 3 } })),
      findMany: jest.fn(async () => [{ id: 281, quantity: 3, releasedAt: null }]),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
    },
    reservationAllocationHistory: { create: jest.fn(async () => ({})) },
    warehouseStock: { upsert: jest.fn(async () => ({})) },
    item: { update: jest.fn(async () => ({})), findUnique: jest.fn(async () => ({ unitCost: null })) },
    inventoryMovement: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
    resourceReservation: { update: jest.fn(async (args: any) => { writes.push(args); return {}; }) },
    reservationStatusHistory: { create: jest.fn(async (args: any) => { writes.push({ history: args.data }); return {}; }) },
    resourceReturn: { update: jest.fn(async (args: any) => ({ id: 8, ...args.data })) },
  };
  const ret = {
    id: 8,
    status: 'PENDING',
    quantity: 1,
    reservationId: 363,
    requestedBy: 51,
    reservation: { id: 363, itemId: 9, taskId: 2335, warehouseId: null, item: { id: 9, name: 'Ցեմենտ', type: 'CONSUMABLE' }, ...reservation },
  };
  const prisma: any = {
    resourceReturn: { findUnique: jest.fn(async () => ret) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const stockAlerts: any = { check: jest.fn() };
  const svc = new ResourceReturnsService(prisma, stockAlerts, {} as any, {} as any);
  return { svc, tx, writes };
}

describe('PATCH /resource-returns/:id/receive — the reservation shrinks by what came back', () => {
  it('3 issued, none accepted, 1 returned → the line is 2 requested, 2 out, still ALLOCATED (receipt now confirms 2)', async () => {
    const { svc, tx, writes } = harness({ quantity: 3, acceptedQuantity: 0, status: 'ALLOCATED' });
    await svc.receive(8, 1);
    expect(tx.resourceReservation.update).toHaveBeenCalledWith({
      where: { id: 363 },
      data: { quantity: 2, acceptedQuantity: 0, status: 'ALLOCATED' },
    });
    // status unchanged → no history row
    expect(writes.some((w) => w.history)).toBe(false);
    expect(tx.resourceReturn.update).toHaveBeenCalled();
  });

  it('3 issued, 2 accepted, 1 returned → 2 requested, 2 accepted: the line COMPLETES and the change is in the history', async () => {
    const { svc, tx, writes } = harness({ quantity: 3, acceptedQuantity: 2, status: 'ALLOCATED' });
    await svc.receive(8, 1);
    expect(tx.resourceReservation.update).toHaveBeenCalledWith({
      where: { id: 363 },
      data: { quantity: 2, acceptedQuantity: 2, status: 'COMPLETED' },
    });
    const history = writes.find((w) => w.history)?.history;
    expect(history).toMatchObject({ reservationId: 363, fromStatus: 'ALLOCATED', toStatus: 'COMPLETED', previousQuantity: 3, newQuantity: 2, performedBy: 1 });
    expect(history.reason).toContain('#8');
  });

  it('the whole line returned → COMPLETED with 0 requested', async () => {
    const { svc, tx } = harness({ quantity: 1, acceptedQuantity: 0, status: 'ALLOCATED' });
    tx.reservationAllocation.aggregate.mockResolvedValue({ _sum: { quantity: 1 } });
    tx.reservationAllocation.findMany.mockResolvedValue([{ id: 281, quantity: 1, releasedAt: null }]);
    await svc.receive(8, 1);
    expect(tx.resourceReservation.update).toHaveBeenCalledWith({
      where: { id: 363 },
      data: { quantity: 0, acceptedQuantity: 0, status: 'COMPLETED' },
    });
  });
});
