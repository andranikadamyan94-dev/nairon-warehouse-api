import {
  approvalRights,
  availabilityOf,
  deriveStatus,
  formatSubmissionNumber,
  lineIdOf,
  parseLineId,
  partitionByRights,
  progressOf,
  splitCheckout,
  stageOf,
  stillEditable,
  LineStage,
} from './catalog.rules';

/**
 * Warehouse catalog, phases B/C — the rules of §10 of the build spec, each
 * branch on its own. These are the functions the service reads a submission
 * by; a change here is a change in what «Իմ հարցումները» says.
 */

describe('stageOf — where one line stands', () => {
  it('a stock line waits until something is issued, whatever the create path marked it', () => {
    expect(stageOf('STOCK', 'PENDING')).toBe('PENDING');
    expect(stageOf('STOCK', 'APPROVED')).toBe('PENDING');
    expect(stageOf('STOCK', 'APPROVED', { issued: 0 })).toBe('PENDING');
    expect(stageOf('STOCK', 'APPROVED', { issued: 2 })).toBe('PROGRESS');
  });

  it('a stock line in progress, ready, collected, rejected, cancelled', () => {
    expect(stageOf('STOCK', 'PARTIALLY_ALLOCATED')).toBe('PROGRESS');
    expect(stageOf('STOCK', 'ALLOCATED')).toBe('READY');
    expect(stageOf('STOCK', 'COMPLETED')).toBe('COMPLETED');
    expect(stageOf('STOCK', 'REJECTED')).toBe('REJECTED');
    expect(stageOf('STOCK', 'CANCELLED')).toBe('CANCELLED');
  });

  it('a purchase line follows the requisition', () => {
    expect(stageOf('PURCHASE', 'DRAFT')).toBe('PENDING');
    expect(stageOf('PURCHASE', 'PENDING_APPROVAL')).toBe('PENDING');
    expect(stageOf('PURCHASE', 'SUBMITTED')).toBe('PROGRESS');
    expect(stageOf('PURCHASE', 'IN_REVIEW')).toBe('PROGRESS');
    expect(stageOf('PURCHASE', 'APPROVED')).toBe('PROGRESS');
    expect(stageOf('PURCHASE', 'FULFILLED')).toBe('COMPLETED');
    expect(stageOf('PURCHASE', 'REJECTION_PENDING')).toBe('REJECTED');
    expect(stageOf('PURCHASE', 'REJECTED')).toBe('REJECTED');
    expect(stageOf('PURCHASE', 'CANCELLED')).toBe('CANCELLED');
    expect(stageOf('NEW', 'PENDING_APPROVAL')).toBe('PENDING');
  });
});

describe('deriveStatus — the one status the person sees (§10)', () => {
  const s = (...stages: LineStage[]) => stages;

  it('any line pending → SUBMITTED', () => {
    expect(deriveStatus(s('PENDING', 'PROGRESS'))).toBe('SUBMITTED');
    expect(deriveStatus(s('PENDING', 'READY', 'COMPLETED'))).toBe('SUBMITTED');
    expect(deriveStatus(s('PENDING'))).toBe('SUBMITTED');
  });

  it('an open info request → NEEDS_INFO, even though a returned requisition is a pending line', () => {
    expect(deriveStatus(s('PENDING', 'PENDING'), { infoOpen: true })).toBe('NEEDS_INFO');
    expect(deriveStatus(s('PROGRESS'), { infoOpen: true })).toBe('NEEDS_INFO');
  });

  it('all lines rejected → REJECTED', () => {
    expect(deriveStatus(s('REJECTED'))).toBe('REJECTED');
    expect(deriveStatus(s('REJECTED', 'REJECTED'))).toBe('REJECTED');
  });

  it('cancelled by the requester → CANCELLED, before anything else', () => {
    expect(deriveStatus(s('CANCELLED', 'CANCELLED'))).toBe('CANCELLED');
    expect(deriveStatus(s('PENDING'), { cancelled: true })).toBe('CANCELLED');
    expect(deriveStatus(s('PENDING'), { cancelled: true, infoOpen: true })).toBe('CANCELLED');
    expect(deriveStatus(s())).toBe('CANCELLED');
  });

  it('every line terminal and mixed → PARTIAL', () => {
    expect(deriveStatus(s('REJECTED', 'COMPLETED'))).toBe('PARTIAL');
    expect(deriveStatus(s('CANCELLED', 'COMPLETED'))).toBe('PARTIAL');
    expect(deriveStatus(s('REJECTED', 'CANCELLED'))).toBe('PARTIAL');
  });

  it('every live line ready to collect → READY', () => {
    expect(deriveStatus(s('READY'))).toBe('READY');
    expect(deriveStatus(s('READY', 'READY'))).toBe('READY');
    expect(deriveStatus(s('READY', 'COMPLETED'))).toBe('READY');
    expect(deriveStatus(s('READY', 'REJECTED'))).toBe('READY');
  });

  it('all lines collected → COMPLETED', () => {
    expect(deriveStatus(s('COMPLETED'))).toBe('COMPLETED');
    expect(deriveStatus(s('COMPLETED', 'COMPLETED'))).toBe('COMPLETED');
  });

  it('otherwise IN_PROGRESS', () => {
    expect(deriveStatus(s('PROGRESS'))).toBe('IN_PROGRESS');
    expect(deriveStatus(s('READY', 'PROGRESS'))).toBe('IN_PROGRESS');
    expect(deriveStatus(s('PROGRESS', 'REJECTED'))).toBe('IN_PROGRESS');
    expect(deriveStatus(s('PROGRESS', 'COMPLETED'))).toBe('IN_PROGRESS');
  });

  it('the live test\'s walk: submitted → partial approval runs → one collected', () => {
    // 1 stocked + 1 out of stock + 1 new: reservation APPROVED-unissued, requisition PENDING_APPROVAL
    expect(deriveStatus([stageOf('STOCK', 'APPROVED'), stageOf('PURCHASE', 'PENDING_APPROVAL'), stageOf('NEW', 'PENDING_APPROVAL')])).toBe('SUBMITTED');
    // approve: stock 3 of 5 issued (ALLOCATED after the quantity was cut), purchases org-approved (SUBMITTED)
    expect(deriveStatus([stageOf('STOCK', 'ALLOCATED'), stageOf('PURCHASE', 'SUBMITTED'), stageOf('NEW', 'SUBMITTED')])).toBe('IN_PROGRESS');
    // goods accepted, purchases received
    expect(deriveStatus([stageOf('STOCK', 'COMPLETED'), stageOf('PURCHASE', 'FULFILLED'), stageOf('NEW', 'FULFILLED')])).toBe('COMPLETED');
  });
});

describe('progress and editability', () => {
  it('progress.ready counts collected and ready-to-collect lines', () => {
    expect(progressOf(['PENDING', 'READY', 'COMPLETED', 'REJECTED'])).toEqual({ ready: 2, total: 4 });
    expect(progressOf([])).toEqual({ ready: 0, total: 0 });
  });

  it('D7: editable while every line is still pending, never after cancellation', () => {
    expect(stillEditable(['PENDING', 'PENDING'])).toBe(true);
    expect(stillEditable(['PENDING', 'PROGRESS'])).toBe(false);
    expect(stillEditable(['PENDING'], { cancelled: true })).toBe(false);
    expect(stillEditable([])).toBe(false);
  });
});

describe('splitCheckout — stock vs purchase (D1)', () => {
  const catalogue: Record<number, { stockingMode: string; inStock: number }> = {
    1: { stockingMode: 'STOCKED', inStock: 12 },
    2: { stockingMode: 'STOCKED', inStock: 0 },
    3: { stockingMode: 'ON_REQUEST', inStock: 40 },
  };
  const itemOf = (id: number) => {
    const c = catalogue[id];
    return c ? { stockingMode: c.stockingMode, availability: availabilityOf(c.stockingMode, c.inStock) } : undefined;
  };

  it('availability: ON_REQUEST wins over the shelf; otherwise the shelf decides', () => {
    expect(availabilityOf('ON_REQUEST', 40)).toBe('ON_REQUEST');
    expect(availabilityOf('STOCKED', 1)).toBe('IN_STOCK');
    expect(availabilityOf('STOCKED', 0)).toBe('OUT_OF_STOCK');
  });

  it('in-stock lines become reservations, out-of-stock lines purchases', () => {
    const { stock, purchase } = splitCheckout([{ itemId: 1, quantity: 2 }, { itemId: 2, quantity: 1 }], itemOf);
    expect(stock).toEqual([{ itemId: 1, quantity: 2 }]);
    expect(purchase).toEqual([{ itemId: 2, quantity: 1 }]);
  });

  it('ON_REQUEST is always a purchase, even with stock on the shelf', () => {
    const { stock, purchase } = splitCheckout([{ itemId: 3, quantity: 1 }], itemOf);
    expect(stock).toEqual([]);
    expect(purchase).toEqual([{ itemId: 3, quantity: 1 }]);
  });

  it('an unknown item is never promised from stock', () => {
    const { stock, purchase } = splitCheckout([{ itemId: 99, quantity: 1 }], itemOf);
    expect(stock).toEqual([]);
    expect(purchase).toHaveLength(1);
  });

  it('the live test\'s cart: one of each', () => {
    const { stock, purchase } = splitCheckout(
      [{ itemId: 1, quantity: 5 }, { itemId: 2, quantity: 3 }],
      itemOf,
    );
    expect(stock.map((l) => l.itemId)).toEqual([1]);
    expect(purchase.map((l) => l.itemId)).toEqual([2]);
  });
});

describe('approval split (D3) — skipped lines', () => {
  const lines = [
    { id: 'r10', kind: 'STOCK' as const },
    { id: 'l20', kind: 'PURCHASE' as const },
    { id: 'l21', kind: 'NEW' as const },
  ];

  it('manage_reservations alone decides stock lines; purchases are skipped', () => {
    const rights = approvalRights({ isSuperAdmin: false, permissionNames: ['manage_reservations'] }, false);
    expect(rights).toEqual({ stock: true, purchase: false });
    const { allowed, skipped } = partitionByRights(lines, rights);
    expect(allowed.map((l) => l.id)).toEqual(['r10']);
    expect(skipped).toEqual(['l20', 'l21']);
  });

  it('approve_purchase_requisition in the organization alone decides purchase and new lines', () => {
    const rights = approvalRights({ isSuperAdmin: false, permissionNames: ['view_warehouse'] }, true);
    expect(rights).toEqual({ stock: false, purchase: true });
    const { allowed, skipped } = partitionByRights(lines, rights);
    expect(allowed.map((l) => l.id)).toEqual(['l20', 'l21']);
    expect(skipped).toEqual(['r10']);
  });

  it('manage_warehouse is the warehouse super-permission for stock, not for purchases', () => {
    const rights = approvalRights({ isSuperAdmin: false, permissionNames: ['manage_warehouse'] }, false);
    expect(rights).toEqual({ stock: true, purchase: false });
  });

  it('a super admin decides everything; nobody with neither right decides anything', () => {
    expect(partitionByRights(lines, approvalRights({ isSuperAdmin: true, permissionNames: [] }, false)).skipped).toEqual([]);
    const none = partitionByRights(lines, approvalRights({ isSuperAdmin: false, permissionNames: [] }, false));
    expect(none.allowed).toEqual([]);
    expect(none.skipped).toEqual(['r10', 'l20', 'l21']);
  });
});

describe('submission numbers and line ids', () => {
  it('REQ- + a four-digit zero-padded sequence, from 1001', () => {
    expect(formatSubmissionNumber(1001)).toBe('REQ-1001');
    expect(formatSubmissionNumber(1002n)).toBe('REQ-1002');
    expect(formatSubmissionNumber(7)).toBe('REQ-0007');
    expect(formatSubmissionNumber(12345)).toBe('REQ-12345');
    expect(() => formatSubmissionNumber(-1)).toThrow(RangeError);
  });

  it('line ids name the table and the row, and parse back', () => {
    expect(lineIdOf('STOCK', 42)).toBe('r42');
    expect(lineIdOf('PURCHASE', 7)).toBe('l7');
    expect(lineIdOf('NEW', 8)).toBe('l8');
    expect(parseLineId('r42')).toEqual({ table: 'reservation', rowId: 42 });
    expect(parseLineId(' l7 ')).toEqual({ table: 'requisitionLine', rowId: 7 });
    expect(parseLineId('42')).toBeNull();
    expect(parseLineId('x1')).toBeNull();
  });
});
