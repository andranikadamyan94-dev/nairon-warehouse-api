import { Logger } from '@nestjs/common';
import { UsersPrismaService } from '../users-prisma.service';
import { WAREHOUSE_TYPES, WarehouseNotificationsService } from './notifications.service';

/**
 * Notifications phase 1 (2026-10-06): every warehouse notice goes through
 * hr-api's hub with a catalog type; email is hr-api's (the `email` block, one
 * message per person) — the warehouse has no SMTP of its own; the audience is
 * the permission holders of the record's organisation.
 */
const SECRET = 'wh-test-secret';

function world(recipients = [{ id: 4, email: 'a@x' }, { id: 5, email: 'b@x' }]) {
  const users = {
    getNotificationRecipients: jest.fn(async () => recipients),
    getUsersByIds: jest.fn(async (ids: number[]) => ids.map((id) => ({ id, email: `${id}@x` }))),
  };
  const svc = new WarehouseNotificationsService(users as unknown as UsersPrismaService);
  const calls: { url: string; body: any }[] = [];
  svc.http = jest.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 201 } as any;
  }) as any;
  return { svc, users, calls };
}

const base = {
  type: WAREHOUSE_TYPES.lowStock,
  permissions: ['receive_stock_alerts', 'manage_warehouse'],
  entityIds: [7],
  title: 'Պաշարը սպառվում է',
  body: 'Քիչ է',
  path: '/',
  details: [{ label: 'Ապրանք', value: 'Ցեմենտ' }],
};

describe('WarehouseNotificationsService', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INTERNAL_SECRET = SECRET;
    process.env.HR_SERVICE_URL = 'http://hr.test';
    process.env.FRONTEND_URL = 'https://wh.test';
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('asks for the holders in the record\'s organisation and sends each one notice with type and email block', async () => {
    const { svc, users, calls } = world();
    await svc.send(base);
    expect(users.getNotificationRecipients).toHaveBeenCalledWith(base.permissions, [7]);
    expect(calls.map((c) => c.url)).toEqual(['http://hr.test/api/notifications/internal', 'http://hr.test/api/notifications/internal']);
    expect(calls.map((c) => c.body)).toEqual([4, 5].map((userId) => ({
      userId,
      type: 'warehouse.low_stock',
      title: base.title,
      body: base.body,
      url: 'https://wh.test/',
      email: { subject: base.title, details: base.details },
    })));
  });

  it('every send carries a type — also the direct-to-person ones', async () => {
    const { svc, calls } = world();
    await svc.sendToUsers([9, 9, NaN], { type: WAREHOUSE_TYPES.assetIssued, title: 't', body: 'b', path: '/profile' });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ userId: 9, type: 'warehouse.asset_issued' });
  });

  it('a missing INTERNAL_SECRET is logged, not swallowed; nothing is sent', async () => {
    delete process.env.INTERNAL_SECRET;
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc, calls } = world();
    await expect(svc.send(base)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('INTERNAL_SECRET'));
  });

  it('hr-api down: logged, never thrown, and no other channel is tried', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc } = world();
    svc.http = jest.fn(async () => ({ ok: false, status: 503 }) as any) as any;
    await expect(svc.send(base)).resolves.toBeUndefined();
    expect(svc.http).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('failed for 2/2'));
  });

  it('no recipients: nothing sent', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, calls } = world([]);
    await svc.send(base);
    expect(calls).toHaveLength(0);
  });
});
