export enum ProcurementOrderStatus {
  DRAFT = 'DRAFT',
  ORDERED = 'ORDERED',
  PENDING_FINANCE_APPROVAL = 'PENDING_FINANCE_APPROVAL',
  FINANCE_APPROVED = 'FINANCE_APPROVED',
  FINANCE_REJECTED = 'FINANCE_REJECTED',
  /** Some but not all of the ordered quantity has arrived. */
  PARTIALLY_RECEIVED = 'PARTIALLY_RECEIVED',
  RECEIVED = 'RECEIVED',
  /** Settled at less than ordered — the remainder is not coming. */
  CLOSED_SHORT = 'CLOSED_SHORT',
  CANCELLED = 'CANCELLED',
}
