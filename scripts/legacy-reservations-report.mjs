/**
 * The reservations nobody can say who asked for.
 *
 * Their CRM projects were deleted, so `requesterWorkspaceId` is NULL and stays
 * NULL — the domain refuses to act on them from inside a company rather than
 * guessing one, which is the right way round and also means somebody has to
 * decide what they are.
 *
 * This is that list, bounded and boring on purpose: the reservation, what it
 * pointed at, where it stands, whose stock it draws on, how much, and when it
 * was made. No project names, no people, no notes — nothing about anybody, and
 * nothing a reader would need a reason to see.
 *
 *   node scripts/legacy-reservations-report.mjs           # readable
 *   node scripts/legacy-reservations-report.mjs --json    # for a ticket
 *
 * Read-only. It writes nothing and fixes nothing.
 */
import { execFileSync } from 'node:child_process';

const AS_JSON = process.argv.includes('--json');
const SEP = String.fromCharCode(31);

const psql = (sql) =>
  execFileSync(
    'docker',
    ['exec', '-i', 'nairon-dev-postgres', 'psql', '-U', 'nairon', '-d', 'nairon_warehouse', '-t', '-A', '-F', SEP, '-c', sql],
    { encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .filter((l) => l.trim());

const LIVE = ['PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED'];

const rows = psql(
  `SELECT r.id,
          coalesce(r."projectId", 0),
          coalesce(r."taskId", 0),
          r.status,
          coalesce(c."entityId", 0),
          r.quantity,
          coalesce((SELECT sum(a.quantity) FROM "ReservationAllocation" a
                      WHERE a."reservationId" = r.id AND a."releasedAt" IS NULL), 0),
          to_char(r."createdAt", 'YYYY-MM-DD'),
          i.name
     FROM "ResourceReservation" r
     JOIN "Item" i ON i.id = r."itemId"
     LEFT JOIN "ItemCategory" c ON c.id = i."categoryId"
    WHERE r."requesterWorkspaceId" IS NULL
    ORDER BY r.id`,
).map((l) => {
  const [id, projectId, taskId, status, stockOwner, requested, out, createdAt, itemName] = l.split(SEP);
  return {
    reservationId: Number(id),
    projectId: Number(projectId) || null,
    taskId: Number(taskId) || null,
    status,
    stockOwnerWorkspaceId: Number(stockOwner) || null,
    requested: Number(requested),
    stillOut: Number(out),
    createdAt,
    item: itemName,
  };
});

if (AS_JSON) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), reservations: rows }, null, 2));
} else {
  const live = rows.filter((r) => LIVE.includes(r.status));
  const holding = rows.filter((r) => r.stillOut > 0);

  console.log(`reservations with no requester   ${rows.length}`);
  console.log(`  still live                     ${live.length}`);
  console.log(`  with stock still out           ${holding.length}`);
  console.log('');

  if (!rows.length) {
    console.log('Nothing to remediate.');
  } else {
    const width = (k, min) => Math.max(min, ...rows.map((r) => String(r[k] ?? '').length));
    const w = { reservationId: width('reservationId', 4), item: width('item', 6), status: width('status', 6) };
    console.log(
      `${'id'.padEnd(w.reservationId)}  ${'item'.padEnd(w.item)}  ${'status'.padEnd(w.status)}  project  task    owner  req  out  made`,
    );
    for (const r of rows) {
      console.log(
        [
          String(r.reservationId).padEnd(w.reservationId),
          String(r.item).padEnd(w.item),
          String(r.status).padEnd(w.status),
          String(r.projectId ?? '—').padStart(7),
          String(r.taskId ?? '—').padStart(6),
          String(r.stockOwnerWorkspaceId ?? '—').padStart(7),
          String(r.requested).padStart(4),
          String(r.stillOut).padStart(4),
          ` ${r.createdAt}`,
        ].join('  '),
      );
    }
    console.log('');
    console.log('What a product owner has to decide, per row: whose work this was, or');
    console.log('whether the reservation should be cancelled. Until then each one is');
    console.log('refused to any company-scoped actor, which is the safe direction.');
    if (holding.length) {
      console.log('');
      console.log(`${holding.length} of them still have stock out. Those are the urgent ones.`);
    }
  }
}
