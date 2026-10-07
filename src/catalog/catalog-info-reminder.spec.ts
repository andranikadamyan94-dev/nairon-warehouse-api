import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Logger } from '@nestjs/common';

import { PERMISSIONS_KEY } from '../auth/guards/permission.guard';
import { CatalogController } from './catalog.controller';
import { CatalogService, REMINDER_INTERVAL_MS, yerevanClock } from './catalog.service';

/**
 * «Հիշեցնել աշխատակցին» (2026-10-07): the catalog desk reminds the submitter
 * of an unanswered information request — desk only, only while the question
 * is open, once per request per hour, one notice to the submitter with the
 * catalog key warehouse.catalog_info_reminder, kept in the history.
 */

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

const ASKED_AT = new Date('2026-10-07T05:05:00.000Z'); // 09:05 in Yerevan

function world(overrides: Partial<any> = {}) {
  const row: any = {
    id: 4,
    number: 'REQ-1051',
    createdBy: 10,
    entityId: 2,
    purpose: 'p',
    neededBy: new Date('2026-10-15'),
    createdAt: new Date('2026-10-06T12:20:00.000Z'),
    infoRequestText: 'Նշեք ցանկալի չափսերը',
    infoRequestBy: 30,
    infoRequestAt: ASKED_AT,
    cancelledAt: null,
    lastReminderAt: null,
    lastReminderBy: null,
    reminders: [],
    ...overrides,
  };
  const matches = (where: any) => {
    if (where.id !== row.id) return false;
    if (where.infoRequestAt?.not === null && !row.infoRequestAt) return false;
    if (where.cancelledAt === null && row.cancelledAt) return false;
    if (where.OR) {
      return where.OR.some((c: any) =>
        c.lastReminderAt === null ? row.lastReminderAt == null : row.lastReminderAt != null && row.lastReminderAt <= c.lastReminderAt.lte,
      );
    }
    return true;
  };
  const prisma: any = {
    catalogSubmission: {
      findMany: jest.fn(async () => [{ ...row }]),
      findUnique: jest.fn(async () => ({ ...row })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    resourceReservation: { findMany: jest.fn(async () => []) },
    purchaseRequisition: { findMany: jest.fn(async () => []) },
  };
  const users: any = {
    getUsersByIds: jest.fn(async (ids: number[]) =>
      ids.map((id) => ({ id, email: `u${id}@x.am`, firstName: id === 30 ? 'Արամ' : 'Անի', lastName: id === 30 ? 'Պետրոսյան' : 'Սարգսյան' })),
    ),
  };
  const sent: any[] = [];
  const n: any = { send: jest.fn(async (x: any) => void sent.push(x)), audience: jest.fn(async () => []) };
  const svc = new CatalogService(prisma, users, {} as any, {} as any, {} as any, {} as any, n);
  (svc as any).directory = jest.fn(async () => ({ unitOf: new Map(), entityName: new Map() }));
  (svc as any).freeStock = jest.fn(async () => new Map());
  return { svc, prisma, row, sent };
}

const DESK = { userId: 30, isSuperAdmin: false, permissionNames: ['view_catalog_requests'] } as any;
const PLAIN = { userId: 31, isSuperAdmin: false, permissionNames: ['view_warehouse'] } as any;

describe('POST /catalog/submissions/:id/remind', () => {
  it('the route is the catalog desk’s: guarded by view_catalog_requests', () => {
    const perms = Reflect.getMetadata(PERMISSIONS_KEY, CatalogController.prototype.remind);
    expect(perms).toEqual(['view_catalog_requests']);
  });

  it('someone outside the desk is refused, nothing sent', async () => {
    const { svc, sent, prisma } = world();
    await expect(svc.remind(4, PLAIN)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.catalogSubmission.updateMany).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('refused unless the request waits for the employee’s answer', async () => {
    const { svc, sent } = world({ infoRequestAt: null, infoRequestText: null, infoRequestBy: null });
    await expect(svc.remind(4, DESK)).rejects.toThrow('Հարցումը չի սպասում աշխատակցի պատասխանին');
    expect(sent).toHaveLength(0);
  });

  it('refused on a cancelled request', async () => {
    const { svc, sent } = world({ cancelledAt: new Date() });
    await expect(svc.remind(4, DESK)).rejects.toBeInstanceOf(BadRequestException);
    expect(sent).toHaveLength(0);
  });

  it('sends ONE notice to the submitter: the key, the question, who reminds, the employee’s page; stamps the history', async () => {
    const { svc, sent, row } = world();
    const view = await svc.remind(4, DESK);
    await new Promise((r) => setImmediate(r));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'warehouse.catalog_info_reminder',
      userIds: [10],
      actorId: 30,
      title: 'Հիշեցում՝ պատասխանեք կատալոգային հարցմանը',
      path: '/catalog/my-requests/4',
    });
    expect(sent[0].permissions).toBeUndefined();
    expect(sent[0].body).toContain('REQ-1051');
    expect(sent[0].body).toContain('«Նշեք ցանկալի չափսերը»');
    expect(sent[0].body).toContain('Արամ Պետրոսյան');
    expect(sent[0].details).toEqual(
      expect.arrayContaining([
        { label: 'Հարց', value: 'Նշեք ցանկալի չափսերը' },
        { label: 'Հարցը տրվել է', value: '07.10.2026, 09:05' },
        { label: 'Հիշեցնում է', value: 'Արամ Պետրոսյան' },
      ]),
    );

    expect(row.lastReminderBy).toBe(30);
    expect(row.reminders).toHaveLength(1);
    const entry = view.timeline.find((t) => t.kind === 'info_reminder');
    expect(entry).toMatchObject({ text: 'Հիշեցում ուղարկվեց', by: { id: 30, name: 'Արամ Պետրոսյան' } });
    expect(view.reminder?.by).toEqual({ id: 30, name: 'Արամ Պետրոսյան' });
    expect(new Date(view.reminder!.nextAt).getTime() - new Date(view.reminder!.lastAt).getTime()).toBe(REMINDER_INTERVAL_MS);
  });

  it('a second press within the hour → 409 naming the time; still one notice', async () => {
    const { svc, sent, row } = world();
    await svc.remind(4, DESK);
    const first = row.lastReminderAt as Date;
    const second = svc.remind(4, DESK);
    await expect(second).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.remind(4, DESK)).rejects.toThrow(`Հիշեցումն արդեն ուղարկվել է ${yerevanClock(first)}-ին`);
    expect(sent).toHaveLength(1);
    expect(row.reminders).toHaveLength(1);
  });

  it('two presses at the same moment send one notice (the claim is a conditional update)', async () => {
    const { svc, sent } = world();
    const results = await Promise.allSettled([svc.remind(4, DESK), svc.remind(4, DESK)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('after the hour a new reminder goes out and both stay in the history', async () => {
    const earlier = new Date(Date.now() - REMINDER_INTERVAL_MS - 1000);
    const { svc, sent } = world({ lastReminderAt: earlier, lastReminderBy: 30, reminders: [{ at: earlier.toISOString(), by: 30 }] });
    const view = await svc.remind(4, DESK);
    expect(sent).toHaveLength(1);
    expect(view.timeline.filter((t) => t.kind === 'info_reminder')).toHaveLength(2);
  });

  it('the submitter cannot remind themselves', async () => {
    const { svc, sent } = world({ createdBy: 30 });
    await expect(svc.remind(4, DESK)).rejects.toBeInstanceOf(BadRequestException);
    expect(sent).toHaveLength(0);
  });
});

describe('yerevanClock', () => {
  it('names the hour in Yerevan', () => {
    expect(yerevanClock(new Date('2026-10-07T11:42:00.000Z'))).toBe('15:42');
  });
});
