/**
 * Null out receiptUrl on rows whose file is no longer on disk.
 *
 * Receipts were written into the container's own filesystem with no volume
 * mounted at /app/uploads, so every `docker compose up -d` after a build threw
 * them away. The database still points at them, and those links 404 forever.
 *
 * This cannot be a migration: SQL cannot see the filesystem, and the answer
 * differs per environment. Run it on the box, inside the container, so it
 * checks the same disk the API serves from.
 *
 *   docker compose exec warehouse-api node scripts/clear-missing-receipts.js
 *   docker compose exec warehouse-api node scripts/clear-missing-receipts.js --apply
 *
 * Dry run by default — it only reports. Pass --apply to write.
 *
 * IMPORTANT: run this AFTER restoring any files you rescued from the old
 * container. Running it first would null rows whose files you were about to
 * put back.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

/** Both shapes appear: "/uploads/<f>" and legacy "http://host:port/uploads/<f>". */
function filenameOf(receiptUrl) {
  const afterUploads = receiptUrl.split('/uploads/')[1];
  return afterUploads ? path.basename(afterUploads.split('?')[0]) : null;
}

async function sweep(modelName, model) {
  const rows = await model.findMany({
    where: { receiptUrl: { not: null } },
    select: { id: true, receiptUrl: true },
  });

  const missing = [];
  for (const row of rows) {
    const filename = filenameOf(row.receiptUrl);
    // An unparseable value points at nothing we can serve either.
    if (!filename || !fs.existsSync(path.join(UPLOADS_DIR, filename))) {
      missing.push(row);
    }
  }

  console.log(
    `${modelName}: ${rows.length} with a receipt, ${missing.length} missing on disk, ` +
      `${rows.length - missing.length} intact`,
  );
  for (const row of missing) console.log(`    id=${row.id}  ${row.receiptUrl}`);

  if (APPLY && missing.length) {
    const { count } = await model.updateMany({
      where: { id: { in: missing.map((r) => r.id) } },
      data: { receiptUrl: null },
    });
    console.log(`    → cleared ${count}`);
  }
  return missing.length;
}

async function main() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    // Bail rather than clear every row: an unmounted volume looks exactly like
    // "every file is missing", and that is the one case we must not act on.
    console.error(`Refusing to run: ${UPLOADS_DIR} does not exist.`);
    process.exit(1);
  }

  const onDisk = fs.readdirSync(UPLOADS_DIR).length;
  if (onDisk === 0 && APPLY && !process.argv.includes('--force')) {
    // A freshly mounted, still-empty volume is indistinguishable from "every
    // file was lost" — and this is exactly the moment someone runs this by
    // mistake, before copying the rescued files back in. Make them say so.
    console.error(
      'Refusing to run: uploads dir is empty. If files are genuinely all gone, ' +
        're-run with --force; otherwise restore them first.',
    );
    process.exit(1);
  }

  console.log(`uploads dir: ${UPLOADS_DIR} (${onDisk} files)`);
  console.log(APPLY ? 'mode: APPLY\n' : 'mode: dry run — pass --apply to write\n');

  const total =
    (await sweep('ProcurementOrder', prisma.procurementOrder)) +
    (await sweep('ProcurementDelivery', prisma.procurementDelivery));

  console.log(`\n${APPLY ? 'cleared' : 'would clear'} ${total} row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
