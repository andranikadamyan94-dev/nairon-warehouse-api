import { BadRequestException } from '@nestjs/common';

import { ReservationsController } from './reservations.controller';
import { CATALOG_DECISION_REFUSAL, ReservationsService } from './reservations.service';

/**
 * 2026-10-08 (owner): a reservation the catalog filed (submissionId set) is
 * decided in «Ապրանքների հարցումներ» → «Հաստատում», not on the reservation
 * list. The reservation ROUTES that decide — approve, reject, allocate —
 * refuse such a row with a 400 that says where to go; task / object rows
 * pass as before. The catalog service calls the same service methods
 * directly, so the guard lives on the routes and never inside the methods.
 */

const CATALOG_ROW = 41; // submissionId = 7
const TASK_ROW = 42; // taskId = 5, no submission

function build() {
  const rows = new Map<number, { id: number; submissionId: number | null }>([
    [CATALOG_ROW, { id: CATALOG_ROW, submissionId: 7 }],
    [TASK_ROW, { id: TASK_ROW, submissionId: null }],
  ]);
  const db: any = {
    resourceReservation: {
      findFirst: jest.fn(async ({ where }: any) => {
        const ids: number[] = where?.id?.in ?? [];
        const wantsCatalog = where?.submissionId?.not === null;
        const hit = ids.map((id) => rows.get(id)).find((r) => r && (!wantsCatalog || r.submissionId != null));
        return hit ? { id: hit.id } : null;
      }),
    },
  };
  const svc = new ReservationsService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const approve = jest.spyOn(svc, 'approveConsumable').mockResolvedValue('approved' as any);
  const reject = jest.spyOn(svc, 'reject').mockResolvedValue('rejected' as any);
  const allocate = jest.spyOn(svc, 'allocate').mockResolvedValue('allocated' as any);
  const controller = new ReservationsController(svc, {} as any);
  return { controller, svc, approve, reject, allocate };
}

const actor = { userId: 3, isAdmin: false, permissions: ['manage_reservations'] } as any;

describe('reservation routes refuse to decide a catalog-origin row', () => {
  it('PATCH :id/approve on a catalog row → 400 with the Armenian pointer; the service is not reached', async () => {
    const { controller, approve } = build();
    const call = controller.approveConsumable(String(CATALOG_ROW), 3, actor, { quantity: 1 });
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.approveConsumable(String(CATALOG_ROW), 3, actor, {})).rejects.toThrow(CATALOG_DECISION_REFUSAL);
    expect(approve).not.toHaveBeenCalled();
  });

  it('PATCH :id/reject on a catalog row → 400; the service is not reached', async () => {
    const { controller, reject } = build();
    await expect(controller.reject(String(CATALOG_ROW), { reason: 'no' }, actor)).rejects.toThrow(CATALOG_DECISION_REFUSAL);
    expect(reject).not.toHaveBeenCalled();
  });

  it('POST allocate naming a catalog row (even next to a task row) → 400; nothing is allocated', async () => {
    const { controller, allocate } = build();
    const dto = { allocations: [{ reservationId: TASK_ROW, assetId: 1 }, { reservationId: CATALOG_ROW, assetId: 2 }] };
    await expect(controller.allocate(dto as any, 3)).rejects.toThrow(CATALOG_DECISION_REFUSAL);
    expect(allocate).not.toHaveBeenCalled();
  });

  it('the refusal says where the decision is made', () => {
    expect(CATALOG_DECISION_REFUSAL).toBe('Կատալոգի հարցումը հաստատվում է «Ապրանքների հարցումներ» → «Հաստատում» բաժնում');
  });

  it('task rows pass through all three routes unchanged', async () => {
    const { controller, approve, reject, allocate } = build();
    await expect(controller.approveConsumable(String(TASK_ROW), 3, actor, { quantity: 2 })).resolves.toBe('approved');
    expect(approve).toHaveBeenCalledWith(TASK_ROW, 3, 2, actor);
    await expect(controller.reject(String(TASK_ROW), { reason: 'r' }, actor)).resolves.toBe('rejected');
    expect(reject).toHaveBeenCalledWith(TASK_ROW, 3, 'r', actor);
    const dto = { allocations: [{ reservationId: TASK_ROW, assetId: 1 }] };
    await expect(controller.allocate(dto as any, 3)).resolves.toBe('allocated');
    expect(allocate).toHaveBeenCalledWith(dto, 3);
  });

  it('the catalog\'s own calls are not guarded: the service methods never ask the route question', () => {
    // catalog.service calls reservations.approveConsumable / allocate / reject
    // directly ({ quiet: true }); the guard must stay out of those methods.
    for (const m of ['approveConsumable', 'allocate', 'reject'] as const) {
      expect(String((ReservationsService.prototype as any)[m])).not.toContain('assertNotCatalogDecision');
    }
  });

  it('an empty or malformed id list asks nothing', async () => {
    const { svc } = build();
    await expect(svc.assertNotCatalogDecision([])).resolves.toBeUndefined();
    await expect(svc.assertNotCatalogDecision([NaN, 0, -1])).resolves.toBeUndefined();
    expect((svc as any).prisma.resourceReservation.findFirst).not.toHaveBeenCalled();
  });
});

describe('«Տրված» on the reservation list (the former «Հատկացումներ» page)', () => {
  it('status=ISSUED lists ALLOCATED and PARTIALLY_ALLOCATED rows', async () => {
    const seen: any[] = [];
    const db: any = { resourceReservation: { findMany: async ({ where }: any) => { seen.push(where); return []; } } };
    const svc = new ReservationsService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await svc.getAll({ status: 'ISSUED', groupByTask: '1' });
    expect(seen[0].status).toEqual({ in: ['ALLOCATED', 'PARTIALLY_ALLOCATED'] });
  });
});
