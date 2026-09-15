import { transferOperationKey } from '../common/operation-key';

/**
 * Retrying a finalize is not resubmitting an order.
 *
 * The old code knew it was duplicating and said so: "if the balance call then
 * fails the order stays in DRAFT and finalize can be retried, which would
 * duplicate it. The duplicate is visible in the finance queue and rejectable."
 * That is the case pinned first below.
 *
 * The other case is the one the frozen business rule protects: an order
 * finance refused may be resubmitted, and that IS a new financial operation
 * entitled to its own row under the same `externalRef`. The counter lives on
 * `resubmit`, which is the only deliberate business decision to raise the
 * money again — `finalize` never touches it.
 */

describe('warehouse finance operation keys', () => {
  it('is stable while the order stays on the same attempt', () => {
    // The retry after "deposit created, balance failed". Same attempt, same
    // key, so the deposit comes back instead of being raised twice.
    expect(transferOperationKey('warehouse_procurement', 28, 'PREPAYMENT', 1)).toBe(
      transferOperationKey('warehouse_procurement', 28, 'PREPAYMENT', 1),
    );
  });

  it('separates the deposit from the balance', () => {
    // FULL/BALANCE and PREPAYMENT are distinct financial actions and must
    // never dedupe each other.
    const keys = new Set([
      transferOperationKey('warehouse_procurement', 28, 'PREPAYMENT', 1),
      transferOperationKey('warehouse_procurement', 28, 'BALANCE', 1),
      transferOperationKey('warehouse_procurement', 28, 'FULL', 1),
    ]);
    expect(keys.size).toBe(3);
  });

  it('gives a resubmission after rejection new keys', () => {
    const first = transferOperationKey('warehouse_procurement', 28, 'FULL', 1);
    const afterResubmit = transferOperationKey('warehouse_procurement', 28, 'FULL', 2);

    expect(afterResubmit).not.toBe(first);
  });

  it('reproduces the warehouse_procurement:28 history as three attempts', () => {
    // Three transfers share that ref in the live data: refused, refused,
    // completed. Three attempts, one source reference — valid history.
    const keys = [1, 2, 3].map((n) => transferOperationKey('warehouse_procurement', 28, 'FULL', n));
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((k) => k.startsWith('warehouse_procurement:28:'))).toBe(true);
  });

  it('separates maintenance from procurement', () => {
    expect(transferOperationKey('warehouse_maintenance', 28, 'FULL', 1)).not.toBe(
      transferOperationKey('warehouse_procurement', 28, 'FULL', 1),
    );
  });

  it('separates two records of the same kind', () => {
    expect(transferOperationKey('warehouse_procurement', 28, 'FULL', 1)).not.toBe(
      transferOperationKey('warehouse_procurement', 280, 'FULL', 1),
    );
  });

  it('names its kind, so it can never be an advance key', () => {
    const key = transferOperationKey('warehouse_maintenance', 88, 'PREPAYMENT', 1);
    expect(key).toBe('warehouse_maintenance:88:transfer.prepayment:1');
    expect(key.split(':').some((s) => s.startsWith('transfer'))).toBe(true);
    expect(key.split(':').some((s) => s.startsWith('advance'))).toBe(false);
  });
});
