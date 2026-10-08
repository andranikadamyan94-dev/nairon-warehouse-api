import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Migration 20261008130000_legacy_object_rows_to_submissions (owner 2026-10-08):
 * every object request filed before the catalog — a reservation with an
 * object, no task and no submission — is wrapped into its own CatalogSubmission
 * on deploy, with no manual step; a second run changes nothing; an empty table
 * is fine. Runs the migration's SQL against the local database (DATABASE_URL
 * from .env) on seeded rows that name an object CRM does not have, and
 * removes them afterwards. Without a reachable database the cases are skipped,
 * not failed.
 */
const ROOT = join(__dirname, '..', '..');
const SQL_PATH = join(ROOT, 'prisma', 'migrations', '20261008130000_legacy_object_rows_to_submissions', 'migration.sql');
const OBJECT = 987654321; // no such object anywhere
const STAMP = `legacy-mig-${Date.now()}`;

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
    const subs = await prisma.catalogSubmission.findMany({ where: { objectId: OBJECT }, select: { id: true } });
    await prisma.resourceReservation.updateMany({ where: { objectId: OBJECT }, data: { submissionId: null } });
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
  const start = new Date('2026-09-29T08:00:00.000Z');
  const row = await prisma.resourceReservation.create({
    data: {
      itemId,
      quantity: 3,
      taskId: null,
      objectId: OBJECT,
      projectId: 4242,
      projectName: `Project ${STAMP}`,
      entityId: 1,
      startDate: start,
      endDate: new Date('2027-09-29T08:00:00.000Z'),
      status: 'APPROVED',
      createdAt: start,
      ...over,
    },
  });
  made.reservations.push(row.id);
  if (history) {
    await prisma.reservationStatusHistory.create({
      data: { reservationId: row.id, toStatus: over.status ?? 'APPROVED', performedBy: history.performedBy, reason: history.reason, performedAt: start },
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

describe('legacy object rows → catalog submissions (data migration)', () => {
  itDb('wraps each legacy object row into its own submission with the catalog’s number, the filer, the object’s project, a purpose and dates; a task row and a wrapped row are left alone; running it again changes nothing', async () => {
    const item = await prisma.item.create({ data: { name: `[TEST] ${STAMP}`, type: 'CONSUMABLE', unit: 'KG', quantity: 0 } });
    itemId = item.id;
    const asked = await seed({}, { performedBy: 7, reason: 'Օբյեկտի հայտ — բետոնի համար' });
    const plain = await seed({ status: 'COMPLETED', endDate: null }, { performedBy: 8, reason: 'Օբյեկտի հայտ' });
    const direct = await seed({ notes: null }, { performedBy: 9, reason: 'Պահեստը տրամադրում է օբյեկտին' });
    const noted = await seed({ notes: '  Ցանկապատի համար  ' }, { performedBy: 10, reason: 'Օբյեկտի հայտ — ignored when a note exists' });
    const orphan = await seed({}, null);
    const taskRow = await seed({ taskId: 1 }, { performedBy: 7, reason: 'task' });

    // Only this spec's object: other DB-backed specs and the local app may add submissions meanwhile.
    const before = await prisma.catalogSubmission.count({ where: { objectId: OBJECT } });
    await migrate();

    const rows = await prisma.resourceReservation.findMany({ where: { id: { in: made.reservations } } });
    const byId = new Map<number, any>(rows.map((r: any) => [r.id, r]));
    for (const id of [asked.id, plain.id, direct.id, noted.id, orphan.id]) expect(byId.get(id).submissionId).toEqual(expect.any(Number));
    expect(byId.get(taskRow.id).submissionId).toBeNull();
    const subIds = [asked, plain, direct, noted, orphan].map((r) => byId.get(r.id).submissionId);
    expect(new Set(subIds).size).toBe(5);
    expect(await prisma.catalogSubmission.count({ where: { objectId: OBJECT } })).toBe(before + 5);

    const subs = await prisma.catalogSubmission.findMany({ where: { id: { in: subIds } } });
    const subOf = (r: any) => subs.find((s: any) => s.id === byId.get(r.id).submissionId);
    for (const s of subs) {
      expect(s.number).toMatch(/^REQ-\d{4,}$/);
      expect(s.objectId).toBe(OBJECT);
      expect(s.projectId).toBe(4242);
      expect(s.projectName).toBe(`Project ${STAMP}`);
      expect(s.entityId).toBe(1);
      expect(new Date(s.createdAt).toISOString()).toBe('2026-09-29T08:00:00.000Z');
    }
    expect(new Set(subs.map((s: any) => s.number)).size).toBe(5);
    expect(subOf(asked)).toMatchObject({ createdBy: 7, purpose: 'բետոնի համար' });
    expect(new Date(subOf(asked).neededBy).toISOString().slice(0, 10)).toBe('2027-09-29');
    expect(subOf(plain)).toMatchObject({ createdBy: 8, purpose: 'Պահեստային հայտ (մինչև կատալոգը)' });
    expect(new Date(subOf(plain).neededBy).toISOString().slice(0, 10)).toBe('2026-09-29'); // no end date → the creation date
    expect(subOf(direct)).toMatchObject({ createdBy: 9, purpose: 'Պահեստից՝ առանց հայտի' });
    expect(subOf(noted)).toMatchObject({ createdBy: 10, purpose: 'Ցանկապատի համար' });
    expect(subOf(orphan)).toMatchObject({ createdBy: 0, purpose: 'Պահեստային հայտ (մինչև կատալոգը)' });

    // The catalog's own counter moved on: the next number is above every number given here.
    const next = (await prisma.$queryRaw`SELECT last_value FROM "CatalogSubmission_number_seq"`)[0].last_value;
    // (>= rather than ===: another DB-backed spec may draw from the same counter while this one runs)
    expect(Number(next)).toBeGreaterThanOrEqual(Math.max(...subs.map((s: any) => Number(s.number.slice(4)))));

    // Idempotent: a second run wraps nothing and renumbers nothing.
    await migrate();
    expect(await prisma.catalogSubmission.count({ where: { objectId: OBJECT } })).toBe(before + 5);
    const again = await prisma.resourceReservation.findMany({ where: { id: { in: made.reservations } } });
    for (const r of again) expect(r.submissionId).toBe(byId.get(r.id).submissionId);
    expect(Number((await prisma.$queryRaw`SELECT last_value FROM "CatalogSubmission_number_seq"`)[0].last_value)).toBe(Number(next));
  });

  itDb('nothing to wrap: the migration runs through on a table with no legacy rows', async () => {
    // Only this spec's object: other DB-backed specs and the local app may add submissions meanwhile.
    const before = await prisma.catalogSubmission.count({ where: { objectId: OBJECT } });
    await migrate();
    expect(await prisma.catalogSubmission.count()).toBe(before);
  });
});
