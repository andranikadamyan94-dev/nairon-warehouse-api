/**
 * The life of one maintenance job.
 *
 * DRAFT is being written up. PENDING_FINANCE is with finance, looking at an
 * amount. FINANCE_APPROVED and FINANCE_REJECTED are their answer. IN_PROGRESS
 * is the work happening, COMPLETED is it done and the asset back in service.
 *
 * Mirrors the Prisma enum. Declared separately for the same reason as the
 * others in this folder: the services compare against these in code that has no
 * business importing a generated client.
 */
export enum MaintenanceStatus {
  DRAFT = 'DRAFT',
  PENDING_FINANCE = 'PENDING_FINANCE',
  FINANCE_APPROVED = 'FINANCE_APPROVED',
  FINANCE_REJECTED = 'FINANCE_REJECTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}
