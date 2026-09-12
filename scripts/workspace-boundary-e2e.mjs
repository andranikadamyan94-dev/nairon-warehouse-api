/**
 * The workspace boundary, against the running warehouse-api. No model, no
 * assistant, nothing mocked.
 *
 * WHAT IT IS FOR
 *
 * Warehouse Domain Hardening added one question to this service: may this
 * person do this, to this thing, in this company? A unit test can show the rule
 * is right. Only this can show the rule is actually reached — through the
 * guards, the decorators, the DI graph and Prisma — and, just as important,
 * that it changes nothing for the people using the service today, all of whom
 * hold a role in every company and declare none.
 *
 * So it makes three people who do not exist anywhere else:
 *
 *   - one whose only role lives in company 1
 *   - one whose only role lives in company 4
 *   - one with a wildcard role, which is what every real account here has
 *
 * and two catalogues, one in each company, with an item and an asset in each.
 * Then it tries, from each side, to read and to write across the line.
 *
 *   node scripts/workspace-boundary-e2e.mjs
 *
 * Needs warehouse-api on :3005 and auth-api on :3002, and the dev Postgres
 * container. Everything it creates is deleted by id in the finally block,
 * whatever happens, and the counts are printed so a leak cannot pass unseen.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const WAREHOUSE = process.env.WAREHOUSE_API ?? 'http://localhost:3005/api';
const AUTH = process.env.AUTH_API ?? 'http://localhost:3002';

/** Far above anything real, so a stray row is recognisable at a glance. */
const FLOOR = 990900;
const IN_ONE = 990951;
const IN_FOUR = 990952;
const EVERYWHERE = 990953;

const WS_ONE = 1;
const WS_FOUR = 4;

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

const stamp = `wb-${Date.now()}`;
const made = { users: [], roles: [], categories: [], items: [], assets: [], maintenance: [] };

/**
 * One throwaway person whose role is scoped to `entityId` — 0 meaning the
 * wildcard every real account here holds. The permissions are copied from a
 * real warehouse role so that what a refusal proves is the workspace rule and
 * not a missing grant.
 */
function makeActor(id, entityId) {
  if (id < FLOOR) throw new Error(`test ids must be >= ${FLOOR}`);

  // Whatever an earlier run left behind at exactly this id, and nothing else.
  psql(
    'nairon_users',
    `DELETE FROM "UserRole" WHERE "userId" = ${id};
     DELETE FROM "RolePermission" WHERE "roleId" = ${id};
     DELETE FROM "User" WHERE id = ${id};
     DELETE FROM "Role" WHERE id = ${id};`,
  );

  const email = `warehouse.boundary${id}@nairon.invalid`;
  const password = randomBytes(18).toString('base64url');
  const hash = bcrypt.hashSync(password, 10);

  psql(
    'nairon_users',
    `INSERT INTO "User" (id, email, password, "firstName", "lastName", "isOneTimePassword", "createdAt", "updatedAt", "isAdmin")
       VALUES (${id}, '${email}', '${hash}', 'Boundary', 'Actor${id}', false, now(), now(), false);

     INSERT INTO "Role" (id, name, level, "isSuperAdmin")
       VALUES (${id}, 'Warehouse boundary ${id}', 1, false);

     INSERT INTO "RolePermission" ("roleId", "permissionId", "entityId")
       SELECT ${id}, p.id, 0 FROM "Permission" p
       WHERE p.name IN ('page_warehouse','view_warehouse','view_resources','manage_items',
                        'manage_categories','view_assets','manage_assets',
                        'view_maintenance','manage_maintenance',
                        'view_reservations','view_resource_returns')
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

/** One warehouse call. `ws` is the workspace the caller declares, if any. */
async function call(method, path, { token, ws, body } = {}) {
  const res = await fetch(`${WAREHOUSE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(ws ? { 'x-entity-id': String(ws) } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

const names = (r) => (Array.isArray(r.body) ? r.body.map((x) => x.name) : []);

let crashed = null;
try {
  /* ── three people ──────────────────────────────────────────────────────── */
  const one = makeActor(IN_ONE, WS_ONE);
  const four = makeActor(IN_FOUR, WS_FOUR);
  const all = makeActor(EVERYWHERE, 0);

  const tokenOne = await login(one.email, one.password);
  const tokenFour = await login(four.email, four.password);
  const tokenAll = await login(all.email, all.password);

  /* ── two catalogues, an item and an asset in each ──────────────────────── */
  const newCategory = (entityId, label) => {
    const id = Number(
      psql(
        'nairon_warehouse',
        `INSERT INTO "ItemCategory" (name, "entityId", position, "createdAt", "updatedAt")
           VALUES ('${stamp} ${label}', ${entityId}, 900, now(), now()) RETURNING id`,
      ),
    );
    made.categories.push(id);
    return id;
  };
  const newItem = (categoryId, label) => {
    const id = Number(
      psql(
        'nairon_warehouse',
        `INSERT INTO "Item" (uuid, name, type, quantity, "categoryId", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), '${stamp} ${label}', 'ASSET', 1, ${categoryId ?? 'NULL'}, now(), now()) RETURNING id`,
      ),
    );
    made.items.push(id);
    return id;
  };
  const newAsset = (itemId, label) => {
    const id = Number(
      psql(
        'nairon_warehouse',
        `INSERT INTO "Asset" (uuid, name, "itemId", status, "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), '${stamp} ${label}', ${itemId}, 'AVAILABLE', now(), now()) RETURNING id`,
      ),
    );
    made.assets.push(id);
    return id;
  };

  const catOne = newCategory(WS_ONE, 'catalogue one');
  const catFour = newCategory(WS_FOUR, 'catalogue four');
  const itemOne = newItem(catOne, 'drill');
  const itemFour = newItem(catFour, 'ladder');
  const itemNowhere = newItem(null, 'orphan');
  const assetOne = newAsset(itemOne, 'drill #1');
  const assetFour = newAsset(itemFour, 'ladder #1');

  const maintFour = Number(
    psql(
      'nairon_warehouse',
      `INSERT INTO "MaintenanceRecord" (uuid, "assetId", status, "startDate", "createdAt")
         VALUES (gen_random_uuid(), ${assetFour}, 'DRAFT', now(), now()) RETURNING id`,
    ),
  );
  made.maintenance.push(maintFour);

  console.log('\nreading across the line');

  /* ── reads ─────────────────────────────────────────────────────────────── */
  const listOne = await call('GET', '/items', { token: tokenOne });
  record(
    'somebody whose role lives in company 1 sees company 1’s catalogue',
    names(listOne).some((n) => n.includes('drill')),
    `${Array.isArray(listOne.body) ? listOne.body.length : '?'} row(s)`,
  );
  record(
    'and does not see company 4’s',
    !names(listOne).some((n) => n.includes('ladder')),
  );
  record(
    'and does not see an item that belongs to no company at all',
    !names(listOne).some((n) => n.includes('orphan')),
    'unknown is never a match',
  );

  const getForeign = await call('GET', `/items/${itemFour}`, { token: tokenOne });
  record(
    'another company’s item reads as missing, not as forbidden',
    getForeign.status === 404,
    `HTTP ${getForeign.status}`,
  );

  const getOwn = await call('GET', `/items/${itemOne}`, { token: tokenOne });
  record('their own item reads normally', getOwn.status === 200, `HTTP ${getOwn.status}`);

  const cats = await call('GET', '/categories', { token: tokenOne });
  record(
    'the category list is confined the same way',
    names(cats).some((n) => n.includes('catalogue one')) &&
      !names(cats).some((n) => n.includes('catalogue four')),
  );

  const catsAskingFour = await call('GET', `/categories?entityId=${WS_FOUR}`, { token: tokenOne });
  record(
    'and asking for another company’s in the query string returns nothing, rather than granting it',
    !names(catsAskingFour).some((n) => n.includes('catalogue four')),
    `${Array.isArray(catsAskingFour.body) ? catsAskingFour.body.length : '?'} row(s)`,
  );

  console.log('\nwriting across the line');

  /* ── writes ────────────────────────────────────────────────────────────── */
  const editForeign = await call('PATCH', `/items/${itemFour}`, {
    token: tokenOne,
    body: { name: `${stamp} renamed by the wrong company` },
  });
  record(
    'editing another company’s item is refused',
    editForeign.status === 403 || editForeign.status === 404,
    `HTTP ${editForeign.status}`,
  );

  const preflightForeign = await call('POST', `/items/preflight/update/${itemFour}`, {
    token: tokenOne,
    body: { name: 'x' },
  });
  record(
    'and the preflight beside it refuses identically, before anything is shown to anybody',
    preflightForeign.status === editForeign.status,
    `preflight HTTP ${preflightForeign.status} vs mutation HTTP ${editForeign.status}`,
  );

  const preflightOwn = await call('POST', `/items/preflight/update/${itemOne}`, {
    token: tokenOne,
    body: { name: 'x' },
  });
  record(
    'the preflight says yes to the one they may change',
    preflightOwn.status === 200 || preflightOwn.status === 201,
    `HTTP ${preflightOwn.status}`,
  );

  const moveOut = await call('PATCH', `/items/${itemOne}`, {
    token: tokenOne,
    body: { categoryId: catFour },
  });
  record(
    'moving their own item into another company’s catalogue is refused',
    moveOut.status === 403,
    `HTTP ${moveOut.status}`,
  );

  const createOrphan = await call('POST', '/items', {
    token: tokenOne,
    body: { name: `${stamp} nowhere`, type: 'ASSET', quantity: 1 },
  });
  record(
    'creating an item with no catalogue is refused for somebody acting inside one',
    createOrphan.status === 403,
    `HTTP ${createOrphan.status}`,
  );

  const createElsewhere = await call('POST', '/categories', {
    token: tokenOne,
    body: { name: `${stamp} smuggled`, entityId: WS_FOUR },
  });
  record(
    'and a category cannot be filed into a company they hold no role in',
    createElsewhere.status === 403,
    `HTTP ${createElsewhere.status}`,
  );

  const foreignAsset = await call('PATCH', `/assets/${assetFour}`, {
    token: tokenOne,
    body: { notes: 'x' },
  });
  record(
    'the rule reaches an asset through its item',
    foreignAsset.status === 403 || foreignAsset.status === 404,
    `HTTP ${foreignAsset.status}`,
  );

  const foreignMaint = await call('POST', '/maintenance', {
    token: tokenOne,
    body: { assetId: assetFour, startDate: new Date().toISOString() },
  });
  record(
    'and a maintenance record through its asset',
    foreignMaint.status === 403,
    `HTTP ${foreignMaint.status}`,
  );

  const ownMaint = await call('POST', '/maintenance', {
    token: tokenOne,
    body: { assetId: assetOne, startDate: new Date().toISOString(), createdBy: 999 },
  });
  record(
    'their own asset can still be sent for maintenance',
    ownMaint.status === 201 || ownMaint.status === 200,
    `HTTP ${ownMaint.status}`,
  );
  if (ownMaint.body?.id) made.maintenance.push(ownMaint.body.id);
  record(
    'and the author recorded is the person holding the token, not the number in the body',
    ownMaint.body?.createdBy === IN_ONE,
    `createdBy=${ownMaint.body?.createdBy} (body asked for 999)`,
  );

  const foreignMaintRead = await call('GET', `/maintenance/${maintFour}`, { token: tokenOne });
  record(
    'another company’s maintenance record reads as missing, the same way an item does',
    foreignMaintRead.status === 404,
    `HTTP ${foreignMaintRead.status}`,
  );

  /*
   * PATCH /maintenance/:id took an unvalidated body until this phase. Giving it
   * a DTO turns the global pipe on, and the pipe refuses fields it has not been
   * told about — so these two say that the edit screen the client actually has
   * still works, and that the one field it sends which the server used to throw
   * away is now answered instead of ignored.
   */
  const ownRecord = ownMaint.body?.id;
  const echoAsset = await call('PATCH', `/maintenance/${ownRecord}`, {
    token: tokenOne,
    body: { assetId: assetOne, type: 'inspection', notes: `${stamp} edited` },
  });
  record(
    'the edit form’s own payload is still accepted, assetId and all',
    echoAsset.status === 200,
    `HTTP ${echoAsset.status}`,
  );

  const moveRecord = await call('PATCH', `/maintenance/${ownRecord}`, {
    token: tokenOne,
    body: { assetId: assetFour },
  });
  record(
    'and naming a different asset is refused in words rather than dropped in silence',
    moveRecord.status === 400 || moveRecord.status === 403,
    `HTTP ${moveRecord.status} — ${JSON.stringify(moveRecord.body?.message ?? '').slice(0, 60)}`,
  );

  const junkField = await call('PATCH', `/maintenance/${ownRecord}`, {
    token: tokenOne,
    body: { status: 'FINANCE_APPROVED' },
  });
  record(
    'a field the route never meant to take is refused, where it used to ride along unexamined',
    junkField.status === 400,
    `HTTP ${junkField.status}`,
  );

  console.log('\nthe workspace a caller claims');

  /* ── declaring ─────────────────────────────────────────────────────────── */
  const claimForeign = await call('GET', '/items', { token: tokenOne, ws: WS_FOUR });
  record(
    'claiming a company they hold no role in is refused outright, not quietly ignored',
    claimForeign.status === 403,
    `HTTP ${claimForeign.status}`,
  );

  const claimOwn = await call('GET', '/items', { token: tokenOne, ws: WS_ONE });
  record(
    'claiming their own changes nothing',
    names(claimOwn).some((n) => n.includes('drill')),
    `${Array.isArray(claimOwn.body) ? claimOwn.body.length : '?'} row(s)`,
  );

  const fromFour = await call('GET', '/items', { token: tokenFour });
  record(
    'the other side sees the mirror image',
    names(fromFour).some((n) => n.includes('ladder')) &&
      !names(fromFour).some((n) => n.includes('drill')),
  );

  console.log('\nnobody real is affected');

  /* ── the wildcard actor, which is every real account here ──────────────── */
  const allItems = await call('GET', '/items', { token: tokenAll });
  record(
    'a wildcard role sees both catalogues, exactly as before this phase',
    names(allItems).some((n) => n.includes('drill')) &&
      names(allItems).some((n) => n.includes('ladder')),
    `${Array.isArray(allItems.body) ? allItems.body.length : '?'} row(s)`,
  );
  record(
    'including the item that belongs to no company, which is still reachable',
    names(allItems).some((n) => n.includes('orphan')),
  );

  /*
   * The assistant already sends x-entity-id on every warehouse call, and the
   * company it sends is the person's current one — usually a company that keeps
   * no catalogue of its own, because stock here is a shared pool. If declaring a
   * company filtered the catalogue, every warehouse read the assistant makes
   * would answer with nothing. It does not, and these two say so out loud.
   */
  const allNarrowed = await call('GET', '/items', { token: tokenAll, ws: WS_FOUR });
  record(
    'declaring a company does not hide the shared pool from a wildcard role',
    names(allNarrowed).some((n) => n.includes('ladder')) &&
      names(allNarrowed).some((n) => n.includes('drill')),
    `${Array.isArray(allNarrowed.body) ? allNarrowed.body.length : '?'} row(s)`,
  );

  const asAssistant = await call('GET', '/items', { token: tokenAll, ws: 7 });
  record(
    'and a company with no catalogue of its own still sees the stock it reserves from',
    names(asAssistant).some((n) => n.includes('drill')) &&
      names(asAssistant).some((n) => n.includes('ladder')),
    'company 7 keeps no catalogue; 44 of its reservations cross into 1 and 4',
  );

  const junkHeader = await call('GET', '/items', { token: tokenAll, ws: 'nonsense' });
  record(
    'a header that is not a workspace declares nothing rather than becoming one',
    names(junkHeader).some((n) => n.includes('drill')) &&
      names(junkHeader).some((n) => n.includes('ladder')),
  );

  console.log('\nbeing a manager of one company is not being a manager of all');

  /*
   * The hole this phase exists to close. Permissions used to resolve with no
   * company at all, so a grant scoped to company 1 satisfied the guard for
   * company 4 as readily as for its own. This person holds a role in both
   * companies but may manage items in only one of them.
   */
  const scoped = makeActor(FLOOR + 55, 0);
  psql(
    'nairon_users',
    `DELETE FROM "UserRole" WHERE "userId" = ${scoped.id};
     INSERT INTO "UserRole" ("userId", "roleId", "entityId") VALUES (${scoped.id}, ${scoped.id}, ${WS_ONE});
     INSERT INTO "UserRole" ("userId", "roleId", "entityId") VALUES (${scoped.id}, ${scoped.id}, ${WS_FOUR});

     -- manage_items only in company 1; everything else stays company-wide so
     -- that what a refusal proves is the scope and not a missing login.
     UPDATE "RolePermission" rp SET "entityId" = ${WS_ONE}
       FROM "Permission" p
       WHERE p.id = rp."permissionId" AND rp."roleId" = ${scoped.id} AND p.name = 'manage_items';`,
  );
  const scopedToken = await login(scoped.email, scoped.password);

  const asOne = await call('PATCH', `/items/${itemOne}`, {
    token: scopedToken,
    ws: WS_ONE,
    body: { notes: `${stamp} edited as company one` },
  });
  record(
    'acting as the company they manage items in, the edit goes through',
    asOne.status === 200,
    `HTTP ${asOne.status}`,
  );

  const asFour = await call('PATCH', `/items/${itemOne}`, {
    token: scopedToken,
    ws: WS_FOUR,
    body: { notes: `${stamp} edited as company four` },
  });
  record(
    'acting as the other one, the same edit is refused — the grant does not travel',
    asFour.status === 403,
    `HTTP ${asFour.status}`,
  );

  const asNobody = await call('PATCH', `/items/${itemOne}`, {
    token: scopedToken,
    body: { notes: `${stamp} edited as nobody in particular` },
  });
  record(
    'declaring nothing still resolves across every role, which is what keeps today’s clients working',
    asNobody.status === 200,
    `HTTP ${asNobody.status}`,
  );

  const claimSeven = await call('GET', '/items', { token: scopedToken, ws: 7 });
  record(
    'and they cannot act as a company they hold no role in at all',
    claimSeven.status === 403,
    `HTTP ${claimSeven.status}`,
  );

  console.log('\nthe list that used to answer with everything');

  const returnsUnfiltered = await call('GET', '/resource-returns', { token: tokenAll });
  record(
    'warehouse staff may still ask for the whole return list',
    returnsUnfiltered.status === 200,
    `HTTP ${returnsUnfiltered.status}`,
  );

  /* Somebody with a token and no warehouse rights at all — a person on a CRM
   * task, which is who this route was left open for. */
  const bystander = makeActor(FLOOR + 54, 0);
  psql('nairon_users', `DELETE FROM "RolePermission" WHERE "roleId" = ${bystander.id};`);
  const bystanderToken = await login(bystander.email, bystander.password);

  const bystanderAll = await call('GET', '/resource-returns', { token: bystanderToken });
  record(
    'somebody with no warehouse rights can no longer ask for every return there is',
    bystanderAll.status === 403,
    `HTTP ${bystanderAll.status}`,
  );

  const bystanderTask = await call('GET', '/resource-returns?taskId=1', { token: bystanderToken });
  record(
    'but may still ask about one task, which is what the CRM screen sends',
    bystanderTask.status === 200,
    `HTTP ${bystanderTask.status}`,
  );

  console.log('\nnothing a refusal touched was written');

  const renamed = psql(
    'nairon_warehouse',
    `SELECT count(*) FROM "Item" WHERE name LIKE '${stamp}%renamed%' OR name LIKE '${stamp} nowhere'`,
  );
  record('no refused write left a row behind', renamed === '0', `${renamed} row(s)`);

  const smuggled = psql(
    'nairon_warehouse',
    `SELECT count(*) FROM "ItemCategory" WHERE name LIKE '${stamp} smuggled'`,
  );
  record('no refused category was filed anywhere', smuggled === '0', `${smuggled} row(s)`);

  const stillHome = psql(
    'nairon_warehouse',
    `SELECT "categoryId" FROM "Item" WHERE id = ${itemOne}`,
  );
  record(
    'and the item somebody tried to move is where it was',
    Number(stillHome) === catOne,
    `categoryId=${stillHome}`,
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
  const ids = (l) => [...new Set(l.filter(Boolean))].join(',');

  safely('warehouse rows', () => {
    psql(
      'nairon_warehouse',
      `DELETE FROM "MaintenanceRecord" WHERE "assetId" IN (${ids(made.assets) || '-1'}) OR id IN (${ids(made.maintenance) || '-1'});
       DELETE FROM "Asset" WHERE id IN (${ids(made.assets) || '-1'});
       DELETE FROM "Item" WHERE id IN (${ids(made.items) || '-1'}) OR name LIKE '${stamp}%';
       DELETE FROM "ItemCategory" WHERE id IN (${ids(made.categories) || '-1'}) OR name LIKE '${stamp}%';`,
    );
  });
  safely('actors', () => {
    psql(
      'nairon_users',
      `DELETE FROM "UserRole" WHERE "userId" IN (${ids(made.users) || '-1'});
       DELETE FROM "RolePermission" WHERE "roleId" IN (${ids(made.roles) || '-1'});
       DELETE FROM "User" WHERE id IN (${ids(made.users) || '-1'});
       DELETE FROM "Role" WHERE id IN (${ids(made.roles) || '-1'});`,
    );
  });

  const left = {
    actors: Number(psql('nairon_users', `SELECT count(*) FROM "User" WHERE id >= ${FLOOR}`)),
    roles: Number(psql('nairon_users', `SELECT count(*) FROM "Role" WHERE id >= ${FLOOR}`)),
    items: Number(psql('nairon_warehouse', `SELECT count(*) FROM "Item" WHERE name LIKE '${stamp}%'`)),
    categories: Number(
      psql('nairon_warehouse', `SELECT count(*) FROM "ItemCategory" WHERE name LIKE '${stamp}%'`),
    ),
  };
  console.log('\ncleanup:', JSON.stringify(left), errors.length ? `errors: ${errors.join(' | ')}` : '');
  if (crashed) console.error('\nthe run stopped early:', crashed?.stack ?? crashed);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed || errors.length || crashed ? 1 : 0);
}
