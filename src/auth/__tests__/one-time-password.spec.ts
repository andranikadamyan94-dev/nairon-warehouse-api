/*
 * Synthetic key, set before anything reads it. Never a real credential.
 */
const TEST_JWT_SECRET = 'synthetic-warehouse-otp-test-key';
process.env.JWT_SECRET = TEST_JWT_SECRET;

import { Controller, ForbiddenException, Get, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import * as request from 'supertest';

import { AuthGuard } from '../guards/auth.guard';
import { UsersPrismaService } from '../../common/users-prisma.service';
import { WarehouseActorService } from '../actor.service';
import { FilesController } from '../../files/files.controller';
import { FilesService } from '../../files/files.service';

/*
 * One-time-password sessions in warehouse-api (2026-10-07). auth-api marks
 * the session of an account in one-time-password state with `otp: true`. Such
 * a session may only replace its password, which happens in hr-api or
 * crm-api, so every warehouse route refuses it — the global AuthGuard and the
 * cookie file route alike. ai-api reaches this service without the gateway.
 */

const jwt = new JwtService({ secret: TEST_JWT_SECRET });
const otpToken = () => jwt.sign({ id: 21, email: 'otp@example.test', otp: true }, { expiresIn: '1h' });
const normalToken = () => jwt.sign({ id: 21, email: 'otp@example.test' }, { expiresIn: '30d' });
const usersPrisma = { isDeactivated: async () => false };
const actors = { resolve: async (req: any) => ({ userId: Number(req.user.id), readOnly: false }) };

@Controller('probe')
class ProbeController {
  @Get()
  read() {
    return { ok: true };
  }
  @Post()
  write() {
    return { ok: true };
  }
}

describe('HTTP: an OTP token on warehouse routes', () => {
  let app: INestApplication;
  const files = { upload: jest.fn(async () => null) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ global: true, secret: TEST_JWT_SECRET })],
      controllers: [ProbeController, FilesController],
      providers: [
        { provide: UsersPrismaService, useValue: usersPrisma },
        { provide: WarehouseActorService, useValue: actors },
        { provide: FilesService, useValue: files },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => app?.close());

  it.each(['get', 'post'])('%s on a guarded route is 403 one_time_password_required', async (method) => {
    const res = await (request(app.getHttpServer()) as any)[method]('/probe').set('Authorization', `Bearer ${otpToken()}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('one_time_password_required');
  });

  it('a normal token passes the same route', async () => {
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${normalToken()}`);
    expect(res.status).toBe(200);
  });

  it('a file by cookie or header is 401 for an OTP token, and the store is never asked', async () => {
    const byCookie = await request(app.getHttpServer()).get('/uploads/a.png').set('Cookie', `nairon_session=${otpToken()}`);
    const byHeader = await request(app.getHttpServer()).get('/uploads/a.png').set('Authorization', `Bearer ${otpToken()}`);
    expect(byCookie.status).toBe(401);
    expect(byHeader.status).toBe(401);
    expect(files.upload).not.toHaveBeenCalled();
    const normal = await request(app.getHttpServer()).get('/uploads/a.png').set('Authorization', `Bearer ${normalToken()}`);
    expect(normal.status).toBe(404);
    expect(files.upload).toHaveBeenCalledTimes(1);
  });
});

describe('guard: every method', () => {
  const guard = new AuthGuard(new JwtService(), new Reflector(), usersPrisma as any, actors as any);
  class Plain {
    read() {}
  }
  const ctx = (token: string, method: string) => {
    const req: any = { method, headers: { authorization: `Bearer ${token}`, 'x-entity-id': '4' } };
    return { getHandler: () => Plain.prototype.read, getClass: () => Plain, switchToHttp: () => ({ getRequest: () => req }) } as any;
  };
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('%s is refused', async (method) => {
    await expect(guard.canActivate(ctx(otpToken(), method))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('no warehouse route is open to an OTP session', () => {
  it('no controller uses the marker', () => {
    const root = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== '__tests__') walk(full);
        else if (entry.name.endsWith('.controller.ts') && fs.readFileSync(full, 'utf8').includes('OneTimePasswordAllowed')) {
          offenders.push(full);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
