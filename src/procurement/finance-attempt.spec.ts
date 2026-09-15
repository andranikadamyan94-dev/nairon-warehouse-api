import { BadRequestException } from '@nestjs/common';

import { ProcurementService } from './procurement.service';
import { ProcurementOrderStatus } from '../common/enums/procurement-order-status.enum';

/**
 * Where the attempt counter moves, and where it must not.
 *
 * The distinction the frozen business rule draws is between a technical retry
 * and a deliberate resubmission, and in warehouse that distinction has exactly
 * one home: `resubmit` is the only way an order that finance refused becomes
 * live again, and it is a person deciding to ask for the money a second time.
 * `finalize` is the send — including the send that is retried after it failed
 * halfway — and it must leave the counter alone, or the retry would land
 * beside the transfers it already created instead of on them.
 */

function store(order: Record<string, unknown>) {
  const row = { ...order };
  const prisma: any = {
    procurementOrder: {
      findUnique: async () => ({ ...row, items: [], supplier: null, deliveries: [] }),
      update: async ({ data }: any) => {
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in (value as object)) {
            row[key] = (row[key] as number) + (value as { increment: number }).increment;
          } else {
            row[key] = value;
          }
        }
        return { ...row };
      },
    },
  };
  const service = new ProcurementService(prisma, {} as any, {} as any, {} as any);
  return { service, row };
}

describe('procurement · the attempt counter', () => {
  it('starts at one', () => {
    const { row } = store({ id: 28, status: ProcurementOrderStatus.DRAFT, financeAttempt: 1 });
    expect(row.financeAttempt).toBe(1);
  });

  it('advances when a refused order is deliberately resubmitted', async () => {
    const { service, row } = store({
      id: 28,
      status: ProcurementOrderStatus.FINANCE_REJECTED,
      financeAttempt: 1,
      financeRejectionReason: 'Շատ թանկ է',
    });

    await service.resubmit(28);

    // A new financial operation, entitled to its own transfer under the same
    // externalRef — which is exactly what the frozen rule allows.
    expect(row.financeAttempt).toBe(2);
    expect(row.status).toBe(ProcurementOrderStatus.DRAFT);
    // The old objection no longer describes the order.
    expect(row.financeRejectionReason).toBeNull();
  });

  it('advances again on a second resubmission', async () => {
    const { service, row } = store({
      id: 28,
      status: ProcurementOrderStatus.FINANCE_REJECTED,
      financeAttempt: 2,
    });

    await service.resubmit(28);

    // warehouse_procurement:28 really does carry three transfers.
    expect(row.financeAttempt).toBe(3);
  });

  it('does not advance for an order finance has not refused', async () => {
    const { service, row } = store({
      id: 28,
      status: ProcurementOrderStatus.DRAFT,
      financeAttempt: 1,
    });

    await expect(service.resubmit(28)).rejects.toBeInstanceOf(BadRequestException);
    expect(row.financeAttempt).toBe(1);
  });

  it('does not advance for an order finance approved', async () => {
    const { service, row } = store({
      id: 28,
      status: ProcurementOrderStatus.FINANCE_APPROVED,
      financeAttempt: 1,
    });

    await expect(service.resubmit(28)).rejects.toBeInstanceOf(BadRequestException);
    expect(row.financeAttempt).toBe(1);
  });
});
