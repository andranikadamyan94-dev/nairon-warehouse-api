/**
 * Fill in who asked, for reservations made before the question was asked.
 *
 * WHAT IT WILL AND WILL NOT DO
 *
 * `requesterWorkspaceId` is the company whose work requested a resource, and
 * the authority on that is the CRM project the reservation was raised against.
 * This reads each reservation's `projectId`, asks CRM whose work that project
 * is, and writes the answer down.
 *
 * It does not guess. Three things it deliberately leaves alone:
 *
 *   - a reservation whose project no longer exists. Twelve rows here point at
 *     projects 14, 51 and 52, which were deleted; ten of those reservations are
 *     still in live states. They stay NULL and are listed at the end.
 *   - the old `entityId` label. It stays exactly as it is, because it is the
 *     history of what callers sent and rewriting history to make a column look
 *     tidy is how the ambiguity started.
 *   - any row that already has a requester. A second run changes nothing.
 *
 * Run with --apply to write; without it, it only reports.
 *
 *   node scripts/backfill-requester-workspace.mjs            # what it would do
 *   node scripts/backfill-requester-workspace.mjs --apply    # do it
 *
 * Local only. Needs crm-api on :3003 and the dev Postgres container.
 */
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const CRM = process.env.CRM_API_URL ?? 'http://127.0.0.1:3003';
const SECRET = process.env.INTERNAL_SECRET ?? 'nairon-internal';

const SEP = String.fromCharCode(31);
const psql = (db, sql) =>
  execFileSync(
    'docker',
    ['exec', '-i', 'nairon-dev-postgres', 'psql', '-U', 'nairon', '-d', db, '-t', '-A', '-F', SEP, '-c', sql],
    { encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^(INSERT|UPDATE|DELETE) \d+( \d+)?$/.test(l.trim()));

const workspaceOfProject = new Map();
async function askCrm(projectId) {
  if (workspaceOfProject.has(projectId)) return workspaceOfProject.get(projectId);
  let answer = null;
  try {
    const res = await fetch(`${CRM}/api/projects/${projectId}/workspace/internal`, {
      headers: { 'x-internal-secret': SECRET },
    });
    if (res.ok) {
      const body = await res.json();
      answer = body?.found && Number(body.entityId) > 0 ? Number(body.entityId) : null;
    }
  } catch {
    answer = null;
  }
  workspaceOfProject.set(projectId, answer);
  return answer;
}

const rows = psql(
  'nairon_warehouse',
  `SELECT r.id, coalesce(r."projectId", 0), coalesce(r."taskId", 0), coalesce(r."entityId", 0),
          coalesce(c."entityId", 0), r.status, coalesce(r."requesterWorkspaceId", 0)
     FROM "ResourceReservation" r
     JOIN "Item" i ON i.id = r."itemId"
     LEFT JOIN "ItemCategory" c ON c.id = i."categoryId"
     ORDER BY r.id`,
).map((l) => {
  const [id, projectId, taskId, label, stockOwner, status, already] = l.split(SEP);
  return {
    id: Number(id),
    projectId: Number(projectId),
    taskId: Number(taskId),
    label: Number(label),
    stockOwner: Number(stockOwner),
    status,
    already: Number(already),
  };
});

const resolved = [];
const unresolved = [];
const skipped = [];

for (const row of rows) {
  if (row.already > 0) {
    skipped.push(row);
    continue;
  }
  const requester = row.projectId > 0 ? await askCrm(row.projectId) : null;
  if (requester === null) unresolved.push(row);
  else resolved.push({ ...row, requester });
}

console.log(`reservations                  ${rows.length}`);
console.log(`already answered              ${skipped.length}`);
console.log(`can be answered from CRM      ${resolved.length}`);
console.log(`cannot — left NULL            ${unresolved.length}`);

const cross = resolved.filter((r) => r.stockOwner > 0 && r.requester !== r.stockOwner).length;
const same = resolved.filter((r) => r.stockOwner > 0 && r.requester === r.stockOwner).length;
console.log(`  of those: cross-company     ${cross}`);
console.log(`            same company      ${same}`);

const agrees = resolved.filter((r) => r.label > 0 && r.label === r.requester).length;
const namesOwner = resolved.filter((r) => r.label > 0 && r.label === r.stockOwner && r.label !== r.requester).length;
const namesNeither = resolved.filter(
  (r) => r.label > 0 && r.label !== r.requester && r.label !== r.stockOwner,
).length;
console.log(`\nwhat the old label was saying, on the rows we can now check:`);
console.log(`  agrees with the requester   ${agrees}`);
console.log(`  names the STOCK OWNER       ${namesOwner}`);
console.log(`  names neither               ${namesNeither}`);
console.log(`  was empty                   ${resolved.filter((r) => r.label === 0).length}`);

if (unresolved.length) {
  console.log(`\nleft unresolved — CRM cannot say whose work these were:`);
  const byProject = new Map();
  for (const r of unresolved) {
    const k = r.projectId || 'no project';
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k).push(r);
  }
  for (const [project, list] of byProject) {
    const live = list.filter((r) => !['CANCELLED', 'REJECTED', 'COMPLETED'].includes(r.status));
    console.log(
      `  project ${project}: ${list.length} reservation(s), ${live.length} still live — ids ${list.map((r) => r.id).join(', ')}`,
    );
  }
}

if (!APPLY) {
  console.log('\nnothing written. Re-run with --apply to write the answers above.');
  process.exit(0);
}

for (const r of resolved) {
  psql(
    'nairon_warehouse',
    `UPDATE "ResourceReservation" SET "requesterWorkspaceId" = ${r.requester}
       WHERE id = ${r.id} AND "requesterWorkspaceId" IS NULL`,
  );
}

/* Validation after the fact, from the database rather than from this process. */
const [filled, nulls] = psql(
  'nairon_warehouse',
  `SELECT count(*) FILTER (WHERE "requesterWorkspaceId" IS NOT NULL),
          count(*) FILTER (WHERE "requesterWorkspaceId" IS NULL)
     FROM "ResourceReservation"`,
)[0].split(SEP);

console.log(`\nwritten. ${filled} reservations now say who asked; ${nulls} still cannot.`);
if (Number(filled) !== skipped.length + resolved.length) {
  console.error('MISMATCH: the database does not agree with what this run intended to write.');
  process.exit(1);
}
