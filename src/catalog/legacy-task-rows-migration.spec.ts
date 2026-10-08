import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Migration 20261008150000_legacy_task_rows_to_submissions (owner 2026-10-08):
 * every task request filed before the catalog — a reservation with a task
 * and no submission — is wrapped into a CatalogSubmission on deploy, rows
 * filed by the same person for the same task within the same minute as ONE
 * submission (one REQ number); a second run changes nothing; an empty table
 * is fine. Runs the migration's SQL against the local database (DATABASE_URL
 * from .env) on seeded rows that name a task CRM does not have, and removes
 * them afterwards. Without a reachable database the cases are skipped, not
 * failed.
 */
const ROOT = join(__dirname, '..', '..');
const SQL_PATH = join(ROOT, 'prisma', 'migrations', '20261008150000_legacy_task_rows_to_submissions', 'migration.sql');
const TASK_A = 987654001; // no such task anywhere
const TASK_B = 987654002;
const STAMP = `legacy-task-mig-${Date.now()}`;

function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

let prisma: any = null;
let itemId = 0;
const made = { reservations: [] as number[] };

beforeAll(async () => {
  loadEnv();
  if (!process.env.DATABASE_URL) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    prisma = null;
  }
});

afterAll(async () => {
  if (!prisma) return;
  try {
    const subs = await prisma.catalogSubmission.findMany({ where: { taskId: { in: [TASK_A, TASK_B] } }, select: { id: true } });
    await prisma.resourceReservation.updateMany({ where: { taskId: { in: [TASK_A, TASK_B] } }, data: { submissionId: null } });
    await prisma.catalogSubmission.deleteMany({ where: { id: { in: subs.map((s: any) => s.id) } } });
    await prisma.reservationStatusHistory.deleteMany({ where: { reservationId: { in: made.reservations } } });
    await prisma.resourceReservation.deleteMany({ where: { id: { in: made.reservations } } });
    if (itemId) await prisma.item.delete({ where: { id: itemId } }).catch(() => undefined);
  } finally {
    await prisma.$disconnect();
  }
});

const migrate = () => prisma.$executeRawUnsafe(readFileSync(SQL_PATH, 'utf8'));

const seed = async (over: Record<string, any>, history: { performedBy: number | null; reason: string | null } | null) => {
  const createdAt = over.createdAt ?? new Date('2026-09-20T08:00:00.000Z');
  const row = await prisma.resourceReservation.create({
    data: {
      itemId,
      quantity: 3,
      taskId: TASK_A,
      objectId: null,
      projectId: 4343,
      projectName: `Project ${STAMP}`,
      entityId: 1,
      startDate: createdAt,
      endDate: new Date('2026-09-25T08:00:00.000Z'),
      status: 'APPROVED',
      ...over,
      createdAt,
    },
  });
  made.reservations.push(row.id);
  if (history) {
    await prisma.reservationStatusHistory.create({
      data: { reservationId: row.id, toStatus: over.status ?? 'APPROVED', performedBy: history.performedBy, reason: history.reason, performedAt: createdAt },
    });
  }
  return row;
};

const itDb = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!prisma) {
      console.warn(`skipped (no database): ${name}`);
      return;
    }
    await fn();
  });

describe('legacy task rows → catalog submissions (data migration)', () => {
  itDb('groups rows filed by the same person for the same task in the same minute into one submission; other minutes, people and tasks get their own; a wrapped row is left alone; running it again changes nothing', async () => {
    const item = await prisma.item.create({ data: { name: `[TEST] ${STAMP}`, type: 'CONSUMABLE', unit: 'KG', quantity: 0 } });
    itemId = item.id;
    const t0 = new Date('2026-09-20T08:00:05.000Z');
    const t0b = new Date('2026-09-20T08:00:40.000Z'); // same minute, same filer → same submission
    const t1 = new Date('2026-09-20T08:03:00.000Z'); // another minute → another submission
    // One old form: two lines sent together by 7 (a note on the first), and an HOUR-style second row 35 s later.
    const a1 = await seed({ createdAt: t0, notes: '  Հիմքի համար  ', endDate: new Date('2026-09-25T08:00:00.000Z') }, { performedBy: 7, reason: 'Հայտ' });
    const a2 = await seed({ createdAt: t0b, notes: null, endDate: new Date('2026-09-28T08:00:00.000Z') }, { performedBy: 7, reason: 'Հայտ' });
    // Same minute, different filer → its own submission.
    const b = await seed({ createdAt: t0, notes: null }, { performedBy: 8, reason: 'Հայտ' });
    // Later minute, filer 7 → its own submission; cancelled rows are wrapped too (the view derives the status).
    const c = await seed({ createdAt: t1, status: 'CANCELLED', endDate: null }, { performedBy: 7, reason: 'Հայտ' });
    // No history at all → filer 0.
    const orphan = await seed({ createdAt: t1, taskId: TASK_B }, null);
    // Already wrapped: untouched.
    const wrapped = await seed({ createdAt: t1, taskId: TASK_B }, { performedBy: 9, reason: 'Հայտ' });
    const existing = await prisma.catalogSubmission.create({
      data: { number: `REQ-${STAMP}`, createdBy: 9, taskId: TASK_B, purpose: 'already', neededBy: new Date('2026-09-25'), reminders: [] },
    });
    await prisma.resourceReservation.update({ where: { id: wrapped.id }, data: { submissionId: existing.id } });

    // Only this spec's tasks: other DB-backed specs and the local app may add submissions meanwhile.
    const before = await prisma.catalogSubmission.count({ where: { taskId: { in: [TASK_A, TASK_B] } } });
    await migrate();

    const rows = await prisma.resourceReservation.findMany({ where: { id: { in: made.reservations } } });
    const byId = new Map<number, any>(rows.map((r: any) => [r.id, r]));
    for (const id of [a1.id, a2.id, b.id, c.id, orphan.id]) expect(byId.get(id).submissionId).toEqual(expect.any(Number));
    expect(byId.get(wrapped.id).submissionId).toBe(existing.id);
    // a1 + a2 share one submission; b, c, orphan each get their own → 4 new.
    expect(byId.get(a1.id).submissionId).toBe(byId.get(a2.id).submissionId);
    const subIds = [...new Set([a1, b, c, orphan].map((r) => byId.get(r.id).submissionId))];
    expect(subIds.length).toBe(4);
    expect(await prisma.catalogSubmission.count({ where: { taskId: { in: [TASK_A, TASK_B] } } })).toBe(before + 4);

    const subs = await prisma.catalogSubmission.findMany({ where: { id: { in: subIds } } });
    const subOf = (r: any) => subs.find((s: any) => s.id === byId.get(r.id).submissionId);
    for (const s of subs) {
      expect(s.number).toMatch(/^REQ-\d{4,}$/);
      expect(s.projectId).toBe(4343);
      expect(s.projectName).toBe(`Project ${STAMP}`);
      expect(s.entityId).toBe(1);
      expect(s.objectId).toBeNull();
    }
    expect(new Set(subs.map((s: any) => s.number)).size).toBe(4);
    expect(subOf(a1)).toMatchObject({ createdBy: 7, taskId: TASK_A, purpose: 'Հիմքի համար' });
    expect(new Date(subOf(a1).createdAt).toISOString()).toBe(t0.toISOString());
    expect(new Date(subOf(a1).neededBy).toISOString().slice(0, 10)).toBe('2026-09-28'); // the group's latest end date
    expect(subOf(b)).toMatchObject({ createdBy: 8, taskId: TASK_A, purpose: 'Առաջադրանքի հայտ (մինչև կատալոգը)' });
    expect(subOf(c)).toMatchObject({ createdBy: 7, taskId: TASK_A });
    expect(new Date(subOf(c).neededBy).toISOString().slice(0, 10)).toBe('2026-09-20'); // no end date → the creation date
    expect(subOf(orphan)).toMatchObject({ createdBy: 0, taskId: TASK_B, purpose: 'Առաջադրանքի հայտ (մինչև կատալոգը)' });

    // The catalog's own counter moved on: the next number is above every number given here.
    const next = (await prisma.$queryRaw`SELECT last_value FROM "CatalogSubmission_number_seq"`)[0].last_value;
    expect(Math.max(...subs.map((s: any) => Number(s.number.slice(4))))).toBe(Number(next));

    // Idempotent: a second run wraps nothing and renumbers nothing.
    await migrate();
    expect(await prisma.catalogSubmission.count({ where: { taskId: { in: [TASK_A, TASK_B] } } })).toBe(before + 4);
    const again = await prisma.resourceReservation.findMany({ where: { id: { in: made.reservations } } });
    for (const r of again) expect(r.submissionId).toBe(byId.get(r.id).submissionId);
    expect(Number((await prisma.$queryRaw`SELECT last_value FROM "CatalogSubmission_number_seq"`)[0].last_value)).toBe(Number(next));
  });

  itDb('nothing to wrap: the migration runs through on a table with no legacy rows', async () => {
    const before = await prisma.catalogSubmission.count();
    await migrate();
    expect(await prisma.catalogSubmission.count()).toBe(before);
  });
});
