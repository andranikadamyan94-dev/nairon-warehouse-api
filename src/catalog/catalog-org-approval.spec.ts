import { Logger } from '@nestjs/common';

import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { CatalogController } from './catalog.controller';
import { CatalogService, KEEPER_VIEWER_PERMISSIONS, ORG_DESK_FILTER, ORG_DESK_PERMISSIONS, QUEUE_VIEWER_PERMISSIONS } from './catalog.service';

/**
 * The organisation approval inside the queue (owner 2026-10-12): the purchase
 * requisition a catalog checkout raises is decided by approve_purchase_requisition
 * — and its rejection confirmed by confirm_requisition_rejection — on the
 * purchase line of «Հաստատում», not on the CRM «Գնման հայտեր» page. This spec
 * holds: who opens the queue now, the «Գնման հաստատում» filter
 * (status=PURCHASE_APPROVAL), what the desk alone sees, and what a purchase
 * line says and carries at each organisation stage.
 */

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const KEEPER = 40; // manage_reservations
const APPROVER = 43; // approve_purchase_requisition only
const CONFIRMER = 44; // confirm_requisition_rejection only
const BOTH_DESKS = 45; // view_catalog_requests + approve_purchase_requisition
const PERMS: Record<number, string[]> = {
  [KEEPER]: ['page_warehouse', 'manage_reservations'],
  [APPROVER]: ['page_warehouse', 'approve_purchase_requisition'],
  [CONFIRMER]: ['page_warehouse', 'confirm_requisition_rejection'],
  [BOTH_DESKS]: ['page_warehouse', 'view_catalog_requests', 'approve_purchase_requisition'],
};
const actor = (userId: number): any => ({
  userId,
  isSuperAdmin: false,
  isGlobalSuperAdmin: false,
  readOnly: false,
  permissionNames: PERMS[userId] ?? [],
  home: { wildcard: false, entityIds: [1] },
  declared: 1,
});

const at = (s: string) => new Date(s);

/**
 * Four requests: one whose purchase line waits for the organisation, one
 * whose rejection waits for confirmation, one already with procurement, and a
 * stock-only one nobody has handed out.
 */
function world(opts: { shortfall?: boolean } = {}) {
  const subs: any[] = [
    { id: 1, number: 'REQ-1001', createdBy: 7, entityId: 1, objectId: null, taskId: null, projectId: null, purpose: 'Գրասենյակ', neededBy: at('2099-12-01'), createdAt: at('2026-10-12T08:00:00Z'), cancelledAt: null, reminders: [] },
    { id: 2, number: 'REQ-1002', createdBy: 7, entityId: 1, objectId: null, taskId: null, projectId: null, purpose: 'Ներկ', neededBy: at('2099-12-01'), createdAt: at('2026-10-12T09:00:00Z'), cancelledAt: null, reminders: [] },
    { id: 3, number: 'REQ-1003', createdBy: 8, entityId: 1, objectId: null, taskId: null, projectId: null, purpose: 'Գործիքներ', neededBy: at('2099-12-01'), createdAt: at('2026-10-12T10:00:00Z'), cancelledAt: null, reminders: [] },
    { id: 4, number: 'REQ-1004', createdBy: 8, entityId: 1, objectId: null, taskId: null, projectId: null, purpose: 'Ցեմենտ', neededBy: at('2099-12-01'), createdAt: at('2026-10-12T11:00:00Z'), cancelledAt: null, reminders: [] },
  ];
  const rows: any[] = [
    // REQ-1001 also asked for cement the shelf covers: the keeper's line, untouched.
    { id: 700, submissionId: 1, itemId: 7, quantity: 2, status: 'APPROVED', acceptedQuantity: 0, warehouseId: null, warehouse: null, startDate: at('2026-10-12'), endDate: at('2099-12-01'),
      item: { id: 7, name: 'Ցեմենտ', unit: 'KG', code: 'C-7', variantLabel: null, type: 'CONSUMABLE' }, allocations: [], allocationHistory: [], statusHistory: [] },
    { id: 704, submissionId: 4, itemId: 7, quantity: 5, status: 'APPROVED', acceptedQuantity: 0, warehouseId: null, warehouse: null, startDate: at('2026-10-12'), endDate: at('2099-12-01'),
      item: { id: 7, name: 'Ցեմենտ', unit: 'KG', code: 'C-7', variantLabel: null, type: 'CONSUMABLE' }, allocations: [], allocationHistory: [], statusHistory: [] },
  ];
  const requisitions: any[] = [
    { id: 300, submissionId: 1, entityId: 1, status: 'PENDING_APPROVAL', createdBy: 7, decidedBy: null, decidedAt: null, reviewedBy: null, reviewedAt: null,
      rejectionStage: null, rejectionReason: null, rejectionRequestedBy: null, rejectionRequestedAt: null, rejectionConfirmedBy: null, rejectionConfirmedAt: null, rejectionDeclineNote: null,
      comments: [], lines: [{ id: 3001, itemId: 8, itemName: 'Ներկ', quantity: 3, unit: 'LITER', code: null, item: { id: 8, name: 'Ներկ', unit: 'LITER', code: 'P-8', variantLabel: null } }] },
    { id: 301, submissionId: 2, entityId: 1, status: 'REJECTION_PENDING', createdBy: 7, decidedBy: null, decidedAt: null, reviewedBy: null, reviewedAt: null,
      rejectionStage: 'ORG', rejectionReason: 'Բյուջեն սպառված է', rejectionRequestedBy: APPROVER, rejectionRequestedAt: at('2026-10-12T09:30:00Z'), rejectionConfirmedBy: null, rejectionConfirmedAt: null, rejectionDeclineNote: null,
      comments: [], lines: [{ id: 3011, itemId: 8, itemName: 'Ներկ', quantity: 1, unit: 'LITER', code: null, item: { id: 8, name: 'Ներկ', unit: 'LITER', code: 'P-8', variantLabel: null } }] },
    { id: 302, submissionId: 3, entityId: 1, status: 'SUBMITTED', createdBy: 8, decidedBy: APPROVER, decidedAt: at('2026-10-12T10:30:00Z'), reviewedBy: null, reviewedAt: null,
      rejectionStage: null, rejectionReason: null, rejectionRequestedBy: null, rejectionRequestedAt: null, rejectionConfirmedBy: CONFIRMER, rejectionConfirmedAt: at('2026-10-12T10:20:00Z'), rejectionDeclineNote: 'Գնումն անհրաժեշտ է',
      comments: [], lines: [{ id: 3021, itemId: null, itemName: 'Գայլիկոն', quantity: 1, unit: 'PIECE', code: null, item: null }] },
  ];
  // The queue's database filter («Գնման հաստատում»: where.requisitions) as Prisma would apply it.
  const matches = (s: any, where: any): boolean => {
    if (where?.id != null) {
      if (typeof where.id === 'object' && Array.isArray(where.id.in)) {
        if (!where.id.in.includes(s.id)) return false;
      } else if (s.id !== where.id) return false;
    }
    const some = where?.requisitions?.some;
    if (some && !requisitions.some((r) => r.submissionId === s.id && some.status.in.includes(r.status) && r.lines.length > 0)) return false;
    return true;
  };
  if (opts.shortfall) {
    // 2026-10-14: REQ-1005 asked for 9 kg of cement the shelf could not cover; the keeper raised «Գնման հայտ»
    // #303 for the 9 (its line carries the reservation), linked to the request — it waits for the organisation.
    subs.push({ id: 5, number: 'REQ-1005', createdBy: 8, entityId: 1, objectId: null, taskId: null, projectId: null, purpose: 'Հիմք', neededBy: at('2099-12-01'), createdAt: at('2026-10-12T12:00:00Z'), cancelledAt: null, reminders: [] });
    rows.push({ id: 705, submissionId: 5, itemId: 7, quantity: 9, status: 'PENDING', acceptedQuantity: 0, warehouseId: null, warehouse: null, startDate: at('2026-10-12'), endDate: at('2099-12-01'),
      item: { id: 7, name: 'Ցեմենտ', unit: 'KG', code: 'C-7', variantLabel: null, type: 'CONSUMABLE' }, allocations: [], allocationHistory: [], statusHistory: [] });
    requisitions.push({ id: 303, submissionId: 5, entityId: 1, status: 'PENDING_APPROVAL', createdBy: KEEPER, createdAt: at('2026-10-12T12:30:00Z'), decidedBy: null, decidedAt: null, reviewedBy: null, reviewedAt: null,
      rejectionStage: null, rejectionReason: null, rejectionRequestedBy: null, rejectionRequestedAt: null, rejectionConfirmedBy: null, rejectionConfirmedAt: null, rejectionDeclineNote: null,
      comments: [], lines: [{ id: 3031, itemId: 7, itemName: 'Ցեմենտ', quantity: 9, unit: 'KG', code: 'C-7', reservationId: 705, item: { id: 7, name: 'Ցեմենտ', unit: 'KG', code: 'C-7', variantLabel: null } }] });
  }
  const prisma: any = {
    catalogSubmission: {
      // Newest first, as the service orders; the page cut as the queue asks for it.
      findMany: jest.fn(async ({ where, skip, take }: any) => {
        let list = subs.filter((s) => matches(s, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (skip) list = list.slice(skip);
        if (take != null) list = list.slice(0, take);
        return list;
      }),
      count: jest.fn(async ({ where }: any) => subs.filter((s) => matches(s, where)).length),
      findUnique: jest.fn(async ({ where }: any) => subs.find((s) => s.id === where.id) ?? null),
    },
    resourceReservation: { findMany: jest.fn(async ({ where }: any) => (where?.submissionId ? rows.filter((r) => where.submissionId.in.includes(r.submissionId)) : [])) },
    purchaseRequisition: { findMany: jest.fn(async ({ where }: any) => requisitions.filter((r) => where.submissionId.in.includes(r.submissionId))) },
    warehouseStock: { findMany: jest.fn(async () => []) },
    asset: { groupBy: jest.fn(async () => []) },
  };
  const users: any = {
    getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id, firstName: 'Ա', lastName: `${id}` }))),
    getUserAccessInfo: jest.fn(async (userId: number) => ({ isSuperAdmin: false, permissionNames: PERMS[userId] ?? [] })),
  };
  const reservations: any = { requisitionsFor: jest.fn(async () => new Map()) };
  const notifications = { send: jest.fn(async (_n: any) => undefined), audience: jest.fn(async () => []) };
  const svc = new CatalogService(prisma, users, reservations, {} as any, {} as any, {} as any, notifications as any, undefined, undefined);
  (svc as any).directory = jest.fn(async () => ({ unitOf: new Map(), entityName: new Map() }));
  (svc as any).freeStock = jest.fn(async () => new Map([[7, 20], [8, 0]]));
  const controller = new CatalogController(svc);
  return { svc, controller, prisma };
}

describe('who opens the queue', () => {
  it('GET /catalog/submissions admits the keepers, the catalog desk AND the two purchase-desk rights', () => {
    expect(ORG_DESK_PERMISSIONS).toEqual(['approve_purchase_requisition', 'confirm_requisition_rejection']);
    expect(QUEUE_VIEWER_PERMISSIONS).toEqual([...KEEPER_VIEWER_PERMISSIONS, ...ORG_DESK_PERMISSIONS]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, CatalogController.prototype.queue)).toEqual(QUEUE_VIEWER_PERMISSIONS);
  });

  it('an approver or a confirmer reads any request in the queue', async () => {
    const w = world();
    await expect(w.svc.getOne(1, actor(APPROVER))).resolves.toMatchObject({ number: 'REQ-1001' });
    await expect(w.svc.getOne(2, actor(CONFIRMER))).resolves.toMatchObject({ number: 'REQ-1002' });
    expect(w.svc.isOrgDeskOnly(actor(APPROVER))).toBe(true);
    expect(w.svc.isOrgDeskOnly(actor(CONFIRMER))).toBe(true);
    expect(w.svc.isOrgDeskOnly(actor(KEEPER))).toBe(false);
    // The catalog desk's right makes them a full viewer, whatever else they hold.
    expect(w.svc.isOrgDeskOnly(actor(BOTH_DESKS))).toBe(false);
  });
});

describe('the «Գնման հաստատում» filter', () => {
  it('status=PURCHASE_APPROVAL keeps the requests with a purchase line awaiting the organisation or a rejection awaiting confirmation', async () => {
    const w = world();
    const { items, total } = await w.svc.queue({ status: ORG_DESK_FILTER }, actor(KEEPER));
    expect(total).toBe(2);
    expect(items.map((v) => v.number)).toEqual(['REQ-1002', 'REQ-1001']);
    // A database condition (performance audit W2): page and total from the query, no light pass over everything.
    expect(w.prisma.catalogSubmission.count).toHaveBeenCalledWith({ where: { requisitions: { some: { status: { in: ['PENDING_APPROVAL', 'REJECTION_PENDING'] }, lines: { some: {} } } } } });
    expect(w.prisma.resourceReservation.findMany).toHaveBeenCalledTimes(1);
  });

  it('a keeper without the filter sees everything; the desk alone sees only its own rows, whatever status it names', async () => {
    const w = world();
    expect((await w.svc.queue({}, actor(KEEPER))).total).toBe(4);
    // REQ-1003 is with procurement; REQ-1002's rejection awaits confirmation, so since 2026-10-15 (owner) it
    // waits here with the two undecided ones instead of sitting under «Մերժված».
    expect((await w.svc.queue({ status: 'SUBMITTED' }, actor(KEEPER))).items.map((v) => v.number)).toEqual(['REQ-1004', 'REQ-1002', 'REQ-1001']);
    expect((await w.svc.queue({ status: 'REJECTED' }, actor(KEEPER))).items.map((v) => v.number)).not.toContain('REQ-1002');
    expect((await w.svc.queue({}, actor(APPROVER))).items.map((v) => v.number)).toEqual(['REQ-1002', 'REQ-1001']);
    expect((await w.svc.queue({ status: 'SUBMITTED' }, actor(CONFIRMER))).items.map((v) => v.number)).toEqual(['REQ-1002', 'REQ-1001']);
    // Someone holding the catalog desk's right too is not confined to the filter.
    expect((await w.svc.queue({}, actor(BOTH_DESKS))).total).toBe(4);
    // The other filters still narrow the desk's rows.
    expect((await w.svc.queue({ q: 'ներկ' }, actor(APPROVER))).items.map((v) => v.number)).toEqual(['REQ-1002', 'REQ-1001']);
    expect((await w.svc.queue({ q: 'բյուջե' }, actor(APPROVER))).total).toBe(0);
  });
});

describe('what a purchase line says and carries', () => {
  it('awaiting the organisation: «Սպասում է կազմակերպության հաստատման», its requisition on the line; the stock line keeps the keeper’s label', async () => {
    const w = world();
    const view = await w.svc.getOne(1, actor(APPROVER));
    const paint = view.lines.find((l) => l.id === 'l3001')!;
    expect(paint).toMatchObject({ kind: 'PURCHASE', status: 'PENDING_APPROVAL', statusLabel: 'Սպասում է կազմակերպության հաստատման', approvedQuantity: null });
    expect(paint.requisition).toEqual({ id: 300, status: 'PENDING_APPROVAL', entityId: 1, rejectionStage: null, rejectionReason: null, rejectionRequestedBy: null, rejectionDeclineNote: null });
    expect(view.lines.find((l) => l.id === 'r700')!.statusLabel).toBe('Սպասում է որոշման · պահեստում կա');
    expect(view.status).toBe('SUBMITTED');
  });

  it('a rejection awaiting confirmation: «Մերժումը սպասում է հաստատման», with the stage, the reason and who asked for it', async () => {
    const w = world();
    const view = await w.svc.getOne(2, actor(CONFIRMER));
    const line = view.lines[0];
    expect(line).toMatchObject({ kind: 'PURCHASE', status: 'REJECTION_PENDING', statusLabel: 'Մերժումը սպասում է հաստատման', approvedQuantity: 0 });
    expect(line.requisition).toMatchObject({ id: 301, status: 'REJECTION_PENDING', rejectionStage: 'ORG', rejectionReason: 'Բյուջեն սպառված է', rejectionRequestedBy: { id: APPROVER, name: `Ա ${APPROVER}` } });
    // The header (2026-10-14): not «Մերժված» while the rejection waits for confirmation.
    expect(view).toMatchObject({ status: 'REJECTED', rejectionAwaitsConfirmation: true });
    expect((await w.svc.getOne(1, actor(APPROVER))).rejectionAwaitsConfirmation).toBe(false);
    expect(view.timeline.map((t) => t.kind)).toContain('requisition.rejection_requested');
    expect(view.timeline.find((t) => t.kind === 'requisition.rejection_requested')!.text).toBe('Գնման տողերը մերժվել են — Բյուջեն սպառված է');
  });

  it('with procurement after a declined rejection: «Հաստատված՝ գնումների բաժնում», the confirmer’s note kept, the history says the rejection did not stand', async () => {
    const w = world();
    const view = await w.svc.getOne(3, actor(APPROVER));
    const line = view.lines[0];
    expect(line).toMatchObject({ kind: 'NEW', status: 'SUBMITTED', statusLabel: 'Հաստատված՝ գնումների բաժնում' });
    expect(line.requisition).toMatchObject({ id: 302, status: 'SUBMITTED', rejectionRequestedBy: null, rejectionDeclineNote: 'Գնումն անհրաժեշտ է' });
    const declined = view.timeline.find((t) => t.kind === 'requisition.declined')!;
    expect(declined.by).toEqual({ id: CONFIRMER, name: `Ա ${CONFIRMER}` });
    expect(declined.text).toBe('Մերժումը չի հաստատվել, գնումը վերադարձվել է հաստատման — Գնումն անհրաժեշտ է');
    expect(view.timeline.find((t) => t.kind === 'requisition.approved')!.by).toEqual({ id: APPROVER, name: `Ա ${APPROVER}` });
    expect(view.approver).toEqual({ id: APPROVER, name: `Ա ${APPROVER}` });
  });
});

describe('the keeper’s shortfall requisition is part of its request (2026-10-14)', () => {
  it('shows on the request as a purchase line with the organisation desk, and counts for the status', async () => {
    const w = world({ shortfall: true });
    const view = await w.svc.getOne(5, actor(APPROVER));
    expect(view.lines.map((l) => [l.id, l.kind, l.status])).toEqual([['r705', 'STOCK', 'PENDING'], ['l3031', 'PURCHASE', 'PENDING_APPROVAL']]);
    const line = view.lines[1];
    expect(line.statusLabel).toBe('Սպասում է կազմակերպության հաստատման');
    expect(line.requisition).toMatchObject({ id: 303, status: 'PENDING_APPROVAL', entityId: 1, shortfall: true });
    expect(view.status).toBe('SUBMITTED');
    expect(view.timeline.find((t) => t.kind === 'shortfall.raised')).toMatchObject({ by: { id: KEEPER }, text: 'Գնման հայտ #303 (պակասող քանակի համար) ուղարկվել է կազմակերպության հաստատման' });
  });

  it('«Գնման հաստատում» lists the request; the organisation’s desk alone sees it', async () => {
    const w = world({ shortfall: true });
    expect((await w.svc.queue({ status: ORG_DESK_FILTER }, actor(KEEPER))).items.map((v) => v.number)).toEqual(['REQ-1005', 'REQ-1002', 'REQ-1001']);
    expect((await w.svc.queue({}, actor(APPROVER))).items.map((v) => v.number)).toEqual(['REQ-1005', 'REQ-1002', 'REQ-1001']);
  });

  it('the requester may still cancel while it waits, or after procurement ordered it — not edit once it moved', async () => {
    const w = world({ shortfall: true });
    // Waiting for the organisation: the whole request is still the requester's to change.
    expect(await w.svc.getOne(5, actor(8))).toMatchObject({ canEdit: true, canCancel: true });
    // Ordered: «Չեղարկել» stays (cancel() leaves the order and tells procurement), «Խմբագրել» goes.
    const [shortfall] = await w.prisma.purchaseRequisition.findMany({ where: { submissionId: { in: [5] } } });
    Object.assign(shortfall, { status: 'APPROVED', reviewedBy: 50, reviewedAt: at('2026-10-13T09:00:00Z'), decidedBy: APPROVER, decidedAt: at('2026-10-13T08:00:00Z') });
    expect(await w.svc.getOne(5, actor(8))).toMatchObject({ canEdit: false, canCancel: true });
    // Somebody else's request: neither.
    expect(await w.svc.getOne(5, actor(APPROVER))).toMatchObject({ canEdit: false, canCancel: false });
  });

  it('the request’s own decisions never act on it: it is not among the lines approve / reject / info / edit read', async () => {
    const w = world({ shortfall: true });
    const loaded = await (w.svc as any).loadOne(5);
    expect(loaded.requisition).toBeNull();
    expect(loaded.shortfalls.map((q: any) => q.id)).toEqual([303]);
    expect((w.svc as any).linesOf(loaded, new Map()).map((l: any) => l.id)).toEqual(['r705']);
  });
});
