/*
 * Synthetic key, set before anything reads it. Never a real credential.
 */
const TEST_JWT_SECRET = 'synthetic-warehouse-read-only-test-key';
process.env.JWT_SECRET = TEST_JWT_SECRET;

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { WarehouseActorService } from '../actor.service';
import { Public } from '../decorators/public.decorator';
import { AuthGuard } from '../guards/auth.guard';
import { PERMISSIONS_KEY, PermissionGuard } from '../guards/permission.guard';
import { READ_ONLY_ALLOWED_WRITES, READ_ONLY_FORBIDDEN } from '../read-only.policy';
import { AvailabilityController } from '../../availability/availability.controller';

/*
 * The read-only super administrator — auth/read-only.policy.ts.
 *
 * A holder sees everything a super-admin sees and is refused every change.
 * The flag is part of the actor; the global AuthGuard applies the rule right
 * after resolving it, so PermissionGuard's super-admin bypass never gets a
 * chance on a write.
 */

const jwt = new JwtService({ secret: TEST_JWT_SECRET });
const READER = 18;
const ADMIN = 19;

const usersPrisma = {
  isDeactivated: async () => false,
  getUserWorkspaces: async () => ({ wildcard: true, entityIds: [] as number[] }),
  // Both are global super-admins; only one holds a read-only role.
  getUserAccessInfo: async (id: number) => ({
    isSuperAdmin: true,
    isGlobalSuperAdmin: true,
    permissionNames: [] as string[],
    readOnly: id === READER,
  }),
};
const actors = new WarehouseActorService(usersPrisma as any);
const auth = new AuthGuard(new JwtService(), new Reflector(), usersPrisma as any, actors);
const permissions = new PermissionGuard(new Reflector(), actors);

const token = (id: number) => jwt.sign({ id, email: 'owner@example.test' }, { expiresIn: '30d' });

class Plain {
  create() {}
}
class Open {
  @Public()
  ping() {}
}
class Guarded {
  list() {}
}
Reflect.defineMetadata(PERMISSIONS_KEY, ['manage_warehouse'], Guarded.prototype.list);

async function outcome(opts: { method: string; who?: number; handler?: Function; cls?: Function; through?: 'both' }) {
  const request: any = {
    method: opts.method,
    headers: opts.who ? { authorization: `Bearer ${token(opts.who)}` } : {},
  };
  const context: any = {
    getHandler: () => opts.handler ?? Plain.prototype.create,
    getClass: () => opts.cls ?? Plain,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  try {
    await auth.canActivate(context);
    if (opts.through === 'both') await permissions.canActivate(context);
    return { ok: true, request } as any;
  } catch (e) {
    if (e instanceof ForbiddenException) return { ok: false, status: 403, body: e.getResponse() as any, request };
    if (e instanceof UnauthorizedException) return { ok: false, status: 401, request };
    throw e;
  }
}

const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];

describe('a read-only super administrator', () => {
  it('reads as a super-admin, through both guards, and the flag rides on the actor and the request', async () => {
    const r = await outcome({ method: 'GET', who: READER, handler: Guarded.prototype.list, cls: Guarded, through: 'both' });
    expect(r.ok).toBe(true);
    expect(r.request.actor.readOnly).toBe(true);
    expect(r.request.readOnly).toBe(true);
    expect(r.request.isSuperAdmin).toBe(true); // PermissionGuard's bypass still opened the route
  });

  it.each(WRITES)('is refused %s with the read-only sentence, before PermissionGuard runs', async (method) => {
    const r = await outcome({ method, who: READER, through: 'both' });
    expect(r.status).toBe(403);
    expect(r.body.message).toBe(READ_ONLY_FORBIDDEN);
    expect(r.request.isSuperAdmin).toBeUndefined();
  });

  it('may still ask the stock availability check — the one allowlisted POST, a pure read', async () => {
    const r = await outcome({ method: 'POST', who: READER, handler: AvailabilityController.prototype.checkAvailability, cls: AvailabilityController });
    expect(r.ok).toBe(true);
  });

  it('every allowlist entry names a real handler', () => {
    const real: Record<string, Function> = { AvailabilityController };
    for (const key of READ_ONLY_ALLOWED_WRITES) {
      const [cls, handler] = key.split('.');
      expect(typeof real[cls]?.prototype?.[handler]).toBe('function');
    }
    expect(READ_ONLY_ALLOWED_WRITES.size).toBe(1);
  });
});

describe('everyone else is untouched', () => {
  it('a normal super-admin still writes', async () => {
    for (const method of WRITES) {
      const r = await outcome({ method, who: ADMIN, through: 'both' });
      expect(r.ok).toBe(true);
      expect(r.request.readOnly).toBe(false);
    }
  });

  it('a public route carries no user and is never asked (internal x-internal-secret routes are @Public too)', async () => {
    expect((await outcome({ method: 'POST', handler: Open.prototype.ping, cls: Open })).ok).toBe(true);
    expect((await outcome({ method: 'DELETE', who: READER, handler: Open.prototype.ping, cls: Open })).ok).toBe(true);
    expect((await outcome({ method: 'POST' })).status).toBe(401);
  });
});
