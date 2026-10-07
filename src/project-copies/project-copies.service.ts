import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ResourceReservationStatus } from '@prisma/client';

import { PrismaService } from 'prisma/prisma.service';
import { FileService } from '../common/file.service';
import { ReservationsService } from '../reservations/reservations.service';
import { formatSubmissionNumber } from '../catalog/catalog.rules';
import {
  assertJobId,
  copiedAssetRequestStatus,
  copiedRequisitionStatus,
  copyHistoryReason,
  CopyCounts,
  emptyCounts,
  KEPT_RESERVATION_STATUSES,
  parseCopyBody,
  ProjectCopyBody,
  ProjectCopyInput,
  RESET_RESERVATION_STATUSES,
  ResetCounts,
  shiftDate,
} from './project-copy.rules';

/** Long copies hold one transaction; the Prisma default (5 s) is far too short. */
const TX_OPTIONS = { maxWait: 30_000, timeout: 10 * 60_000 };

export interface ProjectCopyResult {
  jobId: string;
  replayed: boolean;
  counts: CopyCounts;
  reset: ResetCounts;
  /** Status the copied reservations landed in — APPROVED / PENDING by the create rule, kept REJECTED / CANCELLED. */
  reservationStatuses: Record<string, number>;
  /** Attachments whose file was missing on disk: the row keeps the old url. */
  missingFiles: number;
}

/**
 * Project duplicate (2026-10-07), warehouse side. crm-api copies a project tree
 * and sends its id maps here; this copies the warehouse rows that hang off the
 * copied projects, tasks and objects, in one transaction, tagged with the crm
 * job id (build spec §2, owner decisions §11).
 *
 * Every row is written with plain inserts — never through create / approve /
 * allocate / submit — so the copy sends no notification, moves no stock, trips
 * no low-stock latch and calls no other service. The one thing it borrows from
 * the reservations service is the create rule's measurement, under the same
 * item lock: a copied reservation gets the status a fresh request would.
 * Allocations, custody, movements, returns, orders and reminders are never copied.
 */
@Injectable()
export class ProjectCopiesService {
  private readonly logger = new Logger(ProjectCopiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationsService,
    private readonly files: FileService,
  ) {}

  async copy(body: ProjectCopyBody): Promise<ProjectCopyResult> {
    const input = parseCopyBody(body);
    const done = await this.prisma.warehouseProjectCopy.findUnique({ where: { jobId: input.jobId } });
    if (done) return this.replay(done);

    const written: string[] = [];
    try {
      const result = await this.prisma.$transaction((tx) => this.run(tx, input, written), TX_OPTIONS);
      this.logger.log(`project copy ${input.jobId}: ${JSON.stringify(result.counts)} reset=${JSON.stringify(result.reset)}`);
      return result;
    } catch (err) {
      for (const url of written) this.files.remove(url);
      // The same job arrived twice at once: the second waited on the first's
      // claim row and lost the race — answer what the first stored.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await this.prisma.warehouseProjectCopy.findUnique({ where: { jobId: input.jobId } });
        if (again) return this.replay(again);
      }
      throw err;
    }
  }

  private replay(row: { jobId: string; counts: unknown; reset: unknown }): ProjectCopyResult {
    const { reservationStatuses = {}, missingFiles = 0, ...rest } = (row.counts as any) ?? {};
    return {
      jobId: row.jobId,
      replayed: true,
      counts: { ...emptyCounts(), ...rest },
      reset: row.reset as ResetCounts,
      reservationStatuses,
      missingFiles,
    };
  }

  /** Copy a stored file; a missing one keeps the old url. */
  private copyFile(url: string | null, written: string[], missing: { n: number }): string | null {
    if (!url) return url;
    const copy = this.files.copy(url);
    if (!copy) {
      missing.n++;
      return url;
    }
    written.push(copy);
    return copy;
  }

  private async run(tx: any, input: ProjectCopyInput, written: string[]): Promise<ProjectCopyResult> {
    const { jobId, projects, tasks, objects, names, shiftDays } = input;
    // Every date the copy writes moves by the same whole number of days (crm
    // sends whole weeks when the source already had past dates); 0 = as is.
    const shift = <T extends Date | null | undefined>(d: T): T => shiftDate(d, shiftDays);
    // Claim the job first: a concurrent repeat blocks here until this commits.
    await tx.warehouseProjectCopy.create({ data: { jobId, counts: {}, reset: {}, files: [] } });

    const counts = emptyCounts();
    const reset: ResetCounts = { reservations: 0, requisitions: 0, assetRequests: 0 };
    const reservationStatuses: Record<string, number> = {};
    const missing = { n: 0 };
    const oldProjectIds = [...projects.keys()];
    const oldTaskIds = [...tasks.keys()];
    const oldObjectIds = [...objects.keys()];
    const newProject = (id: number | null) => (id == null ? null : projects.get(id) ?? id);
    const nameFor = (newId: number | null, fallback: string | null) =>
      (newId != null ? names.get(newId) : undefined) ?? fallback;

    // 1. Project → warehouse links. Unlinked sub-projects keep inheriting from
    //    their nearest linked ancestor, so the tree shape is enough.
    const links = await tx.warehouseProject.findMany({
      where: { projectId: { in: oldProjectIds } },
      orderBy: { id: 'asc' },
    });
    if (links.length) {
      await tx.warehouseProject.createMany({
        data: links.map((l: any) => {
          const projectId = projects.get(l.projectId)!;
          return { warehouseId: l.warehouseId, projectId, projectName: nameFor(projectId, l.projectName), copyJobId: jobId };
        }),
      });
    }
    counts.projectLinks = links.length;

    // 2. Object estimates — planning figures only.
    if (oldObjectIds.length) {
      const lines = await tx.objectEstimateLine.findMany({
        where: { objectId: { in: oldObjectIds } },
        orderBy: { id: 'asc' },
      });
      if (lines.length) {
        await tx.objectEstimateLine.createMany({
          data: lines.map((l: any) => ({
            objectId: objects.get(l.objectId)!,
            itemId: l.itemId,
            plannedQuantity: l.plannedQuantity,
            plannedUnitCost: l.plannedUnitCost,
            note: l.note,
            copyJobId: jobId,
          })),
        });
      }
      counts.estimateLines = lines.length;
    }

    // 3. Catalog submissions of the copied projects — a new REQ number each.
    const submissionMap = new Map<number, number>();
    const subs = await tx.catalogSubmission.findMany({
      where: { projectId: { in: oldProjectIds } },
      orderBy: { id: 'asc' },
    });
    for (const s of subs) {
      const seq = await tx.$queryRawUnsafe(`SELECT nextval('"CatalogSubmission_number_seq"') AS nextval`);
      const projectId = newProject(s.projectId);
      const made = await tx.catalogSubmission.create({
        data: {
          number: formatSubmissionNumber(seq[0].nextval),
          createdBy: s.createdBy,
          entityId: s.entityId,
          projectId,
          projectName: nameFor(projectId, s.projectName),
          costCenter: s.costCenter,
          purpose: s.purpose,
          neededBy: shift(s.neededBy),
          comment: s.comment,
          attachmentUrl: this.copyFile(s.attachmentUrl, written, missing),
          infoRequestText: s.infoRequestText,
          infoRequestBy: s.infoRequestBy,
          infoRequestAt: s.infoRequestAt,
          cancelledAt: s.cancelledAt,
          copyJobId: jobId,
        },
      });
      submissionMap.set(s.id, made.id);
    }
    counts.submissions = subs.length;

    // 4. Reservations: of a copied task, of a copied object (object requests,
    //    no task), or of a copied catalog submission.
    const or: any[] = [];
    if (oldTaskIds.length) or.push({ taskId: { in: oldTaskIds } });
    if (oldObjectIds.length) or.push({ taskId: null, objectId: { in: oldObjectIds } });
    if (submissionMap.size) or.push({ submissionId: { in: [...submissionMap.keys()] } });
    const sources: any[] = or.length
      ? await tx.resourceReservation.findMany({
          where: { OR: or },
          include: { statusHistory: { orderBy: { id: 'asc' } } },
        })
      : [];
    // Item order, then id: the create rule locks each item, and one fixed order
    // keeps this long transaction's locks predictable.
    sources.sort((a, b) => a.itemId - b.itemId || a.id - b.id);
    const reservationMap = new Map<number, number>();
    for (const r of sources) {
      const kept = KEPT_RESERVATION_STATUSES.has(r.status);
      const startDate = shift(r.startDate);
      const endDate = shift(r.endDate);
      // As if sent fresh (owner decision 11.1): measured now, in its own pool,
      // with every row this copy already made counted as a claim.
      const status: ResourceReservationStatus = kept
        ? r.status
        : await this.reservations.statusForCopiedReservation(tx, {
            itemId: r.itemId,
            quantity: r.quantity,
            // The stock rule looks at the dates the copy will actually hold.
            startDate,
            endDate,
            warehouseId: r.warehouseId,
          });
      const projectId = newProject(r.projectId);
      const made = await tx.resourceReservation.create({
        data: {
          itemId: r.itemId,
          taskId: r.taskId != null ? tasks.get(r.taskId) ?? null : null,
          projectId,
          projectName: nameFor(projectId, r.projectName),
          entityId: r.entityId,
          entityName: r.entityName,
          requesterWorkspaceId: r.requesterWorkspaceId,
          quantity: r.quantity,
          acceptedQuantity: 0,
          acceptanceComment: null,
          status,
          warehouseId: r.warehouseId,
          // An object outside the copy is not carried over (owner decision 11.3).
          objectId: r.objectId != null ? objects.get(r.objectId) ?? null : null,
          startDate,
          endDate,
          notes: r.notes,
          submissionId: r.submissionId != null ? submissionMap.get(r.submissionId) ?? null : null,
          copyJobId: jobId,
        },
      });
      reservationMap.set(r.id, made.id);
      const history: any[] = kept
        ? r.statusHistory.map((h: any) => ({
            reservationId: made.id,
            fromStatus: h.fromStatus,
            toStatus: h.toStatus,
            previousQuantity: h.previousQuantity,
            newQuantity: h.newQuantity,
            performedBy: h.performedBy,
            reason: h.reason,
            performedAt: h.performedAt,
          }))
        : [];
      history.push({
        reservationId: made.id,
        fromStatus: kept ? status : null,
        toStatus: status,
        reason: copyHistoryReason(r.id, r.status),
      });
      await tx.reservationStatusHistory.createMany({ data: history });
      if (RESET_RESERVATION_STATUSES.has(r.status)) reset.reservations++;
      reservationStatuses[status] = (reservationStatuses[status] ?? 0) + 1;
    }
    // Second pass: the replacement chain, only inside the copy.
    for (const r of sources) {
      const to = r.replacedByReservationId != null ? reservationMap.get(r.replacedByReservationId) : undefined;
      if (to) {
        await tx.resourceReservation.update({
          where: { id: reservationMap.get(r.id)! },
          data: { replacedByReservationId: to },
        });
      }
    }
    counts.reservations = sources.length;

    // 5. Purchase requisitions of a copied task or submission, with their
    //    lines, comments and (physically copied) attachments. Never an order.
    const reqOr: any[] = [];
    if (oldTaskIds.length) reqOr.push({ taskId: { in: oldTaskIds } });
    if (submissionMap.size) reqOr.push({ submissionId: { in: [...submissionMap.keys()] } });
    const reqs: any[] = reqOr.length
      ? await tx.purchaseRequisition.findMany({
          where: { OR: reqOr },
          orderBy: { id: 'asc' },
          include: {
            lines: { orderBy: { id: 'asc' } },
            comments: { orderBy: { id: 'asc' } },
            attachments: { orderBy: { id: 'asc' } },
          },
        })
      : [];
    for (const q of reqs) {
      const status = copiedRequisitionStatus(q.status);
      const wasReset = status !== q.status;
      if (wasReset) reset.requisitions++;
      await tx.purchaseRequisition.create({
        data: {
          status,
          title: q.title,
          comment: q.comment,
          periodStart: shift(q.periodStart),
          periodEnd: shift(q.periodEnd),
          entityId: q.entityId,
          createdBy: q.createdBy,
          taskId: q.taskId != null ? tasks.get(q.taskId) ?? null : null,
          taskOrigin: q.taskOrigin,
          // Never the original's order: markFulfilledForOrder would flip the copy too.
          orderId: null,
          // A reset row starts over: no review, decision or rejection stamps.
          ...(wasReset
            ? {}
            : {
                rejectionReason: q.rejectionReason,
                reviewedBy: q.reviewedBy,
                reviewedAt: q.reviewedAt,
                decidedBy: q.decidedBy,
                decidedAt: q.decidedAt,
                rejectionRequestedBy: q.rejectionRequestedBy,
                rejectionRequestedAt: q.rejectionRequestedAt,
                rejectionStage: q.rejectionStage,
                rejectionReturnStatus: q.rejectionReturnStatus
                  ? copiedRequisitionStatus(q.rejectionReturnStatus)
                  : null,
                rejectionConfirmedBy: q.rejectionConfirmedBy,
                rejectionConfirmedAt: q.rejectionConfirmedAt,
                rejectionDeclineNote: q.rejectionDeclineNote,
              }),
          submissionId: q.submissionId != null ? submissionMap.get(q.submissionId) ?? null : null,
          copyJobId: jobId,
          lines: {
            create: q.lines.map((l: any) => ({
              itemId: l.itemId,
              itemName: l.itemName,
              code: l.code,
              unit: l.unit,
              quantity: l.quantity,
              stockQuantity: l.stockQuantity,
              expectedQuantity: l.expectedQuantity,
              note: l.note,
              reservationId: l.reservationId != null ? reservationMap.get(l.reservationId) ?? null : null,
            })),
          },
          comments: {
            create: q.comments.map((c: any) => ({ userId: c.userId, text: c.text, createdAt: c.createdAt })),
          },
          attachments: {
            create: q.attachments.map((a: any) => ({
              uploadedBy: a.uploadedBy,
              name: a.name,
              url: this.copyFile(a.url, written, missing),
              size: a.size,
              mimeType: a.mimeType,
              createdAt: a.createdAt,
            })),
          },
        },
      });
    }
    counts.requisitions = reqs.length;

    // 6. Asset requests for a copied object. Personal ones are not the project's.
    if (oldObjectIds.length) {
      const asks = await tx.assetRequest.findMany({
        where: { kind: 'OBJECT', forObjectId: { in: oldObjectIds } },
        orderBy: { id: 'asc' },
      });
      if (asks.length) {
        await tx.assetRequest.createMany({
          data: asks.map((a: any) => {
            const status = copiedAssetRequestStatus(a.status);
            const wasReset = status !== a.status;
            if (wasReset) reset.assetRequests++;
            return {
              kind: a.kind,
              entityId: a.entityId,
              requestedBy: a.requestedBy,
              forUserId: a.forUserId,
              forObjectId: objects.get(a.forObjectId)!,
              itemId: a.itemId,
              quantity: a.quantity,
              reason: a.reason,
              status,
              decidedBy: wasReset ? null : a.decidedBy,
              decidedAt: wasReset ? null : a.decidedAt,
              decisionNote: wasReset ? null : a.decisionNote,
              copyJobId: jobId,
            };
          }),
        });
      }
      counts.assetRequests = asks.length;
    }

    await tx.warehouseProjectCopy.update({
      where: { jobId },
      data: { counts: { ...counts, reservationStatuses, missingFiles: missing.n }, reset, files: written },
    });
    return { jobId, replayed: false, counts, reset, reservationStatuses, missingFiles: missing.n };
  }

  /**
   * Undo a copy: every row tagged with the job (children cascade), and the
   * files the copy wrote. Safe to repeat; an unknown job deletes nothing.
   */
  async rollback(rawJobId: string) {
    const jobId = assertJobId(rawJobId);
    const { deleted, files } = await this.prisma.$transaction(async (tx: any) => {
      const job = await tx.warehouseProjectCopy.findUnique({ where: { jobId } });
      const ids = (
        await tx.resourceReservation.findMany({ where: { copyJobId: jobId }, select: { id: true } })
      ).map((r: { id: number }) => r.id);
      if (ids.length) {
        // The self-reference first, from either side, or the delete is refused.
        await tx.resourceReservation.updateMany({
          where: { OR: [{ copyJobId: jobId }, { replacedByReservationId: { in: ids } }] },
          data: { replacedByReservationId: null },
        });
      }
      const deleted = {
        reservations: (await tx.resourceReservation.deleteMany({ where: { copyJobId: jobId } })).count,
        requisitions: (await tx.purchaseRequisition.deleteMany({ where: { copyJobId: jobId } })).count,
        assetRequests: (await tx.assetRequest.deleteMany({ where: { copyJobId: jobId } })).count,
        submissions: (await tx.catalogSubmission.deleteMany({ where: { copyJobId: jobId } })).count,
        estimateLines: (await tx.objectEstimateLine.deleteMany({ where: { copyJobId: jobId } })).count,
        projectLinks: (await tx.warehouseProject.deleteMany({ where: { copyJobId: jobId } })).count,
      };
      await tx.warehouseProjectCopy.deleteMany({ where: { jobId } });
      return { deleted, files: Array.isArray(job?.files) ? (job.files as string[]) : [] };
    }, TX_OPTIONS);
    // Only files this copy wrote — never a file an original still points at.
    for (const url of files) this.files.remove(url);
    this.logger.log(`project copy ${jobId} rolled back: ${JSON.stringify(deleted)}`);
    return { jobId, deleted, files: files.length };
  }

  /**
   * What a copy of these ids would make, without making it (crm's progress
   * total). Old ids, as comma lists. A job already done answers its counts.
   */
  async preview(rawJobId: string, query: { projectIds?: string; taskIds?: string; objectIds?: string }) {
    const jobId = assertJobId(rawJobId);
    const done = await this.prisma.warehouseProjectCopy.findUnique({ where: { jobId } });
    if (done) return { jobId, done: true, counts: this.replay(done).counts };
    const list = (s?: string) =>
      (s ?? '')
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isSafeInteger(n) && n > 0);
    const projectIds = list(query.projectIds);
    const taskIds = list(query.taskIds);
    const objectIds = list(query.objectIds);
    const p = this.prisma;
    const subIds = (
      await p.catalogSubmission.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } })
    ).map((s) => s.id);
    const counts: CopyCounts = {
      projectLinks: await p.warehouseProject.count({ where: { projectId: { in: projectIds } } }),
      estimateLines: await p.objectEstimateLine.count({ where: { objectId: { in: objectIds } } }),
      submissions: subIds.length,
      reservations: await p.resourceReservation.count({
        where: {
          OR: [
            { taskId: { in: taskIds } },
            { taskId: null, objectId: { in: objectIds } },
            { submissionId: { in: subIds } },
          ],
        },
      }),
      requisitions: await p.purchaseRequisition.count({
        where: { OR: [{ taskId: { in: taskIds } }, { submissionId: { in: subIds } }] },
      }),
      assetRequests: await p.assetRequest.count({ where: { kind: 'OBJECT', forObjectId: { in: objectIds } } }),
    };
    return { jobId, done: false, counts };
  }
}
