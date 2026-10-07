import { BadRequestException } from '@nestjs/common';
import {
  AssetRequestStatus,
  PurchaseRequisitionStatus,
  ResourceReservationStatus,
} from '@prisma/client';

/**
 * Project duplicate (2026-10-07) — the pure part: what crm sends, and what
 * status each copied warehouse row starts in.
 *
 * Status rules (build spec §2.2, owner decisions §11.1):
 *  - reservations: REJECTED / CANCELLED keep their status; every other row is
 *    re-created by the normal create rule (APPROVED when free, else PENDING) —
 *    that part needs the database and lives in ReservationsService.
 *  - purchase requisitions: draft / waiting / rejected / cancelled stay; the
 *    approved-or-further ones go back to PENDING_APPROVAL.
 *  - asset requests: APPROVED / ISSUED go back to PENDING.
 */

export interface ProjectCopyBody {
  jobId?: unknown;
  projectIdMap?: unknown;
  taskIdMap?: unknown;
  objectIdMap?: unknown;
  projectNames?: unknown;
  /** Whole days every copied date moves by (2026-10-07); absent = 0. */
  dateShiftDays?: unknown;
}

export interface ProjectCopyInput {
  jobId: string;
  projects: Map<number, number>;
  tasks: Map<number, number>;
  objects: Map<number, number>;
  names: Map<number, string>;
  shiftDays: number;
}

/** At most ~10 years either way: anything bigger is a bug, not a plan. */
const MAX_SHIFT_DAYS = 3660;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The optional date shift crm sends: a whole number of days, default 0. */
export function parseShiftDays(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || Math.abs(n) > MAX_SHIFT_DAYS) {
    throw new BadRequestException('dateShiftDays-ը պետք է լինի ամբողջ թիվ (օր)');
  }
  return n;
}

/** `d` moved by `days` whole days (UTC arithmetic: no DST drift). Null stays null. */
export function shiftDate<T extends Date | null | undefined>(d: T, days: number): T {
  if (!d || !days) return d;
  return new Date(new Date(d).getTime() + days * DAY_MS) as T;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertJobId(jobId: unknown): string {
  if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) {
    throw new BadRequestException('jobId-ն պետք է լինի UUID');
  }
  return jobId.toLowerCase();
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function idMap(raw: unknown, label: string): Map<number, number> {
  const out = new Map<number, number>();
  if (raw == null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException(`${label}-ը սխալ է`);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const from = positiveInt(k);
    const to = positiveInt(v);
    if (from === null || to === null) throw new BadRequestException(`${label}-ը սխալ է (${k})`);
    out.set(from, to);
  }
  return out;
}

export function parseCopyBody(body: ProjectCopyBody | null | undefined): ProjectCopyInput {
  const b = body ?? {};
  const jobId = assertJobId(b.jobId);
  const projects = idMap(b.projectIdMap, 'projectIdMap');
  if (!projects.size) throw new BadRequestException('projectIdMap-ը դատարկ է');
  const names = new Map<number, string>();
  if (b.projectNames != null) {
    if (typeof b.projectNames !== 'object' || Array.isArray(b.projectNames)) {
      throw new BadRequestException('projectNames-ը սխալ է');
    }
    for (const [k, v] of Object.entries(b.projectNames as Record<string, unknown>)) {
      const id = positiveInt(k);
      if (id !== null && typeof v === 'string' && v.trim()) names.set(id, v.trim());
    }
  }
  return {
    jobId,
    projects,
    tasks: idMap(b.taskIdMap, 'taskIdMap'),
    objects: idMap(b.objectIdMap, 'objectIdMap'),
    names,
    shiftDays: parseShiftDays(b.dateShiftDays),
  };
}

/** Reservations whose status the copy keeps; every other one goes through the create rule. */
export const KEPT_RESERVATION_STATUSES: ReadonlySet<ResourceReservationStatus> = new Set([
  ResourceReservationStatus.REJECTED,
  ResourceReservationStatus.CANCELLED,
]);

/** Originals that had been approved or further — the ones the copy "resets". */
export const RESET_RESERVATION_STATUSES: ReadonlySet<ResourceReservationStatus> = new Set([
  ResourceReservationStatus.APPROVED,
  ResourceReservationStatus.PARTIALLY_ALLOCATED,
  ResourceReservationStatus.ALLOCATED,
  ResourceReservationStatus.COMPLETED,
]);

const REQUISITION_RESET: ReadonlySet<PurchaseRequisitionStatus> = new Set([
  PurchaseRequisitionStatus.SUBMITTED,
  PurchaseRequisitionStatus.IN_REVIEW,
  PurchaseRequisitionStatus.APPROVED,
  PurchaseRequisitionStatus.FULFILLED,
]);

export function copiedRequisitionStatus(status: PurchaseRequisitionStatus): PurchaseRequisitionStatus {
  return REQUISITION_RESET.has(status) ? PurchaseRequisitionStatus.PENDING_APPROVAL : status;
}

export function copiedAssetRequestStatus(status: AssetRequestStatus): AssetRequestStatus {
  return status === AssetRequestStatus.APPROVED || status === AssetRequestStatus.ISSUED
    ? AssetRequestStatus.PENDING
    : status;
}

/** The history note on every copied reservation. */
export function copyHistoryReason(oldId: number, oldStatus: string): string {
  return `Ստեղծվել է նախագծի պատճենմամբ (բնօրինակ #${oldId}, ${oldStatus})`;
}

export function emptyCounts() {
  return { projectLinks: 0, estimateLines: 0, submissions: 0, reservations: 0, requisitions: 0, assetRequests: 0 };
}
export type CopyCounts = ReturnType<typeof emptyCounts>;
export type ResetCounts = { reservations: number; requisitions: number; assetRequests: number };
