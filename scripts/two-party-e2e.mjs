/**
 * Two companies, one shared store — against the running services.
 *
 * WHAT IT PROVES
 *
 * Every reservation in this installation whose two companies can both be named
 * has DIFFERENT ones: company 7 does the work, companies 1 and 4 own the
 * shelves. Not one row is same-company. So the thing to prove is not that the
 * rules refuse strangers — it is that the cross-company flow the product is
 * built on still WORKS, and that each side is held to its own half of it.
 *
 * Three people who exist nowhere else:
 *
 *   the planner     a role only in the requesting company
 *   the storekeeper a role only in the company that owns the stock
 *   the stranger    a role only in a third company
 *
 * and one reservation raised by the planner's project against the storekeeper's
 * catalogue, carried all the way through: asked, approved, issued, handed back,
 * received.
 *
 *   node scripts/two-party-e2e.mjs
 *
 * Needs warehouse-api on :3005, crm-api on :3003, auth-api on :3002 and the dev
 * Postgres container. Everything it makes is deleted by exact id in `finally`.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const WAREHOUSE = process.env.WAREHOUSE_API ?? 'http://127.0.0.1:3005/api';
const AUTH = process.env.AUTH_API ?? 'http://127.0.0.1:3002';

const FLOOR = 990900;
const PLANNER = 990991;
const KEEPER = 990992;
const STRANGER = 990993;

/** Who does the work, who owns the shelf, and a third party to neither. */
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

const stamp = `tp-${Date.now()}`;
const made = { users: [], roles: [], categories: [], items: [], reservations: [], returns: [], project: 0, task: 0 };

function makeActor(id, entityId, permissions) {
  psql(
    'nairon_users',
    `DELETE FROM "UserRole" WHERE "userId" = ${id};
     DELETE FROM "RolePermission" WHERE "roleId" = ${id};
     DELETE FROM "User" WHERE id = ${id};
     DELETE FROM "Role" WHERE id = ${id};`,
  );
  const email = `warehouse.twoparty${id}@nairon.invalid`;
  const password = randomBytes(18).toString('base64url');
  const hash = bcrypt.hashSync(password, 10);
  const quoted = permissions.map((p) => `'${p}'`).join(',');
  psql(
    'nairon_users',
    `INSERT INTO "User" (id, email, password, "firstName", "lastName", "isOneTimePassword", "createdAt", "updatedAt", "isAdmin")
       VALUES (${id}, '${email}', '${hash}', 'Two', 'Party${id}', false, now(), now(), false);
     INSERT INTO "Role" (id, name, level, "isSuperAdmin") VALUES (${id}, 'Two party ${id}', 1, false);
     INSERT INTO "RolePermission" ("roleId", "permissionId", "entityId")
       SELECT ${id}, p.id, 0 FROM "Permission" p WHERE p.name IN (${quoted}) ON CONFLICT DO NOTHING;
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

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${WAREHOUSE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const stockOf = (itemId) => Number(one('nairon_warehouse', `SELECT quantity FROM "Item" WHERE id = ${itemId}`));
const statusOf = (id) => one('nairon_warehouse', `SELECT status FROM "ResourceReservation" WHERE id = ${id}`);

try {
  const planner = makeActor(PLANNER, REQUESTER_WS, [
    'page_warehouse',
    'view_warehouse',
    'view_resources',
    'view_reservations',
    'manage_reservations',
    'manage_resource_returns',
  ]);
  const keeper = makeActor(KEEPER, OWNER_WS, [
    'page_warehouse',
    'view_warehouse',
    'view_resources',
    'view_reservations',
    'manage_reservations',
    'view_resource_returns',
    'manage_resource_returns',
    'manage_items',
  ]);
  const stranger = makeActor(STRANGER, OTHER_WS, [
    'page_warehouse',
    'view_warehouse',
    'view_reservations',
    'manage_reservations',
    'manage_resource_returns',
  ]);

  const plannerToken = await login(planner.email, planner.password);
  const keeperToken = await login(keeper.email, keeper.password);
  const strangerToken = await login(stranger.email, stranger.password);

  /* ── the requesting company's work ─────────────────────────────────────── */
  made.project = Number(
    one(
      'nairon_crm',
      `INSERT INTO "Project" (name, "entityId", "createdBy", "createdAt", "updatedAt")
         VALUES ('${stamp} շինարարություն', ${REQUESTER_WS}, ${PLANNER}, now(), now()) RETURNING id`,
    ),
  );
  const status = Number(
    one(
      'nairon_crm',
      `INSERT INTO "ProjectStatus" (name, "projectId", "order", color) VALUES ('${stamp}', ${made.project}, 0, '#ccc') RETURNING id`,
    ),
  );
  made.task = Number(
    one(
      'nairon_crm',
      `INSERT INTO "ProjectTask" (title, "projectId", "statusId", "createdById", "createdAt", "updatedAt")
         VALUES ('${stamp} հիմք', ${made.project}, ${status}, ${PLANNER}, now(), now()) RETURNING id`,
    ),
  );
  psql(
    'nairon_crm',
    `INSERT INTO "ProjectTaskAssignee" ("taskId", "userId", role) VALUES (${made.task}, ${PLANNER}, 'EXECUTOR');`,
  );

  /* ── the owning company's stock ────────────────────────────────────────── */
  const category = Number(
    one(
      'nairon_warehouse',
      `INSERT INTO "ItemCategory" (name, "entityId", position, "createdAt", "updatedAt")
         VALUES ('${stamp} պահեստ', ${OWNER_WS}, 900, now(), now()) RETURNING id`,
    ),
  );
  made.categories.push(category);
  const item = Number(
    one(
      'nairon_warehouse',
      `INSERT INTO "Item" (uuid, name, type, unit, quantity, "categoryId", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), '${stamp} ցեմենտ', 'CONSUMABLE', 'KG', 100, ${category}, now(), now()) RETURNING id`,
    ),
  );
  made.items.push(item);

  console.log('\ncompany 7 asks company 1 for stock — the flow every row here is');

  const asked = await call('POST', '/reservations', {
    token: plannerToken,
    body: {
      taskId: made.task,
      projectId: made.project,
      projectName: `${stamp} շինարարություն`,
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 7 * 864e5).toISOString(),
      resources: [{ itemId: item, quantity: 10 }],
    },
  });
  record('the planner may ask, across the company line', asked.status === 201, `HTTP ${asked.status}`);

  const reservationId = Number(
    one('nairon_warehouse', `SELECT id FROM "ResourceReservation" WHERE "itemId" = ${item} ORDER BY id DESC LIMIT 1`),
  );
  if (reservationId) made.reservations.push(reservationId);

  const stored = one(
    'nairon_warehouse',
    `SELECT coalesce("requesterWorkspaceId",-1) FROM "ResourceReservation" WHERE id = ${reservationId}`,
  );
  record(
    'and who asked was written down from the project, not from the request body',
    Number(stored) === REQUESTER_WS,
    `requesterWorkspaceId=${stored}`,
  );

  const forged = await call('POST', '/reservations', {
    token: plannerToken,
    body: {
      taskId: made.task,
      projectId: made.project,
      entityId: OWNER_WS,
      startDate: new Date().toISOString(),
      resources: [{ itemId: item, quantity: 1 }],
    },
  });
  const forgedRow = one(
    'nairon_warehouse',
    `SELECT coalesce("requesterWorkspaceId",-1) FROM "ResourceReservation" WHERE "itemId" = ${item} ORDER BY id DESC LIMIT 1`,
  );
  const forgedId = Number(one('nairon_warehouse', `SELECT id FROM "ResourceReservation" WHERE "itemId" = ${item} ORDER BY id DESC LIMIT 1`));
  if (forgedId && forgedId !== reservationId) made.reservations.push(forgedId);
  record(
    'a caller naming another company in the body does not become that company',
    forged.status === 403 || Number(forgedRow) === REQUESTER_WS,
    forged.status === 403 ? 'refused outright' : `stored requester=${forgedRow}`,
  );

  const noWork = await call('POST', '/reservations', {
    token: plannerToken,
    body: { startDate: new Date().toISOString(), resources: [{ itemId: item, quantity: 1 }] },
  });
  record(
    'a reservation attached to no project and no task is refused — nobody could say who asked',
    noWork.status === 400,
    `HTTP ${noWork.status}`,
  );

  console.log('\neach side is held to its own half');

  const plannerApproves = await call('PATCH', `/reservations/${reservationId}/approve`, {
    token: plannerToken,
    body: { quantity: 10 },
  });
  record(
    'the planner cannot approve stock out of a store that is not theirs',
    plannerApproves.status === 403,
    `HTTP ${plannerApproves.status}`,
  );
  record('and no stock moved', stockOf(item) === 100, `${stockOf(item)} on the shelf`);

  const strangerApproves = await call('PATCH', `/reservations/${reservationId}/approve`, {
    token: strangerToken,
    body: { quantity: 10 },
  });
  record(
    'a third company can do neither side of it',
    strangerApproves.status === 403,
    `HTTP ${strangerApproves.status}`,
  );

  const strangerReads = await call('GET', `/reservations/${reservationId}`, { token: strangerToken });
  record(
    'and cannot even see it — as missing, not as forbidden',
    strangerReads.status === 404,
    `HTTP ${strangerReads.status}`,
  );

  const keeperApproves = await call('PATCH', `/reservations/${reservationId}/approve`, {
    token: keeperToken,
    body: { quantity: 10 },
  });
  record(
    'the storekeeper approves it, because the shelf is theirs',
    keeperApproves.status === 200,
    `HTTP ${keeperApproves.status}`,
  );
  record('and ten kilos left the shelf', stockOf(item) === 90, `${stockOf(item)} on the shelf`);
  record('the reservation says it was issued', statusOf(reservationId) === 'ALLOCATED', statusOf(reservationId));

  console.log('\nhanding it back');

  const strangerReturns = await call('POST', '/resource-returns', {
    token: strangerToken,
    body: { reservationId, quantity: 5 },
  });
  record(
    'a third company cannot hand back what it never had',
    strangerReturns.status === 403 || strangerReturns.status === 404,
    `HTTP ${strangerReturns.status}`,
  );

  const tooMuch = await call('POST', '/resource-returns', {
    token: plannerToken,
    body: { reservationId, quantity: 40 },
  });
  record(
    'nobody can hand back more than went out — the way stock used to be inventable',
    tooMuch.status === 400,
    `HTTP ${tooMuch.status} ${String(tooMuch.body?.message ?? '').slice(0, 60)}`,
  );

  const handedBack = await call('POST', '/resource-returns', {
    token: plannerToken,
    body: { reservationId, quantity: 4 },
  });
  record('the planner hands four back', handedBack.status === 201, `HTTP ${handedBack.status}`);
  const returnId = handedBack.body?.id;
  if (returnId) made.returns.push(returnId);
  record('which has not touched the shelf yet', stockOf(item) === 90, `${stockOf(item)} on the shelf`);

  const overlapping = await call('POST', '/resource-returns', {
    token: plannerToken,
    body: { reservationId, quantity: 7 },
  });
  record(
    'and a second return cannot exceed what is still out, counting the first',
    overlapping.status === 400,
    `HTTP ${overlapping.status}`,
  );

  const plannerReceives = await call('PATCH', `/resource-returns/${returnId}/receive`, { token: plannerToken });
  record(
    'the planner cannot put stock back on somebody else’s shelf',
    plannerReceives.status === 403,
    `HTTP ${plannerReceives.status}`,
  );
  record('so the shelf is unchanged', stockOf(item) === 90, `${stockOf(item)} on the shelf`);

  const keeperReceives = await call('PATCH', `/resource-returns/${returnId}/receive`, { token: keeperToken });
  record('the storekeeper receives it', keeperReceives.status === 200, `HTTP ${keeperReceives.status}`);
  record('and four kilos are back', stockOf(item) === 94, `${stockOf(item)} on the shelf`);

  console.log('\nwho may look');

  const plannerSees = await call('GET', `/reservations/${reservationId}`, { token: plannerToken });
  record('the requesting company sees its own request', plannerSees.status === 200, `HTTP ${plannerSees.status}`);
  const keeperSees = await call('GET', `/reservations/${reservationId}`, { token: keeperToken });
  record('the owning company sees what it is being asked for', keeperSees.status === 200, `HTTP ${keeperSees.status}`);

  const strangerTask = await call('GET', `/reservations/task/${made.task}`, { token: strangerToken });
  record(
    'somebody not on the task and in neither company cannot read the task’s reservations',
    strangerTask.status === 404,
    `HTTP ${strangerTask.status}`,
  );
  const plannerTask = await call('GET', `/reservations/task/${made.task}`, { token: plannerToken });
  record('the person on the task can', plannerTask.status === 200, `HTTP ${plannerTask.status}`);

  const strangerReturnsList = await call('GET', `/resource-returns?taskId=${made.task}`, { token: strangerToken });
  record(
    'and naming a task id is no longer enough to read its returns',
    strangerReturnsList.status === 404,
    `HTTP ${strangerReturnsList.status}`,
  );
  const keeperReturnsList = await call('GET', `/resource-returns?taskId=${made.task}`, { token: keeperToken });
  record(
    'while warehouse staff still see what they have to fulfil',
    keeperReturnsList.status === 200,
    `HTTP ${keeperReturnsList.status}`,
  );

  console.log('\nand the ledger agrees');
  const movements = one(
    'nairon_warehouse',
    `SELECT string_agg(type || ':' || quantity, ' ') FROM "InventoryMovement" WHERE "itemId" = ${item}`,
  );
  record('every movement of stock is written down', movements === 'OUT:-10 IN:4', movements);
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
      `DELETE FROM "ResourceReturn" WHERE "reservationId" IN (${ids(made.reservations)});
       DELETE FROM "ReservationAllocationHistory" WHERE "reservationId" IN (${ids(made.reservations)});
       DELETE FROM "ReservationAllocation" WHERE "reservationId" IN (${ids(made.reservations)});
       DELETE FROM "ReservationStatusHistory" WHERE "reservationId" IN (${ids(made.reservations)});
       DELETE FROM "ResourceReservation" WHERE "itemId" IN (${ids(made.items)});
       DELETE FROM "InventoryMovement" WHERE "itemId" IN (${ids(made.items)});
       DELETE FROM "Item" WHERE id IN (${ids(made.items)});
       DELETE FROM "ItemCategory" WHERE id IN (${ids(made.categories)});`,
    ),
  );
  safely('crm rows', () => {
    if (made.task) psql('nairon_crm', `DELETE FROM "ProjectTaskAssignee" WHERE "taskId" = ${made.task};`);
    if (made.task) psql('nairon_crm', `DELETE FROM "ProjectTask" WHERE id = ${made.task};`);
    if (made.project) {
      psql('nairon_crm', `DELETE FROM "ProjectStatus" WHERE "projectId" = ${made.project};`);
      psql('nairon_crm', `DELETE FROM "Project" WHERE id = ${made.project};`);
    }
  });
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
  };
  console.log('\ncleanup:', JSON.stringify(left), errors.length ? `errors: ${errors.join(' | ')}` : '');
  if (crashed) console.error('\nthe run stopped early:', crashed?.stack ?? crashed);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed || errors.length || crashed ? 1 : 0);
}
