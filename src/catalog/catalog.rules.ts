/**
 * Warehouse catalog, phases B/C (2026-10-01): the rules a submission is read by.
 *
 * Plain functions over plain data — no Nest, no Prisma — so the service, the
 * unit tests and anybody reasoning about «Իմ հարցումները» ask the same
 * question and get the same answer. The spec is §10 of
 * snapshots/warehouse-catalog-build-spec-2026-10-01.md; nothing here renames
 * an underlying enum (D1), it only reads them.
 */

export type LineKind = 'STOCK' | 'PURCHASE' | 'NEW';

export type SubmissionStatus =
  | 'SUBMITTED'
  | 'NEEDS_INFO'
  | 'IN_PROGRESS'
  | 'READY'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'PARTIAL';

export const SUBMISSION_STATUSES: SubmissionStatus[] = [
  'SUBMITTED', 'NEEDS_INFO', 'IN_PROGRESS', 'READY', 'COMPLETED', 'REJECTED', 'CANCELLED', 'PARTIAL',
];

/** What one line means for the submission, whatever table it lives in. */
export type LineStage = 'PENDING' | 'PROGRESS' | 'READY' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';

const TERMINAL: LineStage[] = ['COMPLETED', 'REJECTED', 'CANCELLED'];

/**
 * Where one line stands.
 *
 * STOCK lines are reservations. The create path marks a request APPROVED when
 * the shelf can cover it and PENDING when it cannot — both mean "the warehouse
 * has not acted yet", so both read as PENDING here until something has
 * actually been issued (D7: editable until the approver acts). Issuing is the
 * approval: PARTIALLY_ALLOCATED is in progress, ALLOCATED is ready to collect,
 * COMPLETED is accepted.
 *
 * PURCHASE / NEW lines are purchase-requisition lines. DRAFT is a requisition
 * returned for information (still the requester's turn, still pending);
 * PENDING_APPROVAL waits for the organization; SUBMITTED / IN_REVIEW /
 * APPROVED is procurement running; FULFILLED is received. A rejection waiting
 * for confirm_requisition_rejection (REJECTION_PENDING) already reads as
 * rejected — the requester has been told why; a declined rejection puts the
 * requisition back and the line with it.
 */
export function stageOf(kind: LineKind, status: string, extra: { issued?: number } = {}): LineStage {
  if (kind === 'STOCK') {
    switch (status) {
      case 'PENDING':
        return 'PENDING';
      case 'APPROVED':
        return (extra.issued ?? 0) > 0 ? 'PROGRESS' : 'PENDING';
      case 'PARTIALLY_ALLOCATED':
        return 'PROGRESS';
      case 'ALLOCATED':
        return 'READY';
      case 'COMPLETED':
        return 'COMPLETED';
      case 'REJECTED':
        return 'REJECTED';
      case 'CANCELLED':
        return 'CANCELLED';
      default:
        return 'PROGRESS';
    }
  }
  switch (status) {
    case 'DRAFT':
    case 'PENDING_APPROVAL':
      return 'PENDING';
    case 'SUBMITTED':
    case 'IN_REVIEW':
    case 'APPROVED':
      return 'PROGRESS';
    case 'FULFILLED':
      return 'COMPLETED';
    case 'REJECTION_PENDING':
    case 'REJECTED':
      return 'REJECTED';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return 'PROGRESS';
  }
}

/**
 * The one status «Իմ հարցումները» shows (§10): cancelled → CANCELLED; an open
 * info request → NEEDS_INFO; any line pending → SUBMITTED; all lines rejected
 * → REJECTED; all completed → COMPLETED; every line terminal and mixed →
 * PARTIAL; everything still live is ready to collect → READY; otherwise
 * IN_PROGRESS.
 *
 * Cancelled and NEEDS_INFO come before "any line pending" on purpose: a
 * returned requisition sits in DRAFT, which is a pending line, and the person
 * must see «Տեղեկություն է պետք» rather than «Ուղարկված».
 */
export function deriveStatus(
  stages: LineStage[],
  flags: { cancelled?: boolean; infoOpen?: boolean } = {},
): SubmissionStatus {
  if (flags.cancelled) return 'CANCELLED';
  if (!stages.length) return 'CANCELLED';
  if (stages.every((s) => s === 'CANCELLED')) return 'CANCELLED';
  if (flags.infoOpen) return 'NEEDS_INFO';
  if (stages.some((s) => s === 'PENDING')) return 'SUBMITTED';
  if (stages.every((s) => s === 'REJECTED')) return 'REJECTED';
  if (stages.every((s) => s === 'COMPLETED')) return 'COMPLETED';
  if (stages.every((s) => TERMINAL.includes(s))) return 'PARTIAL';
  const live = stages.filter((s) => !TERMINAL.includes(s));
  if (live.length && live.every((s) => s === 'READY')) return 'READY';
  return 'IN_PROGRESS';
}

/** Progress bar: lines collected or ready to collect, over all lines. */
export function progressOf(stages: LineStage[]): { ready: number; total: number } {
  return {
    ready: stages.filter((s) => s === 'READY' || s === 'COMPLETED').length,
    total: stages.length,
  };
}

/** D7: the requester may edit / cancel while no line has been acted on. */
export function stillEditable(stages: LineStage[], flags: { cancelled?: boolean } = {}): boolean {
  if (flags.cancelled || !stages.length) return false;
  return stages.every((s) => s === 'PENDING');
}

// ── Checkout split ──────────────────────────────────────────────────────────

export type Availability = 'IN_STOCK' | 'OUT_OF_STOCK' | 'ON_REQUEST';

export function availabilityOf(stockingMode: string, inStock: number): Availability {
  if (stockingMode === 'ON_REQUEST') return 'ON_REQUEST';
  return inStock > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';
}

export type CheckoutLine = { itemId: number; quantity: number };

/**
 * D1: a cart splits into reservations (stocked lines) and ONE purchase
 * requisition (everything else). A line goes to stock only when the item is
 * STOCKED and in stock right now; ON_REQUEST is always a purchase, whatever
 * the shelf says; out of stock is a purchase; a new item is a purchase.
 */
export function splitCheckout(
  lines: CheckoutLine[],
  itemOf: (itemId: number) => { stockingMode: string; availability: Availability } | undefined,
): { stock: CheckoutLine[]; purchase: CheckoutLine[] } {
  const stock: CheckoutLine[] = [];
  const purchase: CheckoutLine[] = [];
  for (const line of lines) {
    const item = itemOf(line.itemId);
    if (item && item.stockingMode !== 'ON_REQUEST' && item.availability === 'IN_STOCK') stock.push(line);
    else purchase.push(line);
  }
  return { stock, purchase };
}

// ── Approval split ──────────────────────────────────────────────────────────

/** D3: who may decide which kind of line. */
export type ApprovalRights = { stock: boolean; purchase: boolean };

export function approvalRights(
  actor: { isSuperAdmin: boolean; permissionNames: string[] },
  holdsApproveRequisitionInEntity: boolean,
): ApprovalRights {
  const names = actor.permissionNames ?? [];
  return {
    stock: actor.isSuperAdmin || names.includes('manage_warehouse') || names.includes('manage_reservations'),
    purchase: actor.isSuperAdmin || holdsApproveRequisitionInEntity,
  };
}

export function mayDecide(kind: LineKind, rights: ApprovalRights): boolean {
  return kind === 'STOCK' ? rights.stock : rights.purchase;
}

/**
 * Lines of a kind the caller may not approve are left untouched and reported
 * as `skipped` (§10) — the UI greys them, a holder of one permission acts on
 * their half.
 */
export function partitionByRights<T extends { id: string; kind: LineKind }>(
  lines: T[],
  rights: ApprovalRights,
): { allowed: T[]; skipped: string[] } {
  const allowed: T[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    if (mayDecide(line.kind, rights)) allowed.push(line);
    else skipped.push(line.id);
  }
  return { allowed, skipped };
}

// ── Numbers and ids ─────────────────────────────────────────────────────────

/** REQ-1001, REQ-1002, … — zero-padded to four digits, wider once past 9999. */
export function formatSubmissionNumber(sequence: number | bigint): string {
  const n = typeof sequence === 'bigint' ? sequence : BigInt(Math.trunc(Number(sequence)));
  if (n < 0n) throw new RangeError('A submission number cannot be negative');
  return `REQ-${n.toString().padStart(4, '0')}`;
}

/**
 * Submission line ids. A line is a reservation row or a requisition line —
 * two tables whose integer ids collide — so the id the client passes back is
 * `r<reservationId>` or `l<requisitionLineId>`.
 */
export function lineIdOf(kind: LineKind, rowId: number): string {
  return `${kind === 'STOCK' ? 'r' : 'l'}${rowId}`;
}

export function parseLineId(id: string): { table: 'reservation' | 'requisitionLine'; rowId: number } | null {
  const m = /^([rl])(\d+)$/.exec(String(id ?? '').trim());
  if (!m) return null;
  return { table: m[1] === 'r' ? 'reservation' : 'requisitionLine', rowId: Number(m[2]) };
}

// ── Shelf figures for one line (2026-10-07, REQ-1015) ───────────────────────

/** The reservation fields the catalog's free-stock count reads. */
export type ClaimRow = {
  type: string | null | undefined;
  status: string;
  quantity: number;
  warehouseId?: number | null;
  endDate?: Date | string | null;
};

/**
 * How much of the shelf this reservation itself holds in the free-stock count
 * (freeStock): consumables — PENDING / APPROVED main-pool claims; assets —
 * every live main-pool claim. Both only while not expired. The «Հասանելի»
 * column adds this back, so a line's own claim never reads as a shortage
 * against itself.
 */
export function ownClaim(r: ClaimRow, now: Date = new Date()): number {
  if ((r.warehouseId ?? null) !== null) return 0;
  if (r.endDate && new Date(r.endDate) < now) return 0;
  const live = r.type === 'ASSET'
    ? ['PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED']
    : ['PENDING', 'APPROVED'];
  return live.includes(r.status) ? Number(r.quantity) || 0 : 0;
}

/** What the shelf offers this line: the free count plus the line's own claim. */
export function availableForLine(freeCount: number, own: number): number {
  return Math.max(0, Math.round((freeCount + own) * 1000) / 1000);
}

export const UNDECIDED_IN_STOCK = 'Սպասում է որոշման · պահեստում կա';
export const UNDECIDED_SHORT = 'Սպասում է որոշման · պահեստում չկա';

/**
 * A stock line nobody has decided yet does not wear its raw reservation
 * status («Հասանելի» only says the shelf could cover it at checkout); it
 * reads «Սպասում է որոշման» with whether the shelf covers it now. Once
 * decided, the real state shows.
 */
export function stockLineLabel(stage: LineStage, available: number, quantity: number, decidedLabel: string): string {
  if (stage !== 'PENDING') return decidedLabel;
  return available >= quantity ? UNDECIDED_IN_STOCK : UNDECIDED_SHORT;
}
