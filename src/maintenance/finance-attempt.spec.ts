import { BadRequestException } from '@nestjs/common';

import { MaintenanceService } from './maintenance.service';

/**
 * Maintenance has no resubmission, and this is the guard that keeps that true.
 *
 * Its `financeAttempt` is always 1. That is only safe while `finalize` is
 * reachable from DRAFT alone: if a FINANCE_REJECTED job could be sent again,
 * the second send would reuse a spent key, and finance would answer a genuine
 * resubmission with a conflict.
 *
 * So the invariant is tested rather than assumed. The column exists so that
 * adding a reopen path is a one-line change here, not a silent breakage.
 */

function store(record: Record<string, unknown> | null) {
  const prisma: any = {
    maintenanceRecord: {
      findUnique: async () => (record ? { ...record, maintainer: null } : null),
      update: async () => {
        throw new Error('finalize must not write when it refuses the status');
      },
    },
  };
  return new MaintenanceService(prisma, {} as any);
}

describe('maintenance · why the attempt is always one', () => {
  it.each([
    ['PENDING_FINANCE'],
    ['FINANCE_APPROVED'],
    ['FINANCE_REJECTED'],
    ['COMPLETED'],
  ])('refuses to finalize a %s record', async (status) => {
    const service = store({ id: 88, status, amount: null, prepaymentAmount: null, financeAttempt: 1 });

    // Nothing reaches finance, so no key is reused and no second transfer is
    // raised under the spent one.
    await expect(service.finalize(88, 50000)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a finalize with no amount, before finance is called', async () => {
    const service = store({ id: 88, status: 'DRAFT', amount: null, prepaymentAmount: null, financeAttempt: 1 });

    await expect(service.finalize(88, 0)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a deposit larger than the job', async () => {
    const service = store({ id: 88, status: 'DRAFT', amount: null, prepaymentAmount: null, financeAttempt: 1 });

    await expect(service.finalize(88, 50000, 90000)).rejects.toBeInstanceOf(BadRequestException);
  });
});
