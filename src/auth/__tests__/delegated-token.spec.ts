/*
 * Synthetic key, set before anything reads it. Never a real credential.
 */
const TEST_JWT_SECRET = 'synthetic-warehouse-delegated-test-key';
process.env.JWT_SECRET = TEST_JWT_SECRET;

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { AuthGuard } from '../guards/auth.guard';
import { NotForDelegatedTokens } from '../delegated-token.policy';
import { FilesController } from '../../files/files.controller';

/*
 * warehouse-api's side of the delegated-token rule. ai-api calls this service
 * directly, not through the gateway, so the global AuthGuard applies the rule.
 */

const jwt = new JwtService({ secret: TEST_JWT_SECRET });
const deactivated = new Set<number>();
const usersPrisma = {
  isDeactivated: async (id: number) => deactivated.has(Number(id)),
  getUserAccessInfo: async () => ({ isSuperAdmin: false, isGlobalSuperAdmin: false, permissionNames: ['view_all_transfers'] }),
};
const actors = { resolve: async (req: any) => ({ userId: Number(req.user.id) }) };
const guard = new AuthGuard(new JwtService(), new Reflector(), usersPrisma as any, actors as any);

const normalToken = () => jwt.sign({ id: 18, email: 'owner@example.test' }, { expiresIn: '30d' });
const delegatedToken = (overrides: Record<string, unknown> = {}, expiresIn = 300) =>
  jwt.sign(
    {
      id: 18,
      email: 'owner@example.test',
      sub: '18',
      entityId: 4,
      scope: 'read',
      act: { sub: 'ai-goal', goalId: 'goal-3f2a' },
      src: 'ai-delegated',
      ...overrides,
    },
    { expiresIn },
  );

class Plain {
  read() {}
}
class Marked {
  @NotForDelegatedTokens()
  read() {}
}

async function outcome(opts: { method?: string; token?: string; entity?: unknown; handler?: Function; cls?: Function }) {
  const request: any = {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.entity === undefined ? { 'x-entity-id': '4' } : opts.entity === null ? {} : { 'x-entity-id': opts.entity }),
    },
  };
  const context: any = {
    getHandler: () => opts.handler ?? Plain.prototype.read,
    getClass: () => opts.cls ?? Plain,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  try {
    await guard.canActivate(context);
    return { ok: true, user: request.user } as any;
  } catch (e) {
    if (e instanceof ForbiddenException) return { ok: false, status: 403, body: e.getResponse() as any };
    if (e instanceof UnauthorizedException) return { ok: false, status: 401 };
    throw e;
  }
}

const saved = process.env.DELEGATED_TOKENS_READONLY;
const setFlag = (v: string | undefined) => {
  if (v === undefined) delete process.env.DELEGATED_TOKENS_READONLY;
  else process.env.DELEGATED_TOKENS_READONLY = v;
};
afterEach(() => {
  setFlag(saved);
  deactivated.clear();
});

const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];

describe('normal tokens are unaffected, flag on or off', () => {
  it.each([undefined, 'true'])('flag %p', async (flag) => {
    setFlag(flag);
    for (const method of ['GET', ...WRITES]) expect((await outcome({ method, token: normalToken() })).ok).toBe(true);
    expect((await outcome({ method: 'POST', token: normalToken(), entity: null })).ok).toBe(true);
    expect((await outcome({ token: normalToken(), handler: Marked.prototype.read, cls: Marked })).ok).toBe(true);
    expect((await outcome({})).status).toBe(401);
    deactivated.add(18);
    expect((await outcome({ token: normalToken() })).status).toBe(401);
  });
});

describe('DELEGATED_TOKENS_READONLY=true', () => {
  beforeEach(() => setFlag('true'));

  it('lets a delegated read token GET as the person', async () => {
    const r = await outcome({ token: delegatedToken() });
    expect(r.ok).toBe(true);
    expect(r.user.id).toBe(18);
  });

  it.each([...WRITES, 'HEAD'])('refuses %s', async (method) => {
    const r = await outcome({ method, token: delegatedToken() });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'delegated_token_forbidden', reason: 'method_not_allowed' });
  });

  it.each([['7'], ['0'], [''], [null], [['4', '7']]])(
    'refuses X-Entity-ID %p (no header would count every organisation’s grants here)',
    async (entity) => {
      expect((await outcome({ token: delegatedToken(), entity })).body.reason).toBe('entity_mismatch');
    },
  );

  it('refuses a non-read scope, an expired token and a deactivated owner', async () => {
    expect((await outcome({ token: delegatedToken({ scope: 'write' }) })).body.reason).toBe('unsupported_scope');
    const expired = delegatedToken({ iat: Math.floor(Date.now() / 1000) - 301 }, 300);
    expect((await outcome({ token: expired })).status).toBe(401);
    deactivated.add(18);
    expect((await outcome({ token: delegatedToken() })).status).toBe(401);
  });

  it('refuses a GET marked @NotForDelegatedTokens()', async () => {
    const r = await outcome({ token: delegatedToken(), handler: Marked.prototype.read, cls: Marked });
    expect(r.body.reason).toBe('route_not_allowed');
  });
});

describe('flag off: delegated tokens are refused outright', () => {
  it.each([undefined, 'false', '1'])('flag %p', async (flag) => {
    setFlag(flag);
    for (const method of ['GET', ...WRITES]) {
      expect((await outcome({ method, token: delegatedToken() })).body.reason).toBe('delegated_tokens_disabled');
    }
  });
});

describe('file links (cookie or bearer)', () => {
  it.each([undefined, 'true'])('open for a person, never for a delegated token (flag %p)', async (flag) => {
    setFlag(flag);
    const files: any = new FilesController({} as any, jwt, usersPrisma as any);
    await expect(files.who({ headers: { authorization: `Bearer ${normalToken()}` } })).resolves.toMatchObject({ userId: 18 });
    await expect(files.who({ headers: { cookie: `nairon_session=${normalToken()}` } })).resolves.toMatchObject({ userId: 18 });
    await expect(files.who({ headers: { authorization: `Bearer ${delegatedToken()}` } })).resolves.toBeNull();
    await expect(files.who({ headers: { cookie: `nairon_session=${delegatedToken()}` } })).resolves.toBeNull();
  });
});
