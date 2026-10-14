-- 2026-10-14 (owner: every requisition has an approval desk in the warehouse
-- queue): a keeper's «Գնման հայտ» raised for a request's short stock lines
-- belongs to that request. New ones are linked on create
-- (PurchaseRequisitionsService.submissionOfLines); this links the existing
-- ones by the same rule — every line is a reservation's shortfall and all the
-- reservations belong to one request.
-- Idempotent: only rows still without a request are touched, so a re-run
-- does nothing.

UPDATE "PurchaseRequisition" pr
SET "submissionId" = linked.sid
FROM (
  SELECT l."requisitionId" AS rid, MIN(r."submissionId") AS sid
  FROM "PurchaseRequisitionLine" l
  LEFT JOIN "ResourceReservation" r ON r."id" = l."reservationId"
  GROUP BY l."requisitionId"
  HAVING COUNT(*) FILTER (WHERE r."submissionId" IS NULL) = 0
     AND COUNT(DISTINCT r."submissionId") = 1
) linked
WHERE pr."id" = linked.rid
  AND pr."submissionId" IS NULL;
