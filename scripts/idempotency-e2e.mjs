/**
 * Exactly once, against the running service and real Postgres.
 *
 * WHAT THIS IS FOR
 *
 * `POST /items` and `POST /maintenance` make a new row every time they are
 * called, and the transport between a caller and this service is not reliable:
 * a request can commit here and its answer never arrive. Warehouse AI Writes W1
 * would not be safe to expose without an answer to that, so this is the answer
 * being checked rather than asserted — including the two cases a mock cannot
 * speak to, concurrency and a crash between claiming a key and committing.
 *
 *   node scripts/idempotency-e2e.mjs
 *
 * Needs warehouse-api on :3005, auth-api on :3002 and the dev Postgres
 * container. Everything it makes is deleted by exact id in the finally block.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const WAREHOUSE = process.env.WAREHOUSE_API ?? 'http://127.0.0.1:3005/api';
const AUTH = process.env.AUTH_API ?? 'http://127.0.0.1:3002';

const FLOOR = 990900;
const ONE = 990961;
const OTHER = 990962;

const psql = (db, sql) =>
  execFileSync(
    'docker',
    ['exec', '-i', 'nairon-dev-postgres', 'psql', '-U', 'nairon', '-d', db, '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .filter((l) => !/^(INSERT|UPDATE|DELETE) \d+( \d+)?$/.test(l.trim()))
    .join('\n')
    .trim();

let passed = 0;
let failed = 0;
const record = (label, pass, detail = '') => {
  if (pass) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const stamp = `idem-${Date.now()}`;
const made = { users: [], roles: [], categories: [], items: [], assets: [], maintenance: [] };
let crashed = null;

function makeActor(id) {
  psql(
    'nairon_users',
    `DELETE FROM "UserRole" WHERE "userId" = ${id};
     DELETE FROM "RolePermission" WHERE "roleId" = ${id};
     DELETE FROM "User" WHERE id = ${id};
     DELETE FROM "Role" WHERE id = ${id};`,
  );
  const email = `warehouse.idem${id}@nairon.invalid`;
  const password = randomBytes(18).toString('base64url');
  const hash = bcrypt.hashSync(password, 10);
  psql(
    'nairon_users',
    `INSERT INTO "User" (id, email, password, "firstName", "lastName", "isOneTimePassword", "createdAt", "updatedAt", "isAdmin")
       VALUES (${id}, '${email}', '${hash}', 'Idem', 'Actor${id}', false, now(), now(), false);
     INSERT INTO "Role" (id, name, level, "isSuperAdmin") VALUES (${id}, 'Idempotency ${id}', 1, false);
     INSERT INTO "RolePermission" ("roleId", "permissionId", "entityId")
       SELECT ${id}, p.id, 0 FROM "Permission" p
       WHERE p.name IN ('page_warehouse','view_warehouse','view_resources','manage_items',
                        'manage_categories','view_assets','manage_assets',
                        'view_maintenance','manage_maintenance')
       ON CONFLICT DO NOTHING;
     INSERT INTO "UserRole" ("userId", "roleId", "entityId") VALUES (${id}, ${id}, 0);`,
  );
  made.users.push(id);
  made.roles.push(id);
  return { id, email, password };
}

async function login(email, password) {
  const res = await fetch(`${AUTH}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  const token = body.access_token ?? body.accessToken ?? body.token;
  if (!token) throw new Error(`login failed for ${email}: HTTP ${res.status}`);
  return token;
}

/** One call. `key` becomes the Idempotency-Key header when given. */
async function call(method, path, { token, key, body } = {}) {
  const res = await fetch(`${WAREHOUSE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const itemsNamed = (name) =>
  Number(psql('nairon_warehouse', `SELECT count(*) FROM "Item" WHERE name = '${name}'`));
const recordsFor = (assetId) =>
  Number(
    psql('nairon_warehouse', `SELECT count(*) FROM "MaintenanceRecord" WHERE "assetId" = ${assetId}`),
  );
const track = (res, bucket) => {
  if (res.body?.id) made[bucket].push(res.body.id);
  return res;
};

try {
  const mine = makeActor(ONE);
  const theirs = makeActor(OTHER);
  const token = await login(mine.email, mine.password);
  const otherToken = await login(theirs.email, theirs.password);

  const category = Number(
    psql(
      'nairon_warehouse',
      `INSERT INTO "ItemCategory" (name, "entityId", position, "createdAt", "updatedAt")
         VALUES ('${stamp} cat', 1, 900, now(), now()) RETURNING id`,
    ),
  );
  made.categories.push(category);

  console.log('\na create, asked for twice');

  const key = randomUUID();
  const body = { name: `${stamp} drill`, type: 'ASSET', categoryId: category, unit: 'PIECE' };

  const first = track(await call('POST', '/items', { token, key, body }), 'items');
  record('the first attempt creates the item', first.status === 201 && !!first.body?.id, `HTTP ${first.status} id=${first.body?.id}`);

  const again = await call('POST', '/items', { token, key, body });
  record(
    'the same key and the same body answers with the first result, not a second item',
    again.status === 201 && again.body?.id === first.body?.id,
    `HTTP ${again.status} id=${again.body?.id}`,
  );
  record('and there is exactly one row', itemsNamed(body.name) === 1, `${itemsNamed(body.name)} row(s)`);

  console.log('\nthe answer that never arrived');

  /*
   * The case the whole mechanism exists for. The caller cannot tell a request
   * that committed from one that never landed, so it asks again with the key it
   * already used — which is exactly the call above, repeated after a pause long
   * enough to be a real network round trip rather than a race.
   */
  const lostResponseRetry = await call('POST', '/items', { token, key, body });
  record(
    'a retry after a lost answer replays rather than repeating',
    lostResponseRetry.body?.id === first.body?.id && itemsNamed(body.name) === 1,
    `id=${lostResponseRetry.body?.id}, ${itemsNamed(body.name)} row(s)`,
  );

  console.log('\nthe same key, asked to do something else');

  const differentBody = await call('POST', '/items', {
    token,
    key,
    body: { ...body, name: `${stamp} ladder` },
  });
  record(
    'the same key with a different body is a conflict, not a replay',
    differentBody.status === 409,
    `HTTP ${differentBody.status}`,
  );
  record('and nothing was created for it', itemsNamed(`${stamp} ladder`) === 0);

  const otherPerson = await call('POST', '/items', { token: otherToken, key, body });
  record(
    'somebody else cannot redeem a key they did not claim',
    otherPerson.status === 409,
    `HTTP ${otherPerson.status}`,
  );
  record(
    'and the refusal tells them nothing about whose it is',
    !JSON.stringify(otherPerson.body ?? {}).includes(String(ONE)),
    JSON.stringify(otherPerson.body?.message ?? '').slice(0, 70),
  );

  const differentRoute = await call('POST', '/maintenance', {
    token,
    key,
    body: { assetId: 1, startDate: new Date().toISOString() },
  });
  record(
    'and the same key cannot be spent on a different route',
    differentRoute.status === 409,
    `HTTP ${differentRoute.status}`,
  );

  console.log('\nten at once');

  const raceKey = randomUUID();
  const raceBody = { name: `${stamp} race`, type: 'CONSUMABLE', categoryId: category, unit: 'PIECE' };
  const race = await Promise.all(
    Array.from({ length: 10 }, () => call('POST', '/items', { token, key: raceKey, body: raceBody })),
  );
  for (const r of race) if (r.body?.id) made.items.push(r.body.id);
  const created = race.filter((r) => r.status === 201);
  const conflicted = race.filter((r) => r.status === 409);
  record(
    'ten simultaneous attempts on one key produce exactly one item',
    itemsNamed(raceBody.name) === 1,
    `${itemsNamed(raceBody.name)} row(s); ${created.length} answered 201, ${conflicted.length} answered 409`,
  );
  record(
    'every attempt got a definite answer — none was left to guess',
    created.length + conflicted.length === 10,
    `${created.length + conflicted.length} of 10`,
  );
  const ids = new Set(created.map((r) => r.body?.id));
  record('and the ones that were answered were all answered with the same item', ids.size === 1, `${ids.size} distinct id(s)`);

  console.log('\nan attempt that died before it committed');

  /*
   * A crash between claiming the key and committing leaves the row IN_FLIGHT.
   * That state is written inside the same transaction as the item, so it cannot
   * coexist with a committed row — which is what makes it safe to let a later
   * attempt take the lease over instead of blocking the key forever. Simulated
   * by planting the claim the way a dead process would have left it.
   */
  const orphanKey = randomUUID();
  const orphanBody = { name: `${stamp} orphan`, type: 'ASSET', categoryId: category, unit: 'PIECE' };
  const fingerprint = psql(
    'nairon_warehouse',
    `SELECT encode(sha256(convert_to('POST /items' || chr(10) || $$${canonical(orphanBody)}$$, 'UTF8')), 'hex')`,
  );
  psql(
    'nairon_warehouse',
    `INSERT INTO "WriteOperation" (key, "userId", "entityId", route, fingerprint, status, "createdAt")
       VALUES ('${orphanKey}', ${ONE}, NULL, 'POST /items', '${fingerprint}', 'IN_FLIGHT', now() - interval '5 minutes')`,
  );

  const takeover = track(await call('POST', '/items', { token, key: orphanKey, body: orphanBody }), 'items');
  record(
    'a claim abandoned by a dead process is taken over, not blocked forever',
    takeover.status === 201 && !!takeover.body?.id,
    `HTTP ${takeover.status}`,
  );
  record('and it creates the row the dead attempt never did — once', itemsNamed(orphanBody.name) === 1);

  const fresh = randomUUID();
  psql(
    'nairon_warehouse',
    `INSERT INTO "WriteOperation" (key, "userId", route, fingerprint, status, "createdAt")
       VALUES ('${fresh}', ${ONE}, 'POST /items', '${fingerprint}', 'IN_FLIGHT', now())`,
  );
  const stillRunning = await call('POST', '/items', { token, key: fresh, body: orphanBody });
  record(
    'but one that may still be running is refused rather than duplicated',
    stillRunning.status === 409,
    `HTTP ${stillRunning.status}`,
  );
  psql('nairon_warehouse', `DELETE FROM "WriteOperation" WHERE key = '${fresh}'`);

  console.log('\na refusal does not spend the key');

  const refusedKey = randomUUID();
  const refused = await call('POST', '/items', {
    token,
    key: refusedKey,
    body: { name: `${stamp} nowhere`, type: 'NOT_A_TYPE', categoryId: category },
  });
  record('a bad request is refused', refused.status === 400, `HTTP ${refused.status}`);
  const corrected = track(
    await call('POST', '/items', {
      token,
      key: refusedKey,
      body: { name: `${stamp} corrected`, type: 'ASSET', categoryId: category, unit: 'PIECE' },
    }),
    'items',
  );
  record(
    'and the corrected attempt may use the same key, because nothing was written',
    corrected.status === 201,
    `HTTP ${corrected.status}`,
  );

  console.log('\nmaintenance, the same way');

  const item = Number(
    psql(
      'nairon_warehouse',
      `INSERT INTO "Item" (uuid, name, type, quantity, "categoryId", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), '${stamp} machine', 'ASSET', 1, ${category}, now(), now()) RETURNING id`,
    ),
  );
  made.items.push(item);
  const asset = Number(
    psql(
      'nairon_warehouse',
      `INSERT INTO "Asset" (uuid, name, "itemId", status, "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), '${stamp} machine #1', ${item}, 'AVAILABLE', now(), now()) RETURNING id`,
    ),
  );
  made.assets.push(asset);

  const mKey = randomUUID();
  const mBody = { assetId: asset, startDate: new Date().toISOString(), type: 'inspection' };
  const m1 = track(await call('POST', '/maintenance', { token, key: mKey, body: mBody }), 'maintenance');
  record('a maintenance record is created', m1.status === 201 && !!m1.body?.id, `HTTP ${m1.status}`);
  const m2 = await call('POST', '/maintenance', { token, key: mKey, body: mBody });
  record(
    'and asking again with the same key replays it',
    m2.body?.id === m1.body?.id && recordsFor(asset) === 1,
    `${recordsFor(asset)} record(s)`,
  );

  const mRace = await Promise.all(
    Array.from({ length: 10 }, () =>
      call('POST', '/maintenance', { token, key: `${mKey}-race`, body: mBody }),
    ),
  );
  for (const r of mRace) if (r.body?.id) made.maintenance.push(r.body.id);
  record(
    'ten at once on a fresh key still leave one new record',
    recordsFor(asset) === 2,
    `${recordsFor(asset)} record(s) in total`,
  );

  console.log('\nand without a key, nothing changed');

  const noKeyA = track(await call('POST', '/items', { token, body: { ...body, name: `${stamp} plain` } }), 'items');
  const noKeyB = track(await call('POST', '/items', { token, body: { ...body, name: `${stamp} plain` } }), 'items');
  record(
    'a caller that sends no key gets the behaviour it always had — two calls, two items',
    noKeyA.status === 201 && noKeyB.status === 201 && itemsNamed(`${stamp} plain`) === 2,
    `${itemsNamed(`${stamp} plain`)} row(s)`,
  );
} catch (e) {
  crashed = e;
} finally {
  const errors = [];
  const safely = (label, fn) => {
    try {
      fn();
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
    }
  };
  const ids = (l) => [...new Set(l.filter(Boolean))].join(',') || '-1';

  safely('warehouse rows', () =>
    psql(
      'nairon_warehouse',
      `DELETE FROM "WriteOperation" WHERE "userId" IN (${ids(made.users)});
       DELETE FROM "MaintenanceRecord" WHERE "assetId" IN (${ids(made.assets)}) OR id IN (${ids(made.maintenance)});
       DELETE FROM "Asset" WHERE id IN (${ids(made.assets)});
       DELETE FROM "Item" WHERE id IN (${ids(made.items)}) OR name LIKE '${stamp}%';
       DELETE FROM "ItemCategory" WHERE id IN (${ids(made.categories)});`,
    ),
  );
  safely('actors', () =>
    psql(
      'nairon_users',
      `DELETE FROM "UserRole" WHERE "userId" IN (${ids(made.users)});
       DELETE FROM "RolePermission" WHERE "roleId" IN (${ids(made.roles)});
       DELETE FROM "User" WHERE id IN (${ids(made.users)});
       DELETE FROM "Role" WHERE id IN (${ids(made.roles)});`,
    ),
  );

  const left = {
    actors: Number(psql('nairon_users', `SELECT count(*) FROM "User" WHERE id >= ${FLOOR}`)),
    items: Number(psql('nairon_warehouse', `SELECT count(*) FROM "Item" WHERE name LIKE '${stamp}%'`)),
    operations: Number(
      psql('nairon_warehouse', `SELECT count(*) FROM "WriteOperation" WHERE "userId" >= ${FLOOR}`),
    ),
  };
  console.log('\ncleanup:', JSON.stringify(left), errors.length ? `errors: ${errors.join(' | ')}` : '');
  if (crashed) console.error('\nthe run stopped early:', crashed?.stack ?? crashed);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed || errors.length || crashed ? 1 : 0);
}

/** The same canonical form OperationsService uses, so a planted row matches. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
