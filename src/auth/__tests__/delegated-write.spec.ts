/*
 * Synthetic key, set before anything reads it. Never a real credential.
 */
const TEST_JWT_SECRET = 'synthetic-warehouse-delegated-write-test-key';
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.INTERNAL_SECRET = 'synthetic-internal-secret-warehouse-write-tests';
process.env.HR_SERVICE_URL = 'http://hr.test';

import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { AuthGuard } from '../guards/auth.guard';
import { PermissionGuard } from '../guards/permission.guard';
import { WarehouseActorService } from '../actor.service';
import { DelegatedWriteMembership } from '../delegated-write.membership';
import {
  DELEGATED_WRITE_ROUTE_KEY,
  WRITE_REQUIRED_AI_PERMISSIONS,
  WriteTokenLedger,
  delegatedWriteEnabled,
} from '../delegated-write.policy';
import { ReservationsController } from '../../reservations/reservations.controller';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/*
 * warehouse-api's side of the V3.4 write identity: a
 * `goal:write:warehouse.reservations.create:<approvalId>` token may create a
 * reservation (and ask its preflight) and do nothing else. The real
 * AuthGuard, WarehouseActorService and PermissionGuard, the real
 * ReservationsController metadata; the users database and HR are stubs.
 */

const jwt = new JwtService({ secret: TEST_JWT_SECRET });
const reflector = new Reflector();

const AI = [...WRITE_REQUIRED_AI_PERMISSIONS];
const state = {
  grants: new Map<string, string[]>(), // `${userId}:${entityId}` -> literal grants
  roleEntities: new Map<number, number[]>(), // userId -> UserRole.entityId rows
  superAdmin: new Set<number>(),
  members: new Map<number, number[]>(), // entityId -> userIds (HR org tree)
  hrDown: false,
  calls: { internal: [] as string[], withToken: 0 },
};

const usersPrisma = {
  isDeactivated: async () => false,
  getUserWorkspaces: async (userId: number) => {
    const ids = state.roleEntities.get(userId) ?? [];
    return { wildcard: ids.includes(0), entityIds: ids.filter((i) => i > 0) };
  },
  getUserAccessInfo: async (userId: number, entityId = 0) => ({
    isSuperAdmin: state.superAdmin.has(userId),
    isGlobalSuperAdmin: state.superAdmin.has(userId),
    permissionNames: state.grants.get(`${userId}:${entityId}`) ?? [],
  }),
};

// HR, as both channels answer: the internal members route, and /api/entities asked with the caller's token.
const realFetch = global.fetch;
global.fetch = (async (url: any, init?: any) => {
  const href = String(url);
  if (!href.startsWith('http://hr.test/')) return realFetch(url, init);
  if (state.hrDown) throw new Error('connect ECONNREFUSED');
  const internal = href.match(/^http:\/\/hr\.test\/api\/entities\/(\d+)\/members\/internal\?userIds=(\d+)$/);
  if (internal) {
    state.calls.internal.push(href);
    if (init?.headers?.['x-internal-secret'] !== process.env.INTERNAL_SECRET) return new Response('{}', { status: 403 });
    const [entityId, userId] = [Number(internal[1]), Number(internal[2])];
    return new Response(JSON.stringify((state.members.get(entityId) ?? []).includes(userId) ? [userId] : []), { status: 200 });
  }
  if (href === 'http://hr.test/api/entities') {
    state.calls.withToken++;
    const claims: any = jwt.decode(String(init?.headers?.Authorization ?? '').replace(/^Bearer /, ''));
    // hr-api's delegated policy: a write-scoped token is refused there.
    if (typeof claims?.scope === 'string' && claims.scope.startsWith('goal:write:')) return new Response('{}', { status: 403 });
    const ids = [...state.members.entries()].filter(([, users]) => users.includes(Number(claims?.id))).map(([e]) => ({ id: e }));
    return new Response(JSON.stringify(ids), { status: 200 });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;
afterAll(() => {
  global.fetch = realFetch;
});

let ledger = new WriteTokenLedger();
const guards = () => {
  const actors = new WarehouseActorService(usersPrisma as any);
  return {
    auth: new AuthGuard(new JwtService(), reflector, usersPrisma as any, actors, new DelegatedWriteMembership(), ledger),
    permission: new PermissionGuard(reflector, actors),
  };
};

const RESERVE = 'warehouse.reservations.create';
const CHAT = 'chat.messages.send';

const TARGETS: Record<string, Record<string, number>> = { [CHAT]: { chatId: 31 }, [RESERVE]: { taskId: 2462, itemId: 31, quantity: 2 } };
const BODY = { taskId: 2462, startDate: '2026-10-02', resources: [{ itemId: 31, quantity: 2 }] };

let n = 0;
const writeToken = (tool = RESERVE, approvalId = 'appr-9c1e', overrides: Record<string, unknown> = {}, expiresIn = 120) =>
  jwt.sign(
    {
      id: 18,
      email: 'owner@example.test',
      sub: '18',
      entityId: 4,
      scope: `goal:write:${tool}:${approvalId}`,
      act: { sub: 'ai-goal', goalId: 'goal-3f2a', runId: 'run-1', approvalId },
      target: TARGETS[tool] ?? { taskId: 2462, itemId: 31, quantity: 2 },
      src: 'ai-delegated',
      ...overrides,
    },
    { expiresIn, jwtid: `jti-${++n}` },
  );
const readToken = () =>
  jwt.sign(
    { id: 18, email: 'owner@example.test', sub: '18', entityId: 4, scope: 'read', act: { sub: 'ai-goal', goalId: 'goal-3f2a' }, src: 'ai-delegated' },
    { expiresIn: 300 },
  );
const normalToken = () => jwt.sign({ id: 18, email: 'owner@example.test' }, { expiresIn: '30d' });

const CREATE = ReservationsController.prototype.create;
const PREFLIGHT = ReservationsController.prototype.preflightCreate;

async function outcome(opts: { method?: string; token?: string; entity?: string | null; handler?: Function; body?: unknown }) {
  const request: any = {
    method: opts.method ?? 'POST',
    params: {},
    body: opts.body === undefined ? BODY : opts.body,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.entity === null ? {} : { 'x-entity-id': opts.entity ?? '4' }),
    },
  };
  const context: any = {
    getHandler: () => opts.handler ?? CREATE,
    getClass: () => ReservationsController,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  const { auth, permission } = guards();
  try {
    await auth.canActivate(context);
    await permission.canActivate(context);
    return { ok: true, request } as any;
  } catch (e) {
    if (e instanceof ForbiddenException) return { ok: false, status: 403, body: e.getResponse() as any };
    if (e instanceof UnauthorizedException) return { ok: false, status: 401 };
    if (e instanceof ServiceUnavailableException) return { ok: false, status: 503 };
    throw e;
  }
}

const saved = { w: process.env.DELEGATED_TOKENS_WRITE, r: process.env.DELEGATED_TOKENS_READONLY };
const setEnv = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
const flags = (write: string | undefined, read: string | undefined) => {
  setEnv('DELEGATED_TOKENS_WRITE', write);
  setEnv('DELEGATED_TOKENS_READONLY', read);
};

beforeEach(() => {
  ledger = new WriteTokenLedger();
  state.grants.clear();
  state.roleEntities.clear();
  state.superAdmin.clear();
  state.members.clear();
  state.hrDown = false;
  state.calls = { internal: [], withToken: 0 };
  // Person 18: a role assigned in organisation 9 only; in organisation 4 by HR's org tree;
  // the four AI switches and view_warehouse granted in 4.
  state.roleEntities.set(18, [9]);
  state.grants.set('18:4', [...AI, 'view_warehouse']);
  state.members.set(4, [18]);
  flags('true', 'true');
});
afterAll(() => {
  setEnv('DELEGATED_TOKENS_WRITE', saved.w);
  setEnv('DELEGATED_TOKENS_READONLY', saved.r);
});

// ─── Flag off: behaviour unchanged ──────────────────────────────────────────

describe('DELEGATED_TOKENS_WRITE off', () => {
  it.each([undefined, '', 'false', '1', 'TRUE'])('flag %p: a write token is refused on its own route, by the read-only rule, as before', async (v) => {
    flags(v, 'true');
    expect(await outcome({ token: writeToken() })).toMatchObject({ status: 403, body: { error: 'delegated_token_forbidden', reason: 'unsupported_scope' } });
    flags(v, undefined);
    expect((await outcome({ token: writeToken() })).body.reason).toBe('delegated_tokens_disabled');
    expect(state.calls.internal).toHaveLength(0);
  });

  it('normal and read tokens behave exactly as before', async () => {
    flags(undefined, 'true');
    state.grants.set('18:4', ['view_warehouse']);
    expect((await outcome({ token: normalToken() })).ok).toBe(true);
    expect((await outcome({ token: readToken() })).body.reason).toBe('method_not_allowed');
  });

  it('is the flag rule, literally', () => {
    expect(delegatedWriteEnabled({ DELEGATED_TOKENS_WRITE: 'true' } as any)).toBe(true);
    expect(delegatedWriteEnabled({ DELEGATED_TOKENS_READONLY: 'true' } as any)).toBe(false);
  });
});

// ─── Flag on ────────────────────────────────────────────────────────────────

describe('DELEGATED_TOKENS_WRITE=true', () => {
  it('admits a reservation token on POST /reservations, as the person, in exactly its organisation', async () => {
    const r = await outcome({ token: writeToken() });
    expect(r.ok).toBe(true);
    expect(r.request.delegatedWrite).toMatchObject({ tool: RESERVE, entityId: 4, userId: 18, kind: 'mutation' });
    expect(r.request.actor).toMatchObject({ userId: 18, declared: 4 });
    expect(r.request.actor.permissionNames).toContain('view_warehouse');
    // Membership came from HR's internal route, never from asking HR with the token.
    expect(state.calls.internal).toEqual(['http://hr.test/api/entities/4/members/internal?userIds=18']);
    expect(state.calls.withToken).toBe(0);
  });

  it('admits it on the create preflight too, which does not spend it', async () => {
    const token = writeToken();
    expect((await outcome({ token, handler: PREFLIGHT })).ok).toBe(true);
    expect((await outcome({ token, handler: PREFLIGHT })).ok).toBe(true);
    expect((await outcome({ token })).ok).toBe(true);
  });

  it('one token, one write: a second create with the same token → 403', async () => {
    const token = writeToken();
    expect((await outcome({ token })).ok).toBe(true);
    expect((await outcome({ token })).body.reason).toBe('token_already_used');
  });

  it('wrong route: every other reservation handler → 403', async () => {
    const proto = ReservationsController.prototype as any;
    const all = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor' && m !== 'create' && m !== 'preflightCreate');
    // @Public() internal routes never read a bearer token at all (their InternalGuard wants the secret).
    const isPublic = (m: string) => !!reflector.get(IS_PUBLIC_KEY, proto[m]);
    const others = all.filter((m) => !isPublic(m));
    expect(others.length).toBeGreaterThan(5);
    for (const name of others) {
      const r = await outcome({ token: writeToken(), handler: proto[name] });
      expect([name, r.status, r.body?.reason]).toEqual([name, 403, 'route_not_allowed']);
    }
    for (const name of all.filter(isPublic)) {
      const { context, request } = (() => {
        const request: any = { method: 'POST', headers: { authorization: `Bearer ${writeToken()}`, 'x-entity-id': '4' } };
        return { request, context: { getHandler: () => proto[name], getClass: () => ReservationsController, switchToHttp: () => ({ getRequest: () => request }) } as any };
      })();
      await guards().auth.canActivate(context);
      expect([name, request.user, request.delegatedWrite]).toEqual([name, undefined, undefined]);
    }
    expect(state.calls.internal).toHaveLength(0);
  });

  it('wrong tool: a chat token cannot reserve (a second tool) → 403', async () => {
    expect((await outcome({ token: writeToken(CHAT, 'appr-77aa') })).body.reason).toBe('route_not_allowed');
    expect((await outcome({ token: writeToken(CHAT, 'appr-77aa'), handler: PREFLIGHT })).body.reason).toBe('route_not_allowed');
  });

  it('a read token still cannot write', async () => {
    expect((await outcome({ token: readToken() })).body.reason).toBe('method_not_allowed');
    expect((await outcome({ token: readToken(), handler: PREFLIGHT })).body.reason).toBe('method_not_allowed');
  });

  it('expired → 401', async () => {
    const expired = writeToken(RESERVE, 'appr-9c1e', { iat: Math.floor(Date.now() / 1000) - 3600 }, 60);
    expect((await outcome({ token: expired })).status).toBe(401);
  });

  it('other organisation → 403', async () => {
    for (const entity of ['7', '0', null, '']) {
      expect((await outcome({ token: writeToken(), entity })).body.reason).toBe('entity_mismatch');
    }
    // Token and header agree on 7, but HR says the person is not in 7.
    state.grants.set('18:7', [...AI, 'view_warehouse']);
    expect((await outcome({ token: writeToken(RESERVE, 'appr-9c1e', { entityId: 7 }), entity: '7' })).body.reason).toBe('not_a_member');
  });

  it('permission revoked after issue → 403 at the domain', async () => {
    for (const lost of [...AI, 'view_warehouse']) {
      state.grants.set('18:4', [...AI, 'view_warehouse'].filter((p) => p !== lost));
      expect([lost, (await outcome({ token: writeToken() })).body?.reason]).toEqual([lost, 'missing_permission']);
    }
    // manage_reservations or manage_warehouse also carry the reservation right.
    state.grants.set('18:4', [...AI, 'manage_reservations']);
    expect((await outcome({ token: writeToken() })).ok).toBe(true);
    // Super admin stands in for none of the literal rights; another organisation's grants do not count.
    state.grants.set('18:4', []);
    state.grants.set('18:7', [...AI, 'manage_warehouse']);
    state.superAdmin.add(18);
    expect((await outcome({ token: writeToken() })).body.reason).toBe('missing_permission');
  });

  it('HR unreachable → 503, never admitted', async () => {
    state.hrDown = true;
    expect((await outcome({ token: writeToken() })).status).toBe(503);
  });

  it('an act for another approval, or an unknown tool → 403', async () => {
    expect((await outcome({ token: writeToken(RESERVE, 'appr-9c1e', { act: { sub: 'ai-goal', goalId: 'g', approvalId: 'x' } }) })).body.reason).toBe('act_mismatch');
    expect((await outcome({ token: writeToken('warehouse.reservations.cancel', 'appr-9c1e') })).body.reason).toBe('unknown_write_tool');
  });

  it('target: a reservation token reserves only its own task, item and quantity', async () => {
    const wrong: [string, unknown][] = [
      ['another task', { ...BODY, taskId: 2463 }],
      ['another item', { ...BODY, resources: [{ itemId: 32, quantity: 2 }] }],
      ['another quantity', { ...BODY, resources: [{ itemId: 31, quantity: 3 }] }],
      ['a second resource', { ...BODY, resources: [{ itemId: 31, quantity: 2 }, { itemId: 32, quantity: 1 }] }],
      ['a project the approval did not freeze', { ...BODY, projectId: 9 }],
      ['another requesting organisation', { ...BODY, entityId: 7 }],
      ['an end date nobody froze', { ...BODY, endDate: '2027-01-01' }],
      ['an hourly window nobody froze', { ...BODY, resources: [{ itemId: 31, quantity: 2, startTime: '08:00' }] }],
      ['ids as strings', { ...BODY, taskId: '2462' }],
      ['no body', null],
      ['an array', [BODY]],
    ];
    for (const [label, body] of wrong) {
      expect([label, (await outcome({ token: writeToken(), body })).body?.reason]).toEqual([label, 'target_mismatch']);
      expect([label, (await outcome({ token: writeToken(), body, handler: PREFLIGHT })).body?.reason]).toEqual([label, 'target_mismatch']);
    }
    expect(state.calls.internal).toHaveLength(0);
    // A frozen project must be sent, and be that one.
    const withProject = writeToken(RESERVE, 'appr-9c1e', { target: { taskId: 2462, itemId: 31, quantity: 2, projectId: 9 } });
    expect((await outcome({ token: withProject, body: { ...BODY, projectId: 9 } })).ok).toBe(true);
    expect((await outcome({ token: writeToken(RESERVE, 'appr-9c1e', { target: { taskId: 2462, itemId: 31, quantity: 2, projectId: 9 } }), body: { ...BODY, projectId: 8 } })).body.reason).toBe('target_mismatch');
    expect((await outcome({ token: writeToken(RESERVE, 'appr-9c1e', { target: { taskId: 2462, itemId: 31, quantity: 2, projectId: 9 } }) })).body.reason).toBe('target_mismatch');
  });

  it('a token without a well-formed target is refused', async () => {
    for (const target of [undefined, {}, { chatId: 31 }, { taskId: 2462, itemId: 31 }, { taskId: 2462, itemId: 31, quantity: 0 }, { taskId: 2462, itemId: 31, quantity: 2, warehouseId: 1 }]) {
      expect([target, (await outcome({ token: writeToken(RESERVE, 'appr-9c1e', { target }) })).body?.reason]).toEqual([target, 'malformed_write_target']);
    }
  });

  it('normal tokens are untouched', async () => {
    state.grants.set('18:4', ['view_warehouse']);
    expect((await outcome({ token: normalToken() })).ok).toBe(true);
  });
});

describe('the route markers', () => {
  it('exactly create and its preflight carry one, both for warehouse.reservations.create', () => {
    const proto = ReservationsController.prototype as any;
    const marked = Object.getOwnPropertyNames(proto)
      .map((name) => [name, reflector.get(DELEGATED_WRITE_ROUTE_KEY, proto[name])])
      .filter(([, meta]) => meta);
    expect(marked).toEqual([
      ['create', { tool: RESERVE, kind: 'mutation' }],
      ['preflightCreate', { tool: RESERVE, kind: 'preflight' }],
    ]);
  });
});
