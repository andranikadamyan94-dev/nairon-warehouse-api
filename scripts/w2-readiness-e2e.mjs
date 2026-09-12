/**
 * W2 readiness, against the running services and real Postgres. No model.
 *
 * WHAT IT IS FOR
 *
 * The three candidate capabilities — reserve, change a reservation, hand stock
 * back — all turn on things a unit test cannot speak to: whether two requests
 * racing for the last of something can both win, whether a lost answer makes a
 * second set of rows, and whether the record of what somebody asked for
 * survives the goods coming back.
 *
 * Three companies: A requests, B owns the shelves, C is party to neither.
 *
 *   node scripts/w2-readiness-e2e.mjs
 *
 * Needs warehouse-api on :3005, crm-api on :3003, auth-api on :3002 and the dev
 * Postgres container. Everything it makes is deleted by exact id in `finally`.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const WAREHOUSE = process.env.WAREHOUSE_API ?? 'http://127.0.0.1:3005/api';
const AUTH = process.env.AUTH_API ?? 'http://127.0.0.1:3002';

const FLOOR = 990900;
const PLANNER = 990994;
const KEEPER = 990995;
const OUTSIDER = 990996;

const REQUESTER_WS = 7;
const OWNER_WS = 1;
const OTHER_WS = 3;

const SEP = String.fromCharCode(31);
const psql = (db, sql) =>
  execFileSync('docker', ['exec', '-i', 'nairon-dev-postgres', 'psql', '-U', 'nairon', '-d', db, '-t', '-A', '-F', SEP, '-c', sql], {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^(INSERT|UPDATE|DELETE) \d+( \d+)?$/.test(l.trim()))
    .join('\n')
    .trim();
const one = (db, sql) => psql(db, sql).split('\n')[0] ?? '';

let passed = 0;
let failed = 0;
let crashed = null;
const record = (label, pass, detail = '') => {
  if (pass) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const stamp = `w2-${Date.now()}`;
const made = { users: [], roles: [], categories: [], items: [], projects: [], tasks: [] };

function makeActor(id, entityId, permissions) {
  psql(
    'nairon_users',
    `DELETE FROM "UserRole" WHERE "userId" = ${id};
     DELETE FROM "RolePermission" WHERE "roleId" = ${id};
     DELETE FROM "User" WHERE id = ${id};
     DELETE FROM "Role" WHERE id = ${id};`,
  );
  const email = `warehouse.w2${id}@nairon.invalid`;
  const password = randomBytes(18).toString('base64url');
  const hash = bcrypt.hashSync(password, 10);
  psql(
    'nairon_users',
    `INSERT INTO "User" (id, email, password, "firstName", "lastName", "isOneTimePassword", "createdAt", "updatedAt", "isAdmin")
       VALUES (${id}, '${email}', '${hash}', 'W2', 'Actor${id}', false, now(), now(), false);
     INSERT INTO "Role" (id, name, level, "isSuperAdmin") VALUES (${id}, 'W2 ${id}', 1, false);
     INSERT INTO "RolePermission" ("roleId", "permissionId", "entityId")
       SELECT ${id}, p.id, 0 FROM "Permission" p WHERE p.name IN (${permissions.map((p) => `'${p}'`).join(',')})
       ON CONFLICT DO NOTHING;
     INSERT INTO "UserRole" ("userId", "roleId", "entityId") VALUES (${id}, ${id}, ${entityId});`,
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

const call = async (method, path, { token, key, body } = {}) => {
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
};

const stockOf = (id) => Number(one('nairon_warehouse', `SELECT quantity FROM "Item" WHERE id = ${id}`));
const rowsFor = (itemId) =>
  Number(one('nairon_warehouse', `SELECT count(*) FROM "ResourceReservation" WHERE "itemId" = ${itemId}`));
const requestedOf = (id) =>
  Number(one('nairon_warehouse', `SELECT quantity FROM "ResourceReservation" WHERE id = ${id}`));

function makeProject(name, entityId, owner) {
  const project = Number(
    one(
      'nairon_crm',
      `INSERT INTO "Project" (name, "entityId", "createdBy", "createdAt", "updatedAt")
         VALUES ('${name}', ${entityId}, ${owner}, now(), now()) RETURNING id`,
    ),
  );
  made.projects.push(project);
  const status = Number(
    one(
      'nairon_crm',
      `INSERT INTO "ProjectStatus" (name, "projectId", "order", color) VALUES ('${stamp}', ${project}, 0, '#ccc') RETURNING id`,
    ),
  );
  const task = Number(
    one(
      'nairon_crm',
      `INSERT INTO "ProjectTask" (title, "projectId", "statusId", "createdById", "createdAt", "updatedAt")
         VALUES ('${stamp} task', ${project}, ${status}, ${owner}, now(), now()) RETURNING id`,
    ),
  );
  made.tasks.push(task);
  psql('nairon_crm', `INSERT INTO "ProjectTaskAssignee" ("taskId", "userId", role) VALUES (${task}, ${owner}, 'EXECUTOR');`);
  return { project, task };
}

try {
  const planner = makeActor(PLANNER, REQUESTER_WS, [
    'page_warehouse', 'view_warehouse', 'view_resources', 'view_reservations',
    'manage_reservations', 'manage_resource_returns',
  ]);
  const keeper = makeActor(KEEPER, OWNER_WS, [
    'page_warehouse', 'view_warehouse', 'view_resources', 'view_reservations',
    'manage_reservations', 'view_resource_returns', 'manage_resource_returns',
  ]);
  const outsider = makeActor(OUTSIDER, OTHER_WS, [
    'page_warehouse', 'view_warehouse', 'view_reservations', 'manage_reservations', 'manage_resource_returns',
  ]);

  const plannerToken = await login(planner.email, planner.password);
  const keeperToken = await login(keeper.email, keeper.password);
  const outsiderToken = await login(outsider.email, outsider.password);

  const { project, task } = makeProject(`${stamp} շինարարություն`, REQUESTER_WS, PLANNER);

  const category = Number(
    one(
      'nairon_warehouse',
      `INSERT INTO "ItemCategory" (name, "entityId", position, "createdAt", "updatedAt")
         VALUES ('${stamp} պահեստ', ${OWNER_WS}, 900, now(), now()) RETURNING id`,
    ),
  );
  made.categories.push(category);
  const cement = Number(
    one(
      'nairon_warehouse',
      `INSERT INTO "Item" (uuid, name, type, unit, quantity, "categoryId", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), '${stamp} ցեմենտ', 'CONSUMABLE', 'KG', 100, ${category}, now(), now()) RETURNING id`,
    ),
  );
  const sand = Number(
    one(
      'nairon_warehouse',
      `INSERT INTO "Item" (uuid, name, type, unit, quantity, "categoryId", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), '${stamp} ավազ', 'CONSUMABLE', 'KG', 50, ${category}, now(), now()) RETURNING id`,
    ),
  );
  made.items.push(cement, sand);

  const dates = {
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 7 * 864e5).toISOString(),
  };
  const request = { taskId: task, projectId: project, projectName: `${stamp} շինարարություն`, ...dates };

  console.log('\nthe preflight, which writes nothing');

  const before = rowsFor(cement) + rowsFor(sand);
  const pre = await call('POST', '/reservations/preflight/create', {
    token: plannerToken,
    body: { ...request, resources: [{ itemId: cement, quantity: 10 }, { itemId: sand, quantity: 5 }] },
  });
  record('it answers', pre.status === 201 && pre.body?.ok === true, `HTTP ${pre.status}`);
  record('and wrote nothing', rowsFor(cement) + rowsFor(sand) === before);
  record(
    'it names who asks, and how many rows one request becomes',
    pre.body?.request?.requesterWorkspaceId === REQUESTER_WS && pre.body?.request?.rowsToCreate === 2,
    `requester=${pre.body?.request?.requesterWorkspaceId} rows=${pre.body?.request?.rowsToCreate}`,
  );
  record(
    'line by line, with whose shelf each comes from',
    (pre.body?.request?.lines ?? []).every((l) => l.stockOwnerWorkspaceId === OWNER_WS),
    JSON.stringify((pre.body?.request?.lines ?? []).map((l) => `${l.itemName}×${l.quantity}`)),
  );
  record(
    'and says its availability is not a promise',
    pre.body?.request?.availabilityIsInformational === true,
  );

  const preOutsider = await call('POST', '/reservations/preflight/create', {
    token: outsiderToken,
    body: { ...request, resources: [{ itemId: cement, quantity: 1 }] },
  });
  record(
    'a third company is refused by the preflight exactly as by the mutation',
    preOutsider.status === 403,
    `HTTP ${preOutsider.status}`,
  );

  console.log('\none request, several rows, and a caller told which');

  const key = randomUUID();
  const body = { ...request, resources: [{ itemId: cement, quantity: 10 }, { itemId: sand, quantity: 5 }] };
  const created = await call('POST', '/reservations', { token: plannerToken, key, body });
  record('the request is accepted', created.status === 201, `HTTP ${created.status}`);
  const ids = (created.body?.created ?? []).map((c) => c.id);
  record(
    'and answers with the rows it made, not just "available"',
    ids.length === 2 && created.body.created.every((c) => c.id && c.requesterWorkspaceId === REQUESTER_WS),
    JSON.stringify(created.body?.created?.map((c) => ({ id: c.id, item: c.itemName, q: c.quantity }))),
  );
  record(
    'each row says whose stock it draws on',
    (created.body?.created ?? []).every((c) => c.stockOwnerWorkspaceId === OWNER_WS),
  );

  const replay = await call('POST', '/reservations', { token: plannerToken, key, body });
  const replayIds = (replay.body?.created ?? []).map((c) => c.id);
  record(
    'a lost answer retried gives back the same rows, and makes no more',
    JSON.stringify(replayIds) === JSON.stringify(ids) && rowsFor(cement) + rowsFor(sand) === 2,
    `${rowsFor(cement) + rowsFor(sand)} row(s)`,
  );

  const changed = await call('POST', '/reservations', {
    token: plannerToken,
    key,
    body: { ...body, resources: [{ itemId: cement, quantity: 99 }] },
  });
  record('and the same key asked to do something else is a conflict', changed.status === 409, `HTTP ${changed.status}`);

  const raceKey = randomUUID();
  const raceBody = { ...request, resources: [{ itemId: sand, quantity: 1 }] };
  const rowsBefore = rowsFor(sand);
  const race = await Promise.all(
    Array.from({ length: 10 }, () => call('POST', '/reservations', { token: plannerToken, key: raceKey, body: raceBody })),
  );
  record(
    'ten simultaneous attempts on one key make one set',
    rowsFor(sand) === rowsBefore + 1,
    `${rowsFor(sand) - rowsBefore} new row(s); ${race.filter((r) => r.status === 201).length} answered 201`,
  );

  console.log('\ntwo requests racing for the last of something');

  const scarce = Number(
    one(
      'nairon_warehouse',
      `INSERT INTO "Item" (uuid, name, type, unit, quantity, "categoryId", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), '${stamp} հազվագյուտ', 'CONSUMABLE', 'PIECE', 3, ${category}, now(), now()) RETURNING id`,
    ),
  );
  made.items.push(scarce);

  const second = makeProject(`${stamp} երկրորդ`, REQUESTER_WS, PLANNER);
  const both = await Promise.all([
    call('POST', '/reservations', {
      token: plannerToken,
      body: { taskId: task, projectId: project, ...dates, resources: [{ itemId: scarce, quantity: 3 }] },
    }),
    call('POST', '/reservations', {
      token: plannerToken,
      body: { taskId: second.task, projectId: second.project, ...dates, resources: [{ itemId: scarce, quantity: 3 }] },
    }),
  ]);
  const accepted = both.filter((r) => r.status === 201).length;
  record(
    'only one of two requests for the last three can be accepted',
    accepted === 1,
    `${accepted} accepted, ${both.filter((r) => r.status >= 400).length} refused · ${rowsFor(scarce)} row(s) exist`,
  );

  console.log('\nissuing, racing for the shelf');

  const cementReservation = ids[0];
  const plannerIssues = await call('PATCH', `/reservations/${cementReservation}/approve`, {
    token: plannerToken,
    body: { quantity: 10 },
  });
  record('the asker cannot issue to themselves', plannerIssues.status === 403, `HTTP ${plannerIssues.status}`);

  const issueRace = await Promise.all([
    call('PATCH', `/reservations/${cementReservation}/approve`, { token: keeperToken, body: { quantity: 10 } }),
    call('PATCH', `/reservations/${cementReservation}/approve`, { token: keeperToken, body: { quantity: 10 } }),
  ]);
  const issued = issueRace.filter((r) => r.status === 200).length;
  record(
    'the same reservation cannot be issued twice by two simultaneous clicks',
    issued === 1 && stockOf(cement) === 90,
    `${issued} succeeded · ${stockOf(cement)} on the shelf`,
  );

  console.log('\nwhat was asked for stays what was asked for');

  const returnPre = await call('POST', '/resource-returns/preflight/create', {
    token: plannerToken,
    body: { reservationId: cementReservation, quantity: 4 },
  });
  record(
    'the return preflight says what is out, and what was originally asked',
    returnPre.body?.request?.out === 10 && returnPre.body?.request?.requested === 10,
    JSON.stringify(returnPre.body?.request ?? {}).slice(0, 130),
  );

  const returnKey = randomUUID();
  const handed = await call('POST', '/resource-returns', {
    token: plannerToken,
    key: returnKey,
    body: { reservationId: cementReservation, quantity: 4 },
  });
  record('four are handed back', handed.status === 201, `HTTP ${handed.status}`);

  const handedAgain = await call('POST', '/resource-returns', {
    token: plannerToken,
    key: returnKey,
    body: { reservationId: cementReservation, quantity: 4 },
  });
  record(
    'a lost answer retried returns the same row, not another four',
    handedAgain.body?.id === handed.body?.id,
    `id=${handedAgain.body?.id} (first ${handed.body?.id})`,
  );

  await call('PATCH', `/resource-returns/${handed.body.id}/receive`, { token: keeperToken });
  record('the shelf has them back', stockOf(cement) === 94, `${stockOf(cement)}`);
  record(
    'and the request still says ten — history, not a counter',
    requestedOf(cementReservation) === 10,
    `requested=${requestedOf(cementReservation)}`,
  );

  const afterReceive = await call('POST', '/resource-returns/preflight/create', {
    token: plannerToken,
    body: { reservationId: cementReservation, quantity: 6 },
  });
  record(
    'six are still out and six can still come back — the double-subtraction bug',
    afterReceive.body?.request?.out === 6 && afterReceive.body?.request?.returnable === 6,
    `out=${afterReceive.body?.request?.out} returnable=${afterReceive.body?.request?.returnable}`,
  );

  const tooMany = await call('POST', '/resource-returns', {
    token: plannerToken,
    body: { reservationId: cementReservation, quantity: 7 },
  });
  record('and seven cannot', tooMany.status === 400, `HTTP ${tooMany.status}`);

  const returnRace = await Promise.all([
    call('POST', '/resource-returns', { token: plannerToken, body: { reservationId: cementReservation, quantity: 6 } }),
    call('POST', '/resource-returns', { token: plannerToken, body: { reservationId: cementReservation, quantity: 6 } }),
  ]);
  const filed = returnRace.filter((r) => r.status === 201).length;
  record(
    'two people handing back the same six at once file one return',
    filed === 1,
    `${filed} filed, ${returnRace.filter((r) => r.status >= 400).length} refused`,
  );

  console.log('\nand an asset return is refused rather than guessed at');

  const machine = Number(
    one(
      'nairon_warehouse',
      `INSERT INTO "Item" (uuid, name, type, quantity, "categoryId", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), '${stamp} հաստոց', 'ASSET', 2, ${category}, now(), now()) RETURNING id`,
    ),
  );
  made.items.push(machine);
  const assetReservation = Number(
    one(
      'nairon_warehouse',
      `INSERT INTO "ResourceReservation" (uuid, "itemId", quantity, "requesterWorkspaceId", "taskId", "projectId", status, "startDate", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), ${machine}, 1, ${REQUESTER_WS}, ${task}, ${project}, 'ALLOCATED', now(), now(), now()) RETURNING id`,
    ),
  );
  psql(
    'nairon_warehouse',
    `INSERT INTO "ReservationAllocation" (uuid, "reservationId", quantity, "allocatedAt") VALUES (gen_random_uuid(), ${assetReservation}, 1, now());`,
  );
  const assetReturn = await call('POST', '/resource-returns/preflight/create', {
    token: plannerToken,
    body: { reservationId: assetReservation, quantity: 1 },
  });
  record(
    'because a number cannot say which machine came back',
    assetReturn.status === 400,
    `HTTP ${assetReturn.status} ${String(assetReturn.body?.message ?? '').slice(0, 60)}`,
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
       DELETE FROM "ResourceReturn" WHERE "reservationId" IN (SELECT id FROM "ResourceReservation" WHERE "itemId" IN (${ids(made.items)}));
       DELETE FROM "ReservationAllocationHistory" WHERE "reservationId" IN (SELECT id FROM "ResourceReservation" WHERE "itemId" IN (${ids(made.items)}));
       DELETE FROM "ReservationAllocation" WHERE "reservationId" IN (SELECT id FROM "ResourceReservation" WHERE "itemId" IN (${ids(made.items)}));
       DELETE FROM "ReservationStatusHistory" WHERE "reservationId" IN (SELECT id FROM "ResourceReservation" WHERE "itemId" IN (${ids(made.items)}));
       DELETE FROM "ResourceReservation" WHERE "itemId" IN (${ids(made.items)});
       DELETE FROM "InventoryMovement" WHERE "itemId" IN (${ids(made.items)});
       DELETE FROM "Item" WHERE id IN (${ids(made.items)});
       DELETE FROM "ItemCategory" WHERE id IN (${ids(made.categories)});`,
    ),
  );
  safely('crm rows', () =>
    psql(
      'nairon_crm',
      `DELETE FROM "ProjectTaskAssignee" WHERE "taskId" IN (${ids(made.tasks)});
       DELETE FROM "ProjectTask" WHERE id IN (${ids(made.tasks)});
       DELETE FROM "ProjectStatus" WHERE "projectId" IN (${ids(made.projects)});
       DELETE FROM "Project" WHERE id IN (${ids(made.projects)});`,
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
    actors: Number(one('nairon_users', `SELECT count(*) FROM "User" WHERE id >= ${FLOOR}`)),
    items: Number(one('nairon_warehouse', `SELECT count(*) FROM "Item" WHERE name LIKE '${stamp}%'`)),
    projects: Number(one('nairon_crm', `SELECT count(*) FROM "Project" WHERE name LIKE '${stamp}%'`)),
    operations: Number(one('nairon_warehouse', `SELECT count(*) FROM "WriteOperation" WHERE "userId" >= ${FLOOR}`)),
  };
  console.log('\ncleanup:', JSON.stringify(left), errors.length ? `errors: ${errors.join(' | ')}` : '');
  if (crashed) console.error('\nthe run stopped early:', crashed?.stack ?? crashed);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed || errors.length || crashed ? 1 : 0);
}
