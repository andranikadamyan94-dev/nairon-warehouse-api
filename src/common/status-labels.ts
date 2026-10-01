import { ResourceReservationStatus } from './enums/resource-reservation-status.enum';
import { ProcurementOrderStatus } from './enums/procurement-order-status.enum';
import { MaintenanceStatus } from './enums/maintenance-status.enum';

/**
 * Armenian labels for the status enums, for use INSIDE human-readable error
 * messages only. Never compare against these — compare against the enums.
 *
 * The words are the ones the warehouse client shows in its status tags
 * (constants/strings.ts: statusTag, procurement.statusExtended +
 * procurementReceipt.statusFinanceRejected, maintenanceFinance.status*), so a
 * toast and the tag next to it name the same state the same way.
 */
export const RESERVATION_STATUS_LABELS: Record<ResourceReservationStatus, string> = {
  PENDING: 'Սպասող',
  APPROVED: 'Հասանելի',
  PARTIALLY_ALLOCATED: 'Մասամբ տրված',
  ALLOCATED: 'Տրված',
  COMPLETED: 'Ավարտված',
  CANCELLED: 'Չեղարկված',
  REJECTED: 'Մերժված',
};

export const PROCUREMENT_STATUS_LABELS: Record<ProcurementOrderStatus, string> = {
  DRAFT: 'Նախագիծ',
  PENDING_APPROVAL: 'Հաստատման սպասում',
  ORDERED: 'Պատվիրված',
  PENDING_FINANCE_APPROVAL: 'Ֆին. հաստատման սպասում',
  FINANCE_APPROVED: 'Ֆինանսը հաստատել է',
  FINANCE_REJECTED: 'Ֆինանսը մերժել է',
  PARTIALLY_RECEIVED: 'Մասնակի ստացված',
  RECEIVED: 'Ստացվել է',
  CLOSED_SHORT: 'Փակված թերի',
  CANCELLED: 'Չեղարկվել է',
};

export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  DRAFT: 'Ընթացիկ',
  PENDING_FINANCE: 'Ֆինանսական հաստատում',
  FINANCE_APPROVED: 'Ֆինանսական հաստատում հաջողվել է',
  FINANCE_REJECTED: 'Ֆինանսը մերժել է',
  IN_PROGRESS: 'Ընթացիկ',
  COMPLETED: 'Ավարտվել է',
};

/** Falls back to the raw key for a value the map does not know (defensive; the enums are exhaustive). */
export const reservationStatusLabel = (status: string): string =>
  RESERVATION_STATUS_LABELS[status as ResourceReservationStatus] ?? status;

export const procurementStatusLabel = (status: string): string =>
  PROCUREMENT_STATUS_LABELS[status as ProcurementOrderStatus] ?? status;

export const maintenanceStatusLabel = (status: string): string =>
  MAINTENANCE_STATUS_LABELS[status as MaintenanceStatus] ?? status;
