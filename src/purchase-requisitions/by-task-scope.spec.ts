import { PurchaseRequisitionsController } from './purchase-requisitions.controller';
import { PurchaseRequisitionsService } from './purchase-requisitions.service';

/**
 * GET /purchase-requisitions/by-task/:taskId (2026-10-01) — the task panel in
 * CRM. It had no check: anybody signed in read the requisitions (lines,
 * comments, attachments) on any task id, in any organization.
 *
 * Now whoever may open the task in CRM sees them all; anybody else sees only
 * what GET /purchase-requisitions/:id would show them.
 *
 * Requisition 1 is user 39's, filed in organization 3; requisition 2 is user
 * 50's, filed in organization 9. Both are on task 500.
 */
const ROWS = [
  { id: 2, taskId: 500, createdBy: 50, entityId: 9, status: 'SUBMITTED', comments: [] },
  { id: 1, taskId: 500, createdBy: 39, entityId: 3, status: 'SUBMITTED', comments: [] },
];

const PERMS: Record<number, string[]> = { 39: [], 77: [], 88: ['view_procurement'] };

const build = (crm: 'visible' | 'hidden' | 'down') => {
  const prisma: any = {
    purchaseRequisition: { findMany: jest.fn(async ({ where }: any) => ROWS.filter((r) => r.taskId === where.taskId)) },
  };
  const usersPrisma: any = {
    getUserAccessInfo: jest.fn(async (userId: number) => ({ isSuperAdmin: false, isGlobalSuperAdmin: false, permissionNames: PERMS[userId] ?? [] })),
    getUsersByIds: jest.fn(async () => []),
  };
  const service = new PurchaseRequisitionsService(prisma, usersPrisma, {} as any);
  const controller = new PurchaseRequisitionsController(service, {} as any);
  const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
    if (crm === 'down') throw new Error('ECONNREFUSED');
    return { ok: crm === 'visible', status: crm === 'visible' ? 200 : 404 } as any;
  });
  return { controller, fetchMock };
};

const as = (userId: number, headers: Record<string, string> = { authorization: 'Bearer tok', 'x-entity-id': '3' }) => ({
  user: { id: userId },
  headers,
});

const ids = (rows: any[]) => rows.map((r) => r.id).sort();

describe('requisitions on a task — who sees them', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.CRM_API_URL = 'http://crm.test';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...env };
  });

  it('shows nothing to somebody who may not open the task and filed none of them', async () => {
    const { controller, fetchMock } = build('hidden');
    await expect(controller.byTask(500, as(77))).resolves.toEqual([]);
    // CRM is asked as the caller, in the caller's organization.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://crm.test/api/project-tasks/500',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok', 'x-entity-id': '3' } }),
    );
  });

  it('shows all of them to somebody CRM lets open the task', async () => {
    const { controller } = build('visible');
    expect(ids(await controller.byTask(500, as(77)))).toEqual([1, 2]);
  });

  it("shows an author only their own when they may not open the task — not another organization's", async () => {
    const { controller } = build('hidden');
    expect(ids(await controller.byTask(500, as(39)))).toEqual([1]);
  });

  it('shows procurement all of them without asking CRM', async () => {
    const { controller, fetchMock } = build('hidden');
    expect(ids(await controller.byTask(500, as(88)))).toEqual([1, 2]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when CRM cannot be reached', async () => {
    const { controller } = build('down');
    await expect(controller.byTask(500, as(77))).resolves.toEqual([]);
  });

  it('does not ask CRM without an organization, and shows only what is theirs', async () => {
    const { controller, fetchMock } = build('visible');
    expect(ids(await controller.byTask(500, as(39, { authorization: 'Bearer tok' })))).toEqual([1]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
