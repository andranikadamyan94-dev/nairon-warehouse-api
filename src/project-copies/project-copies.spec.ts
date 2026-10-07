import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { InternalGuard } from '../auth/guards/internal.guard';
import { FileService } from '../common/file.service';
import { ReservationsService } from '../reservations/reservations.service';
import { ProjectCopiesController } from './project-copies.controller';
import { ProjectCopiesService } from './project-copies.service';
import { copiedAssetRequestStatus, copiedRequisitionStatus, parseCopyBody, shiftDate } from './project-copy.rules';

/**
 * PROJECT DUPLICATE (2026-10-07) — the warehouse half.
 *
 * The real ProjectCopiesService and the real create rule
 * (ReservationsService.statusForCopiedReservation → stillReservable) run
 * against one in-memory store with a transaction that rolls back on throw.
 */

// ─── an in-memory Prisma, just wide enough ──────────────────────────────────

const eq = (a: any, b: any) => (a instanceof Date || b instanceof Date ? +a === +b : a === b);

function matches(row: any, where: any): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries<any>(where)) {
    if (k === 'OR') {
      if (!cond.some((c: any) => matches(row, c))) return false;
      continue;
    }
    if (k === 'requisition') {
      continue;
    }
    const v = row[k];
    if (cond === null) {
      if (v != null) return false;
      continue;
    }
    if (cond instanceof Date || typeof cond !== 'object') {
      if (!eq(v, cond)) return false;
      continue;
    }
    if ('in' in cond && !cond.in.some((x: any) => eq(x, v))) return false;
    if ('notIn' in cond && cond.notIn.some((x: any) => eq(x, v))) return false;
    if ('lte' in cond && !(v != null && v <= cond.lte)) return false;
    if ('gte' in cond && !(v != null && v >= cond.gte)) return false;
    if ('not' in cond && eq(v, cond.not)) return false;
  }
  return true;
}

const DEFAULTS: Record<string, any> = {
  resourceReservation: { acceptedQuantity: 0, acceptanceComment: null, replacedByReservationId: null, submissionId: null, objectId: null, copyJobId: null, notes: null },
  purchaseRequisition: { orderId: null, copyJobId: null },
};

function makeDb(seed: Record<string, any[]>) {
  const state: Record<string, any[]> = {
    item: [], warehouseStock: [], asset: [], warehouseProject: [], objectEstimateLine: [], catalogSubmission: [],
    resourceReservation: [], reservationStatusHistory: [], purchaseRequisition: [], purchaseRequisitionLine: [],
    purchaseRequisitionComment: [], purchaseRequisitionAttachment: [], assetRequest: [], warehouseProjectCopy: [],
    ...JSON.parse(JSON.stringify(seed), (_k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v)),
  };
  let nextId = 10_000;
  let seq = 2000;
  const locks: number[] = [];

  const insert = (table: string, data: any) => {
    const row: any = { ...(DEFAULTS[table] ?? {}), id: nextId++, ...data };
    if (table === 'warehouseProjectCopy') {
      delete row.id;
      if (state.warehouseProjectCopy.some((r) => r.jobId === row.jobId)) {
        throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
      }
    }
    const nested: Record<string, string> = { lines: 'purchaseRequisitionLine', comments: 'purchaseRequisitionComment', attachments: 'purchaseRequisitionAttachment' };
    for (const [key, child] of Object.entries(nested)) {
      if (row[key]?.create) {
        for (const c of row[key].create) insert(child, { ...c, requisitionId: row.id });
        delete row[key];
      }
    }
    state[table].push(row);
    return row;
  };
  const withIncludes = (table: string, row: any, include?: any) => {
    if (!include) return { ...row };
    const out = { ...row };
    if (include.statusHistory) out.statusHistory = state.reservationStatusHistory.filter((h) => h.reservationId === row.id);
    if (include.lines) out.lines = state.purchaseRequisitionLine.filter((x) => x.requisitionId === row.id);
    if (include.comments) out.comments = state.purchaseRequisitionComment.filter((x) => x.requisitionId === row.id);
    if (include.attachments) out.attachments = state.purchaseRequisitionAttachment.filter((x) => x.requisitionId === row.id);
    return out;
  };
  const cascade = (table: string, ids: number[]) => {
    if (table === 'resourceReservation') state.reservationStatusHistory = state.reservationStatusHistory.filter((h) => !ids.includes(h.reservationId));
    if (table === 'purchaseRequisition') {
      for (const t of ['purchaseRequisitionLine', 'purchaseRequisitionComment', 'purchaseRequisitionAttachment']) {
        state[t] = state[t].filter((x) => !ids.includes(x.requisitionId));
      }
    }
  };
  const model = (table: string) => ({
    findMany: async (a: any = {}) => state[table].filter((r) => matches(r, a.where)).map((r) => withIncludes(table, r, a.include)),
    findUnique: async (a: any) => {
      const w = a.where.warehouseId_itemId ?? a.where;
      const r = state[table].find((x) => matches(x, w));
      return r ? withIncludes(table, r, a.include) : null;
    },
    create: async (a: any) => ({ ...insert(table, a.data) }),
    createMany: async (a: any) => {
      for (const d of a.data) insert(table, d);
      return { count: a.data.length };
    },
    update: async (a: any) => {
      const r = state[table].find((x) => matches(x, a.where));
      Object.assign(r, a.data);
      return { ...r };
    },
    updateMany: async (a: any) => {
      const rs = state[table].filter((x) => matches(x, a.where));
      rs.forEach((r) => Object.assign(r, a.data));
      return { count: rs.length };
    },
    deleteMany: async (a: any) => {
      const gone = state[table].filter((x) => matches(x, a.where));
      state[table] = state[table].filter((x) => !gone.includes(x));
      cascade(table, gone.map((g) => g.id));
      return { count: gone.length };
    },
    count: async (a: any = {}) => state[table].filter((r) => matches(r, a.where)).length,
    aggregate: async (a: any) => ({
      _sum: { quantity: state[table].filter((r) => matches(r, a.where)).reduce((s, r) => s + r.quantity, 0) },
    }),
  });
  const db: any = {
    state,
    locks,
    $queryRawUnsafe: async (sql: string, ...values: any[]) => {
      if (sql.includes('FOR UPDATE')) {
        locks.push(values[0]);
        return state.item.some((i) => i.id === values[0]) ? [{ id: values[0] }] : [];
      }
      if (sql.includes('nextval')) return [{ nextval: BigInt(seq++) }];
      throw new Error(`unexpected sql ${sql}`);
    },
    $transaction: async (fn: any) => {
      const snapshot = Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
      try {
        return await fn(db);
      } catch (e) {
        for (const k of Object.keys(state)) state[k] = snapshot[k];
        throw e;
      }
    },
  };
  for (const t of Object.keys(state)) db[t] = model(t);
  return db;
}

// ─── the world ──────────────────────────────────────────────────────────────

const JOB = '0b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const D = (d: string) => `2026-${d}T00:00:00.000Z`;
const res = (id: number, over: any) => ({
  id, itemId: 1, taskId: 501, projectId: 12, projectName: 'Ե-10', entityId: 3, entityName: 'X', requesterWorkspaceId: 3,
  quantity: 4, acceptedQuantity: 0, acceptanceComment: null, status: 'PENDING', warehouseId: null, objectId: 77,
  startDate: D('11-01'), endDate: D('11-10'), notes: null, replacedByReservationId: null, submissionId: null, copyJobId: null,
  ...over,
});

function seed() {
  return {
    item: [
      { id: 1, name: 'Cement', type: 'CONSUMABLE', quantity: 100 },
      { id: 2, name: 'Rebar', type: 'CONSUMABLE', quantity: 5 },
      { id: 3, name: 'Drill', type: 'ASSET', quantity: 0 },
    ],
    asset: [{ id: 1, itemId: 3 }],
    warehouseProject: [{ id: 1, warehouseId: 9, projectId: 12, projectName: 'Ե-10', copyJobId: null }],
    objectEstimateLine: [{ id: 1, objectId: 77, itemId: 1, plannedQuantity: 50, plannedUnitCost: 1000, note: null }],
    catalogSubmission: [
      { id: 1, number: 'REQ-1001', createdBy: 5, entityId: 3, projectId: 12, projectName: 'Ե-10', costCenter: null, purpose: 'p', neededBy: D('11-01'), comment: null, attachmentUrl: '/uploads/a.pdf', infoRequestText: null, infoRequestBy: null, infoRequestAt: null, cancelledAt: null },
    ],
    resourceReservation: [
      // done originals, plenty of cement → APPROVED by the rule
      res(1, { status: 'COMPLETED', acceptedQuantity: 4, acceptanceComment: 'ok' }),
      res(2, { status: 'ALLOCATED' }),
      // rebar: 5 on the shelf, the original still claims 4 → the copy is short
      res(3, { itemId: 2, status: 'APPROVED' }),
      res(4, { status: 'REJECTED', replacedByReservationId: 5 }),
      res(5, { status: 'CANCELLED' }),
      // object request, no task
      res(6, { taskId: null, status: 'PARTIALLY_ALLOCATED' }),
      // catalog row of a task outside the copy
      res(7, { taskId: 999, objectId: 55, submissionId: 1, status: 'PENDING' }),
      // the single drill, already claimed by the original → short asset → PENDING, not an error
      res(8, { itemId: 3, quantity: 1, status: 'APPROVED' }),
      // not in the copy
      res(9, { taskId: 777, objectId: 66, status: 'APPROVED' }),
    ],
    reservationStatusHistory: [
      { id: 1, reservationId: 4, fromStatus: null, toStatus: 'PENDING', reason: null, performedBy: 1, performedAt: D('10-01') },
      { id: 2, reservationId: 4, fromStatus: 'PENDING', toStatus: 'REJECTED', reason: 'no', performedBy: 2, performedAt: D('10-02') },
    ],
    purchaseRequisition: ['DRAFT', 'PENDING_APPROVAL', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'FULFILLED', 'REJECTED', 'CANCELLED', 'REJECTION_PENDING'].map(
      (status, i) => ({
        id: 100 + i, status, title: status, comment: null, periodStart: null, periodEnd: null, entityId: 3, createdBy: 5,
        taskId: 501, taskOrigin: 'ATTACHED', orderId: 40, rejectionReason: 'r', reviewedBy: 8, reviewedAt: D('10-03'),
        decidedBy: 9, decidedAt: D('10-03'), rejectionRequestedBy: null, rejectionRequestedAt: null, rejectionStage: null,
        rejectionReturnStatus: status === 'REJECTION_PENDING' ? 'IN_REVIEW' : null, rejectionConfirmedBy: null,
        rejectionConfirmedAt: null, rejectionDeclineNote: null, submissionId: null,
      }),
    ),
    purchaseRequisitionLine: [
      { id: 1, requisitionId: 104, itemId: 2, itemName: 'Rebar', code: null, unit: null, quantity: 3, stockQuantity: 1, expectedQuantity: 0, note: null, reservationId: 3 },
      { id: 2, requisitionId: 104, itemId: 2, itemName: 'Rebar', code: null, unit: null, quantity: 3, stockQuantity: 1, expectedQuantity: 0, note: null, reservationId: 9 },
    ],
    purchaseRequisitionComment: [{ id: 1, requisitionId: 104, userId: 5, text: 'hi', createdAt: D('10-04') }],
    purchaseRequisitionAttachment: [{ id: 1, requisitionId: 104, uploadedBy: 5, name: 'q.pdf', url: '/uploads/q.pdf', size: 10, mimeType: 'application/pdf', createdAt: D('10-04') }],
    assetRequest: ['PENDING', 'APPROVED', 'ISSUED', 'REJECTED', 'CANCELLED'].map((status, i) => ({
      id: 200 + i, kind: 'OBJECT', entityId: 3, requestedBy: 5, forUserId: null, forObjectId: 77, itemId: 3, quantity: 1,
      reason: null, status, decidedBy: 9, decidedAt: D('10-05'), decisionNote: 'n',
    })).concat([{ id: 300, kind: 'PERSONAL', entityId: 3, requestedBy: 5, forUserId: 5, forObjectId: null, itemId: 3, quantity: 1, reason: null, status: 'PENDING', decidedBy: null, decidedAt: null, decisionNote: null } as any]),
  };
}

const BODY = {
  jobId: JOB,
  projectIdMap: { '12': 340 },
  taskIdMap: { '501': 9001 },
  objectIdMap: { '77': 410 },
  projectNames: { '340': 'Ե-10 (պատճեն)' },
};

function setup(db = makeDb(seed())) {
  const notifications = { send: jest.fn(), sendToUsers: jest.fn() };
  const stockAlerts = { check: jest.fn(), checkMany: jest.fn() };
  const reservations = new ReservationsService(db, {} as any, stockAlerts as any, notifications as any, {} as any, {} as any, {} as any);
  let n = 0;
  const files = { copy: jest.fn((url: string) => (url === '/uploads/missing.pdf' ? null : `/uploads/copy-${++n}.pdf`)), remove: jest.fn() };
  const service = new ProjectCopiesService(db, reservations, files as any);
  return { db, service, files, notifications, stockAlerts };
}

const copies = (db: any) => db.state.resourceReservation.filter((r: any) => r.copyJobId === JOB);
const copyOf = (db: any, oldId: number) =>
  db.state.resourceReservation.find(
    (r: any) => r.copyJobId === JOB && db.state.reservationStatusHistory.some((h: any) => h.reservationId === r.id && String(h.reason).includes(`#${oldId},`)),
  );

let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(() => {
    throw new Error('no network during a copy');
  });
});
afterEach(() => fetchSpy.mockRestore());

// ─── tests ──────────────────────────────────────────────────────────────────

describe('project copy · the status rules', () => {
  it('requisitions: draft / waiting / rejected / cancelled stay; approved or further → PENDING_APPROVAL', () => {
    expect(['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED', 'REJECTION_PENDING'].map((s) => copiedRequisitionStatus(s as any))).toEqual([
      'DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED', 'REJECTION_PENDING',
    ]);
    expect(['SUBMITTED', 'IN_REVIEW', 'APPROVED', 'FULFILLED'].map((s) => copiedRequisitionStatus(s as any))).toEqual(Array(4).fill('PENDING_APPROVAL'));
  });

  it('asset requests: APPROVED / ISSUED → PENDING, the rest stay', () => {
    expect(['PENDING', 'APPROVED', 'ISSUED', 'REJECTED', 'CANCELLED'].map((s) => copiedAssetRequestStatus(s as any))).toEqual([
      'PENDING', 'PENDING', 'PENDING', 'REJECTED', 'CANCELLED',
    ]);
  });

  it('refuses a body without a uuid jobId or a project map', () => {
    expect(() => parseCopyBody({ ...BODY, jobId: 'x' })).toThrow();
    expect(() => parseCopyBody({ ...BODY, projectIdMap: {} })).toThrow();
    expect(() => parseCopyBody({ ...BODY, taskIdMap: { a: 1 } })).toThrow();
  });
});

describe('POST /internal/project-copies', () => {
  it('copies every listed table, with the counts crm expects', async () => {
    const { service } = setup();
    const out = await service.copy(BODY);
    expect(out).toMatchObject({
      jobId: JOB,
      replayed: false,
      counts: { projectLinks: 1, estimateLines: 1, submissions: 1, reservations: 8, requisitions: 9, assetRequests: 5 },
      reset: { reservations: 5, requisitions: 4, assetRequests: 2 },
    });
  });

  it('reservations: the create rule — free → APPROVED, short → PENDING; REJECTED / CANCELLED kept', async () => {
    const { service, db } = setup();
    const out = await service.copy(BODY);
    expect(copyOf(db, 1).status).toBe('APPROVED'); // COMPLETED original, cement free
    expect(copyOf(db, 2).status).toBe('APPROVED'); // ALLOCATED original
    expect(copyOf(db, 6).status).toBe('APPROVED'); // PARTIALLY_ALLOCATED object request
    expect(copyOf(db, 3).status).toBe('PENDING'); // rebar: 5 on shelf − 4 claimed < 4
    expect(copyOf(db, 8).status).toBe('PENDING'); // the only drill is claimed: pending, not refused
    expect(copyOf(db, 4).status).toBe('REJECTED');
    expect(copyOf(db, 5).status).toBe('CANCELLED');
    expect(out.reservationStatuses).toEqual({ APPROVED: 4, PENDING: 2, REJECTED: 1, CANCELLED: 1 });
    // measured under the item lock, as create does
    expect(db.locks).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it('counts the copy\'s own earlier rows as claims (sequential, like separate requests)', async () => {
    const s = seed();
    s.item[0].quantity = 12; // cement: originals #7 (PENDING, 4) and #9 (APPROVED, 4) are claims
    const { service, db } = setup(makeDb(s));
    await service.copy(BODY);
    // 12 − 8 = 4 free → the first copy (4) fits; it then claims too, so the rest are short
    const cement = copies(db).filter((r: any) => r.itemId === 1 && !['REJECTED', 'CANCELLED'].includes(r.status));
    expect(cement.map((r: any) => r.status)).toEqual(['APPROVED', 'PENDING', 'PENDING', 'PENDING']);
  });

  it('remaps ids, keeps dates, drops outside links, resets acceptance; never copies allocations', async () => {
    const { service, db } = setup();
    await service.copy(BODY);
    const c1 = copyOf(db, 1);
    expect(c1).toMatchObject({ taskId: 9001, projectId: 340, projectName: 'Ե-10 (պատճեն)', objectId: 410, acceptedQuantity: 0, acceptanceComment: null });
    expect(+c1.startDate).toBe(+new Date(D('11-01')));
    expect(+c1.endDate).toBe(+new Date(D('11-10')));
    const c7 = copyOf(db, 7);
    expect(c7).toMatchObject({ taskId: null, objectId: null });
    expect(c7.submissionId).not.toBe(1);
    expect(copyOf(db, 4).replacedByReservationId).toBe(copyOf(db, 5).id);
    // history: kept rows carry theirs plus the copy note; re-created rows only the note
    const hist = (r: any) => db.state.reservationStatusHistory.filter((h: any) => h.reservationId === r.id);
    expect(hist(copyOf(db, 4)).map((h: any) => h.toStatus)).toEqual(['PENDING', 'REJECTED', 'REJECTED']);
    expect(hist(copyOf(db, 1))).toEqual([expect.objectContaining({ fromStatus: null, toStatus: 'APPROVED' })]);
  });

  it('requisitions: never the order, reset stamps cleared, lines remapped, files copied', async () => {
    const { service, db, files } = setup();
    await service.copy(BODY);
    const reqs = db.state.purchaseRequisition.filter((r: any) => r.copyJobId === JOB);
    expect(reqs.every((r: any) => r.orderId === null && r.taskId === 9001)).toBe(true);
    const approved = reqs.find((r: any) => r.title === 'APPROVED');
    expect(approved.status).toBe('PENDING_APPROVAL');
    expect([approved.reviewedBy, approved.decidedBy, approved.rejectionReason]).toEqual([undefined, undefined, undefined]);
    const rejected = reqs.find((r: any) => r.title === 'REJECTED');
    expect(rejected).toMatchObject({ status: 'REJECTED', reviewedBy: 8, rejectionReason: 'r' });
    expect(reqs.find((r: any) => r.title === 'REJECTION_PENDING')).toMatchObject({ status: 'REJECTION_PENDING', rejectionReturnStatus: 'PENDING_APPROVAL' });
    const lines = db.state.purchaseRequisitionLine.filter((l: any) => l.requisitionId === approved.id);
    expect(lines.map((l: any) => l.reservationId)).toEqual([copyOf(db, 3).id, null]);
    expect(db.state.purchaseRequisitionComment.filter((c: any) => c.requisitionId === approved.id)).toHaveLength(1);
    const att = db.state.purchaseRequisitionAttachment.filter((a: any) => a.requisitionId === approved.id);
    expect(att[0].url).toMatch(/^\/uploads\/copy-/);
    expect(files.copy).toHaveBeenCalledWith('/uploads/q.pdf');
    expect(files.copy).toHaveBeenCalledWith('/uploads/a.pdf');
    const sub = db.state.catalogSubmission.find((s: any) => s.copyJobId === JOB);
    expect(sub).toMatchObject({ number: 'REQ-2000', projectId: 340, projectName: 'Ե-10 (պատճեն)' });
    expect(sub.attachmentUrl).toMatch(/^\/uploads\/copy-/);
  });

  it('asset requests for copied objects only, approved/issued reset; links and estimates copied', async () => {
    const { service, db } = setup();
    await service.copy(BODY);
    const asks = db.state.assetRequest.filter((a: any) => a.copyJobId === JOB);
    expect(asks.map((a: any) => [a.status, a.forObjectId, a.decidedBy])).toEqual([
      ['PENDING', 410, 9], ['PENDING', 410, null], ['PENDING', 410, null], ['REJECTED', 410, 9], ['CANCELLED', 410, 9],
    ]);
    expect(db.state.warehouseProject.find((l: any) => l.copyJobId === JOB)).toMatchObject({ warehouseId: 9, projectId: 340, projectName: 'Ե-10 (պատճեն)' });
    expect(db.state.objectEstimateLine.find((l: any) => l.copyJobId === JOB)).toMatchObject({ objectId: 410, itemId: 1, plannedQuantity: 50 });
  });

  it('sends nothing, alerts nothing, calls no other service, moves no stock', async () => {
    const { service, db, notifications, stockAlerts } = setup();
    await service.copy(BODY);
    expect(notifications.send).not.toHaveBeenCalled();
    expect(notifications.sendToUsers).not.toHaveBeenCalled();
    expect(stockAlerts.check).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.state.item.map((i: any) => i.quantity)).toEqual([100, 5, 0]);
  });

  it('is idempotent by jobId: a replay answers the stored result and copies nothing twice', async () => {
    const { service, db } = setup();
    const first = await service.copy(BODY);
    const before = db.state.resourceReservation.length;
    const again = await service.copy(BODY);
    expect(again).toEqual({ ...first, replayed: true });
    expect(db.state.resourceReservation.length).toBe(before);
  });

  it('a failure half-way leaves nothing behind and unlinks the files it wrote', async () => {
    const { service, db, files } = setup();
    db.assetRequest.createMany = async () => {
      throw new Error('boom');
    };
    await expect(service.copy(BODY)).rejects.toThrow('boom');
    expect(copies(db)).toHaveLength(0);
    expect(db.state.warehouseProjectCopy).toHaveLength(0);
    expect(files.remove).toHaveBeenCalledTimes(files.copy.mock.calls.length);
  });
});

describe('POST /internal/project-copies · dateShiftDays (2026-10-07)', () => {
  const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

  it('parses an optional whole-day shift (default 0) and refuses anything else', () => {
    expect(parseCopyBody(BODY).shiftDays).toBe(0);
    expect(parseCopyBody({ ...BODY, dateShiftDays: 28 }).shiftDays).toBe(28);
    expect(parseCopyBody({ ...BODY, dateShiftDays: '-7' }).shiftDays).toBe(-7);
    expect(() => parseCopyBody({ ...BODY, dateShiftDays: 1.5 })).toThrow();
    expect(() => parseCopyBody({ ...BODY, dateShiftDays: 'soon' })).toThrow();
    expect(() => parseCopyBody({ ...BODY, dateShiftDays: 99999 })).toThrow();
    expect(day(shiftDate(new Date(D('03-28')), 7))).toBe('2026-04-04');
    expect(shiftDate(null, 7)).toBeNull();
  });

  it('moves reservation, requisition and submission dates by the shift; history stamps stay', async () => {
    const s = seed();
    s.purchaseRequisition[0].periodStart = D('11-02') as any;
    s.purchaseRequisition[0].periodEnd = D('11-20') as any;
    const { service, db } = setup(makeDb(s));
    await service.copy({ ...BODY, dateShiftDays: 28 });
    expect(day(copyOf(db, 1).startDate)).toBe('2026-11-29');
    expect(day(copyOf(db, 1).endDate)).toBe('2026-12-08');
    expect(copies(db).every((r: any) => day(r.startDate) === '2026-11-29')).toBe(true);
    const reqs = db.state.purchaseRequisition.filter((q: any) => q.copyJobId === JOB);
    const draft = reqs.find((q: any) => q.title === 'DRAFT');
    expect([day(draft.periodStart), day(draft.periodEnd)]).toEqual(['2026-11-30', '2026-12-18']);
    expect(reqs.find((q: any) => q.title === 'REJECTED').decidedAt).toEqual(new Date(D('10-03')));
    const sub = db.state.catalogSubmission.find((x: any) => x.copyJobId === JOB);
    expect(day(sub.neededBy)).toBe('2026-11-29');
    // the originals keep theirs
    expect(day(db.state.resourceReservation.find((r: any) => r.id === 1).startDate)).toBe('2026-11-01');
  });

  it('applies the stock rule on the SHIFTED dates: clear of the original claim → APPROVED', async () => {
    // Rebar: 5 on the shelf, the original #3 holds 4 for 1–10 Nov. Unshifted the
    // copy overlaps it (PENDING, see above); four weeks later it does not.
    const { service, db } = setup();
    await service.copy({ ...BODY, dateShiftDays: 28 });
    expect(copyOf(db, 3).status).toBe('APPROVED');
    const again = setup();
    await again.service.copy({ ...BODY, dateShiftDays: 0 });
    expect(copyOf(again.db, 3).status).toBe('PENDING');
  });
});

describe('DELETE /internal/project-copies/:jobId', () => {
  it('deletes exactly what the job made, unlinks its files, and is safe to repeat', async () => {
    const { service, db, files } = setup();
    const originals = JSON.stringify(seed().resourceReservation.map((r) => r.id));
    await service.copy(BODY);
    const out = await service.rollback(JOB);
    expect(out.deleted).toEqual({ reservations: 8, requisitions: 9, assetRequests: 5, submissions: 1, estimateLines: 1, projectLinks: 1 });
    expect(out.files).toBe(2);
    expect(files.remove.mock.calls.map((c) => c[0]).sort()).toEqual(['/uploads/copy-1.pdf', '/uploads/copy-2.pdf']);
    expect(JSON.stringify(db.state.resourceReservation.map((r: any) => r.id))).toBe(originals);
    expect(db.state.purchaseRequisitionLine).toHaveLength(2);
    expect(db.state.reservationStatusHistory).toHaveLength(2);
    expect(db.state.warehouseProjectCopy).toHaveLength(0);
    expect((await service.rollback(JOB)).deleted.reservations).toBe(0);
  });
});

describe('internal guard', () => {
  const ctx = (headers: Record<string, string>) => ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as any;
  beforeAll(() => (process.env.INTERNAL_SECRET = 's3cret'));

  it('the controller is public to the bearer guard and closed by InternalGuard', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ProjectCopiesController)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, ProjectCopiesController)).toContain(InternalGuard);
  });

  it('refuses a missing or wrong secret, admits the right one', () => {
    const guard = new InternalGuard();
    expect(() => guard.canActivate(ctx({}))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx({ 'x-internal-secret': 'nope' }))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctx({ 'x-internal-secret': 's3cret' }))).toBe(true);
  });
});

describe('FileService.copy', () => {
  it('makes a physical copy under a new name, and answers null for a missing file', () => {
    const dir = path.join(process.cwd(), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const name = `copy-test-${Date.now()}.pdf`;
    fs.writeFileSync(path.join(dir, name), 'hello');
    const files = new FileService();
    const url = files.copy(`/uploads/${name}`)!;
    try {
      expect(url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.pdf$/);
      expect(fs.readFileSync(path.join(dir, url.slice('/uploads/'.length)), 'utf8')).toBe('hello');
      expect(files.copy('/uploads/does-not-exist.pdf')).toBeNull();
    } finally {
      files.remove(`/uploads/${name}`);
      files.remove(url);
    }
  });
});
