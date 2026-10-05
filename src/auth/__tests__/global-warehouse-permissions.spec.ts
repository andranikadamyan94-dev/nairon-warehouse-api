/*
 * Synthetic key, set before anything reads it. Never a real credential.
 */
const TEST_JWT_SECRET = 'synthetic-warehouse-global-permissions-test-key';
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.HR_SERVICE_URL = 'http://hr.test';

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { WarehouseActorService } from '../actor.service';
import { AuthGuard } from '../guards/auth.guard';
import { PERMISSIONS_KEY, PermissionGuard } from '../guards/permission.guard';
import { AssetCustodyController } from '../../asset-custody/asset-custody.controller';

/*
 * "The warehouse is global" (owner, 2026-10-05): warehouse permissions must
 * not depend on the organisation the browser has selected.
 *
 * Since 2026-09-12 the actor was resolved IN the declared organisation and a
 * header naming one the person had no role in was a 403. Since 2026-10-02 the
 * warehouse client sends X-Entity-ID on every request — so the keeper whose
 * only warehouse role lives in company 6 lost every right the moment company
 * 1 was open in the browser. These are the cases of that decision, through
 * the real AuthGuard, WarehouseActorService, PermissionGuard and the custody
 * controller's own resolution; only the users database and HR are stubbed.
 *
 * Delegated AI tokens are deliberately NOT relaxed: issued for one
 * organisation, held to it, refused outside it. Covered here too.
 */

const jwt = new JwtService({ secret: TEST_JWT_SECRET });
const reflector = new Reflector();

/** The keeper: one warehouse role, in company 6 only. */
const KEEPER = 18;
/** A super admin of company 6 only — a scoped assignment, not a wildcard. */
const ADMIN_OF_SIX = 19;
/** Somebody with no role anywhere (HR still files them in company 6). */
const NOBODY = 20;

const roles: Record<number, number[]> = { [KEEPER]: [6], [ADMIN_OF_SIX]: [6], [NOBODY]: [] };
/** Grants per `${userId}:${entityId}`; entity 0 is the union, as the real query answers it. */
const grants: Record<string, string[]> = {
  [`${KEEPER}:6`]: ['manage_warehouse', 'view_warehouse'],
  [`${KEEPER}:0`]: ['manage_warehouse', 'view_warehouse'],
  [`${KEEPER}:1`]: [],
};
const superAdminIn: Record<string, boolean> = { [`${ADMIN_OF_SIX}:6`]: true, [`${ADMIN_OF_SIX}:0`]: true };

const usersPrisma = {
  isDeactivated: async () => false,
  getUserWorkspaces: async (userId: number) => ({ wildcard: false, entityIds: roles[userId] ?? [] }),
  getUserAccessInfo: jest.fn(async (userId: number, entityId = 0) => ({
    isSuperAdmin: !!superAdminIn[`${userId}:${entityId}`],
    isGlobalSuperAdmin: false,
    permissionNames: grants[`${userId}:${entityId}`] ?? [],
    readOnly: false,
  })),
};

// HR, asked with the caller's token for the organisations the person belongs to: company 6 for everyone here.
const realFetch = global.fetch;
global.fetch = (async (url: any, init?: any) => {
  if (String(url) !== 'http://hr.test/api/entities') return realFetch(url, init);
  return new Response(JSON.stringify([{ id: 6 }]), { status: 200 });
}) as typeof fetch;
afterAll(() => {
  global.fetch = realFetch;
});

const actors = new WarehouseActorService(usersPrisma as any);
const auth = new AuthGuard(new JwtService(), reflector, usersPrisma as any, actors);
const permissions = new PermissionGuard(reflector, actors);

const sessionToken = (id: number) => jwt.sign({ id, email: 'owner@example.test' }, { expiresIn: '30d' });
const delegatedToken = (id: number, entityId: number) =>
  jwt.sign(
    { id, email: 'owner@example.test', sub: String(id), entityId, scope: 'read', act: { sub: 'ai-goal', goalId: 'goal-3f2a' }, src: 'ai-delegated' },
    { expiresIn: 300 },
  );

class Guarded {
  list() {}
}
Reflect.defineMetadata(PERMISSIONS_KEY, ['manage_warehouse'], Guarded.prototype.list);

async function outcome(opts: { token: string; entity?: string; method?: string }) {
  const request: any = {
    method: opts.method ?? 'GET',
    headers: { authorization: `Bearer ${opts.token}`, ...(opts.entity === undefined ? {} : { 'x-entity-id': opts.entity }) },
  };
  const context: any = {
    getHandler: () => Guarded.prototype.list,
    getClass: () => Guarded,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  try {
    await auth.canActivate(context);
    await permissions.canActivate(context);
    return { ok: true, request } as any;
  } catch (e) {
    if (e instanceof ForbiddenException) return { ok: false, status: 403, body: e.getResponse() as any, request };
    if (e instanceof UnauthorizedException) return { ok: false, status: 401, request };
    throw e;
  }
}

const lastResolution = () => usersPrisma.getUserAccessInfo.mock.calls.at(-1);

beforeEach(() => usersPrisma.getUserAccessInfo.mockClear());

describe('an ordinary session · the warehouse is global', () => {
  it('a keeper whose role is in company 6, with company 1 open in the browser, keeps every right — no 403', async () => {
    const r = await outcome({ token: sessionToken(KEEPER), entity: '1' });
    expect(r.ok).toBe(true);
    expect(r.request.actor.permissionNames).toContain('manage_warehouse');
    expect(r.request.permissionNames).toContain('manage_warehouse');
    // Resolved across every organisation, not in the one the header named.
    expect(lastResolution()).toEqual([KEEPER, 0]);
  });

  it('a super admin of company 6 only is a super admin with company 1 open', async () => {
    const r = await outcome({ token: sessionToken(ADMIN_OF_SIX), entity: '1' });
    expect(r.ok).toBe(true);
    expect(r.request.actor.isSuperAdmin).toBe(true);
    expect(r.request.isSuperAdmin).toBe(true);
    expect(lastResolution()).toEqual([ADMIN_OF_SIX, 0]);
  });

  it('a header naming a company the person cannot claim is ignored: the request passes with nothing declared', async () => {
    const r = await outcome({ token: sessionToken(KEEPER), entity: '1' });
    expect(r.ok).toBe(true);
    expect(r.request.actor.declared).toBeNull();
    // The companies they hold a role in are untouched by the header.
    expect(r.request.actor.home).toEqual({ wildcard: false, entityIds: [6] });
  });

  it('a header naming their own company stays the label new records are stamped with', async () => {
    const r = await outcome({ token: sessionToken(KEEPER), entity: '6' });
    expect(r.ok).toBe(true);
    expect(r.request.actor.declared).toBe(6);
    // ...and still resolves across every organisation.
    expect(lastResolution()).toEqual([KEEPER, 0]);
  });

  it('no header at all is what it always was', async () => {
    const r = await outcome({ token: sessionToken(KEEPER) });
    expect(r.ok).toBe(true);
    expect(r.request.actor.declared).toBeNull();
    expect(lastResolution()).toEqual([KEEPER, 0]);
  });

  it('somebody with no role anywhere still holds nothing — the union of nothing is nothing', async () => {
    const r = await outcome({ token: sessionToken(NOBODY), entity: '1' });
    expect(r.status).toBe(403);
    expect(r.body.message).toBe('Պահեստի թույլտվությունները բավարար չեն');
    expect(r.request.actor.declared).toBeNull();
  });
});

describe('a delegated AI token keeps the strict header rule', () => {
  const saved = process.env.DELEGATED_TOKENS_READONLY;
  beforeAll(() => {
    process.env.DELEGATED_TOKENS_READONLY = 'true';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.DELEGATED_TOKENS_READONLY;
    else process.env.DELEGATED_TOKENS_READONLY = saved;
  });

  it('is resolved in the organisation it was issued for, and only there', async () => {
    const r = await outcome({ token: delegatedToken(KEEPER, 6), entity: '6' });
    expect(r.ok).toBe(true);
    expect(r.request.actor.declared).toBe(6);
    expect(lastResolution()).toEqual([KEEPER, 6]);
  });

  it('is still refused when its organisation is one the person holds no role in', async () => {
    const r = await outcome({ token: delegatedToken(KEEPER, 1), entity: '1' });
    expect(r.status).toBe(403);
    expect(r.body.message).toBe('Դուք նշված կազմակերպությունում դեր չունեք');
    expect(r.request.actor).toBeUndefined();
  });

  it('is still refused when the header disagrees with the token', async () => {
    const r = await outcome({ token: delegatedToken(KEEPER, 6), entity: '1' });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('entity_mismatch');
  });
});

describe('the custody controller resolves rights the same way', () => {
  const controller = new AssetCustodyController({} as any, usersPrisma as any, {} as any);
  const custodyActor = (user: Record<string, unknown>, entity?: string) =>
    (controller as any).actor({ user, headers: entity === undefined ? {} : { 'x-entity-id': entity } });

  it('a session with company 1 open keeps the custody rights of its company-6 role', async () => {
    const actor = await custodyActor({ id: KEEPER }, '1');
    expect(actor).toEqual({ userId: KEEPER, isSuperAdmin: false, permissions: ['manage_warehouse', 'view_warehouse'] });
    expect(lastResolution()).toEqual([KEEPER, 0]);
  });

  it('a super admin of company 6 only is a super admin with company 1 open', async () => {
    const actor = await custodyActor({ id: ADMIN_OF_SIX }, '1');
    expect(actor.isSuperAdmin).toBe(true);
    expect(lastResolution()).toEqual([ADMIN_OF_SIX, 0]);
  });

  it('a delegated token is resolved in its own organisation only', async () => {
    const delegated = { id: KEEPER, entityId: 6, scope: 'read', act: { sub: 'ai-goal', goalId: 'goal-3f2a' } };
    await custodyActor(delegated, '6');
    expect(lastResolution()).toEqual([KEEPER, 6]);
  });
});
