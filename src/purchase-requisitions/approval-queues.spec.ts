import { ForbiddenException } from '@nestjs/common';

import { PurchaseRequisitionsController } from './purchase-requisitions.controller';
import { PurchaseRequisitionsService } from './purchase-requisitions.service';

/**
 * GET /purchase-requisitions/approvals and /rejections — the approval desk and
 * the rejection-confirmation desk — are GLOBAL (owner, 2026-10-05: the
 * warehouse is global; the warehouse client has no organisation picker, so
 * X-Entity-ID there is a stored value nobody chose). Whoever holds the right
 * anywhere — rights resolve across organisations since 827039d — sees every
 * organisation's rows. The status filters stay.
 *
 * Before, each desk was the selected organisation's: the row filter carried
 * `entityId`, and a header naming an organisation the person held no right in,
 * or no header at all, was a 403.
 *
 * User 42 holds approve_purchase_requisition in organisation 3 only; user 44
 * holds confirm_requisition_rejection in 5 only; user 39 holds neither.
 */
const APPROVER = 42;
const CONFIRMER = 44;
const NOBODY = 39;

const RIGHTS: Record<number, Record<number, string[]>> = {
  [APPROVER]: { 3: ['approve_purchase_requisition'] },
  [CONFIRMER]: { 5: ['confirm_requisition_rejection'] },
};

const ROWS = [
  { id: 6, entityId: 5, status: 'REJECTED', rejectionStage: 'ORG', rejectionConfirmedBy: 44 },
  { id: 5, entityId: 3, status: 'REJECTED', rejectionStage: 'PROCUREMENT', rejectionConfirmedBy: null },
  { id: 4, entityId: 5, status: 'REJECTION_PENDING', rejectionStage: 'ORG', rejectionConfirmedBy: null },
  { id: 3, entityId: 3, status: 'REJECTION_PENDING', rejectionStage: 'PROCUREMENT', rejectionConfirmedBy: null },
  { id: 2, entityId: 5, status: 'PENDING_APPROVAL', rejectionStage: null, rejectionConfirmedBy: null },
  { id: 1, entityId: 3, status: 'PENDING_APPROVAL', rejectionStage: null, rejectionConfirmedBy: null },
  { id: 0, entityId: 3, status: 'DRAFT', rejectionStage: null, rejectionConfirmedBy: null },
];

/** The row filter the service builds, applied to the stand-in rows: status (a string, `not` or `notIn`) and the REJECTED confirmer clause. */
const matches = (row: any, where: any) => {
  if ('entityId' in where) throw new Error('the desk must not filter by organisation');
  const status = where.status;
  const statusOk =
    typeof status === 'string' ? row.status === status : status?.not ? row.status !== status.not : status?.notIn ? !status.notIn.includes(row.status) : true;
  const confirmedOk = where.rejectionConfirmedBy ? row.rejectionConfirmedBy !== null : true;
  return statusOk && confirmedOk;
};

function build() {
  const wheres: any[] = [];
  const prisma: any = {
    purchaseRequisition: {
      findMany: jest.fn(async ({ where }: any) => (wheres.push(where), ROWS.filter((r) => matches(r, where)))),
      count: jest.fn(async ({ where }: any) => ROWS.filter((r) => matches(r, where)).length),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const usersPrisma: any = {
    // Entity 0 is the union of every assignment, as users-prisma resolves it.
    getUserAccessInfo: jest.fn(async (userId: number, entityId = 0) => ({
      isSuperAdmin: false,
      isGlobalSuperAdmin: false,
      permissionNames: entityId === 0 ? Object.values(RIGHTS[userId] ?? {}).flat() : RIGHTS[userId]?.[entityId] ?? [],
    })),
    getUsersByIds: jest.fn(async () => []),
  };
  const service = new PurchaseRequisitionsService(prisma, usersPrisma, {} as any);
  (service as any).decorate = async (rows: any[]) => rows;
  const controller = new PurchaseRequisitionsController(service, {} as any);
  return { controller, wheres, prisma };
}

const as = (userId: number, entity: string | null) => ({
  user: { id: userId },
  isSuperAdmin: false,
  permissionNames: Object.values(RIGHTS[userId] ?? {}).flat(),
  headers: entity ? { 'x-entity-id': entity } : {},
});

const ids = (page: any) => page.data.map((r: any) => r.id).sort((a: number, b: number) => a - b);

describe('A · GET /purchase-requisitions/approvals is every organisation’s desk', () => {
  it('shows the approver of organisation 3 every organisation’s non-draft requisitions, with organisation 5 selected', async () => {
    const { controller, wheres } = build();
    const page = await controller.approvals({}, as(APPROVER, '5'));
    expect(ids(page)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(page.total).toBe(6);
    expect(wheres[0]).toEqual({ status: { not: 'DRAFT' } });
  });

  it('and with their own organisation selected, or none at all — the header changes nothing', async () => {
    const { controller } = build();
    expect(ids(await controller.approvals({}, as(APPROVER, '3')))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids(await controller.approvals({}, as(APPROVER, null)))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps the status filter and the search', async () => {
    const { controller, wheres } = build();
    expect(ids(await controller.approvals({ status: 'PENDING_APPROVAL' }, as(APPROVER, null)))).toEqual([1, 2]);
    await controller.approvals({ status: 'PENDING_APPROVAL', search: 'Ցեմենտ' }, as(APPROVER, null));
    expect(wheres[1]).toMatchObject({ status: 'PENDING_APPROVAL', OR: [{ title: { contains: 'Ցեմենտ', mode: 'insensitive' } }, expect.anything()] });
    expect(wheres[1]).not.toHaveProperty('entityId');
  });

  it('refuses somebody holding the right nowhere', async () => {
    const { controller, prisma } = build();
    await expect(controller.approvals({}, as(NOBODY, '3'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.approvals({}, as(CONFIRMER, '5'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.purchaseRequisition.findMany).not.toHaveBeenCalled();
  });
});

describe('A · GET /purchase-requisitions/rejections is every organisation’s desk', () => {
  it('shows the confirmer of organisation 5 every organisation’s pending rejections, with organisation 3 selected', async () => {
    const { controller, wheres } = build();
    expect(ids(await controller.rejections({}, as(CONFIRMER, '3')))).toEqual([3, 4]);
    expect(wheres[0]).toEqual({ status: 'REJECTION_PENDING' });
    expect(ids(await controller.rejections({}, as(CONFIRMER, null)))).toEqual([3, 4]);
  });

  it('keeps the decided-rejections view: REJECTED rows a confirmer stamped, from every organisation', async () => {
    const { controller, wheres } = build();
    expect(ids(await controller.rejections({ status: 'REJECTED' }, as(CONFIRMER, '3')))).toEqual([6]);
    expect(wheres[0]).toEqual({ status: 'REJECTED', rejectionConfirmedBy: { not: null } });
  });

  it('refuses somebody holding the right nowhere', async () => {
    const { controller } = build();
    await expect(controller.rejections({}, as(NOBODY, '5'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.rejections({}, as(APPROVER, '3'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
