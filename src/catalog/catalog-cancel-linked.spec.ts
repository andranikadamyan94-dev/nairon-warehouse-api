import { Logger } from '@nestjs/common';

import { CatalogService } from './catalog.service';

/**
 * Cancelling a request cancels what was raised for it (2026-10-14). Since the
 * keeper's shortfall «Գնման հայտ» is linked to the request (611125d), the
 * requester's «Չեղարկել» withdraws every linked requisition procurement has not
 * acted on yet — quietly, the cancelled request being the one notice — and
 * leaves one that is already ordered, telling procurement once that the
 * request behind it is gone.
 */

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

const REQUESTER = 8;
const KEEPER = 40;
const BUYER = 50;
const at = (s: string) => new Date(s);
const actor: any = { userId: REQUESTER, isSuperAdmin: false, isGlobalSuperAdmin: false, readOnly: false, permissionNames: ['page_warehouse'], home: { wildcard: false, entityIds: [1] }, declared: 1 };

const blank = { decidedBy: null, decidedAt: null, reviewedAt: null, rejectionStage: null, rejectionReason: null, rejectionRequestedBy: null, rejectionRequestedAt: null, rejectionConfirmedBy: null, rejectionConfirmedAt: null, rejectionDeclineNote: null, comments: [] };

/** REQ-1005: 9 kg of cement the shelf could not cover (reservation 705, still PENDING) and the keeper's requisition #303 for it. */
function world(shortfallStatus: string, opts: { own?: string } = {}) {
  const sub = { id: 5, number: 'REQ-1005', createdBy: REQUESTER, entityId: 1, objectId: null, taskId: null, projectId: null, purpose: 'Հիմք', neededBy: at('2099-12-01'), createdAt: at('2026-10-14T08:00:00Z'), cancelledAt: null, infoRequestAt: null, reminders: [] };
  const rows = [
    { id: 705, submissionId: 5, itemId: 7, quantity: 9, status: 'PENDING', acceptedQuantity: 0, warehouseId: null, warehouse: null, startDate: at('2026-10-14'), endDate: at('2099-12-01'),
      item: { id: 7, name: 'Ցեմենտ', unit: 'KG', code: 'C-7', variantLabel: null, type: 'CONSUMABLE' }, allocations: [], allocationHistory: [], statusHistory: [] },
  ];
  const requisitions: any[] = [
    { id: 303, submissionId: 5, entityId: 1, status: shortfallStatus, createdBy: KEEPER, reviewedBy: shortfallStatus === 'APPROVED' ? BUYER : null, ...blank,
      lines: [{ id: 3031, itemId: 7, itemName: 'Ցեմենտ', quantity: 9, unit: 'KG', code: 'C-7', reservationId: 705, item: { id: 7, name: 'Ցեմենտ', unit: 'KG', code: 'C-7', variantLabel: null } }] },
  ];
  if (opts.own) {
    // The catalog's own requisition for a line outside the catalogue, filed by the requester.
    requisitions.push({ id: 304, submissionId: 5, entityId: 1, status: opts.own, createdBy: REQUESTER, reviewedBy: null, ...blank,
      lines: [{ id: 3041, itemId: null, itemName: 'Գայլիկոն', quantity: 1, unit: 'PIECE', code: null, reservationId: null, item: null }] });
  }
  const prisma: any = {
    catalogSubmission: {
      findMany: jest.fn(async () => [sub]),
      update: jest.fn(async ({ data }: any) => Object.assign(sub, data)),
    },
    resourceReservation: { findMany: jest.fn(async () => rows) },
    purchaseRequisition: { findMany: jest.fn(async () => requisitions) },
  };
  const reservations: any = { cancel: jest.fn(async () => undefined) };
  const reqs: any = { cancel: jest.fn(async (id: number) => { requisitions.find((r) => r.id === id).status = 'CANCELLED'; }) };
  const notifications = { send: jest.fn(async (_n: any) => undefined), audience: jest.fn(async () => []) };
  const svc = new CatalogService(prisma, {} as any, reservations, reqs, {} as any, {} as any, notifications as any, undefined, undefined);
  jest.spyOn(svc, 'getOne').mockResolvedValue({ id: 5 } as any);
  return { svc, sub, requisitions, reservations, reqs, notifications };
}

describe('cancel — the requisitions linked to the request', () => {
  it.each(['DRAFT', 'PENDING_APPROVAL', 'SUBMITTED', 'IN_REVIEW'])('a %s shortfall requisition is cancelled quietly, the keeper\'s though it is', async (status) => {
    const w = world(status);
    await w.svc.cancel(5, REQUESTER, actor);
    // The requester did not file it: the request's ownership stands in (isSuperAdmin=true), and no notice of its own.
    expect(w.reqs.cancel).toHaveBeenCalledWith(303, REQUESTER, true, { quiet: true });
    expect(w.requisitions[0].status).toBe('CANCELLED');
    // Without the actor: the request's ownership is the check, not the reservation's two-party rule.
    expect(w.reservations.cancel).toHaveBeenCalledWith(705, REQUESTER, expect.any(String), undefined, { quiet: true });
    expect(w.sub.cancelledAt).toBeInstanceOf(Date);
    // One notice — the desk's «Կատալոգի հարցումը չեղարկվել է»; procurement hears nothing.
    expect(w.notifications.send).toHaveBeenCalledTimes(1);
    expect(w.notifications.send.mock.calls[0][0].title).toBe('Կատալոգի հարցումը չեղարկվել է');
  });

  it('an APPROVED (ordered) shortfall requisition stays, and procurement hears once, with a link to it', async () => {
    const w = world('APPROVED');
    await w.svc.cancel(5, REQUESTER, actor);
    expect(w.reqs.cancel).not.toHaveBeenCalled();
    expect(w.requisitions[0].status).toBe('APPROVED');
    expect(w.sub.cancelledAt).toBeInstanceOf(Date);
    const toProcurement = w.notifications.send.mock.calls.map((c) => c[0]).filter((n) => n.permissions?.includes('manage_procurement'));
    expect(toProcurement).toHaveLength(1);
    expect(toProcurement[0]).toMatchObject({
      type: 'warehouse.requisition_cancelled',
      entityIds: [1],
      userIds: [BUYER],
      actorId: REQUESTER,
      title: 'Գնման հայտի հարցումը չեղարկվել է',
      path: '/procurement?tab=requisitions&requisition=303',
    });
    expect(toProcurement[0].body).toContain('#303');
    expect(toProcurement[0].body).toContain('REQ-1005');
    expect(toProcurement[0].body).toContain('պատվիրված');
    // The desk still hears of the cancelled request itself.
    expect(w.notifications.send).toHaveBeenCalledTimes(2);
  });

  it('a FULFILLED one stays too and procurement is told it was already received', async () => {
    const w = world('FULFILLED');
    await w.svc.cancel(5, REQUESTER, actor);
    expect(w.reqs.cancel).not.toHaveBeenCalled();
    const n = w.notifications.send.mock.calls.map((c) => c[0]).find((x) => x.permissions?.includes('manage_procurement'));
    expect(n.body).toContain('ստացված');
  });

  it.each(['REJECTED', 'CANCELLED'])('a %s one is left alone, nobody told', async (status) => {
    const w = world(status);
    await w.svc.cancel(5, REQUESTER, actor);
    expect(w.reqs.cancel).not.toHaveBeenCalled();
    expect(w.notifications.send).toHaveBeenCalledTimes(1);
  });

  it('the catalog\'s own requisition and the keeper\'s shortfall are both withdrawn', async () => {
    const w = world('SUBMITTED', { own: 'PENDING_APPROVAL' });
    await w.svc.cancel(5, REQUESTER, actor);
    // The requester's own goes through as theirs; only the keeper's needs the request's ownership.
    expect(w.reqs.cancel.mock.calls.map((c: any[]) => [c[0], c[2]]).sort()).toEqual([[303, true], [304, false]]);
    expect(w.requisitions.every((r) => r.status === 'CANCELLED')).toBe(true);
  });

  it('a pending own requisition is withdrawn while an ordered shortfall stays and is announced', async () => {
    const w = world('APPROVED', { own: 'PENDING_APPROVAL' });
    await w.svc.cancel(5, REQUESTER, actor);
    expect(w.reqs.cancel).toHaveBeenCalledTimes(1);
    expect(w.reqs.cancel).toHaveBeenCalledWith(304, REQUESTER, false, { quiet: true });
    expect(w.notifications.send.mock.calls.filter((c) => c[0].permissions?.includes('manage_procurement'))).toHaveLength(1);
  });

  it('only the requester cancels', async () => {
    const w = world('SUBMITTED');
    await expect(w.svc.cancel(5, KEEPER, { ...actor, userId: KEEPER })).rejects.toThrow('Հարցումը կարող է չեղարկել միայն ներկայացնողը');
    expect(w.reqs.cancel).not.toHaveBeenCalled();
  });
});
