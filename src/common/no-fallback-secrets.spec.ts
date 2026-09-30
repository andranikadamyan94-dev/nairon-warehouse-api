import { reportEmail } from './email-log-reporter';
import { EntitiesController } from '../entities/entities.controller';

/**
 * No literal fallback credentials (2026-09-30).
 *
 * These outgoing calls used to send the string 'nairon-internal' when
 * INTERNAL_SECRET was unset. Unset must now mean nothing is sent, and the
 * caller gets the same answer it gets when HR cannot be reached.
 */

const TEST_SECRET = 'spec-only-internal-secret';
const saved = { INTERNAL_SECRET: process.env.INTERNAL_SECRET, HR_SERVICE_URL: process.env.HR_SERVICE_URL };
const realFetch = global.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  delete process.env.INTERNAL_SECRET;
  process.env.HR_SERVICE_URL = 'http://hr.test';
  fetchMock = jest.fn(async () => ({ ok: true, json: async () => [{ id: 2, name: 'Org', extra: true }] }));
  (global as any).fetch = fetchMock;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  (global as any).fetch = realFetch;
});

describe('reportEmail', () => {
  const entry = { app: 'warehouse' as const, context: 'spec', status: 'SENT' as const };

  it('sends nothing when INTERNAL_SECRET is unset', async () => {
    await expect(reportEmail(entry)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing when INTERNAL_SECRET is blank', async () => {
    process.env.INTERNAL_SECRET = '  ';
    await reportEmail(entry);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends with the configured secret when set', async () => {
    process.env.INTERNAL_SECRET = TEST_SECRET;
    await reportEmail(entry);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://hr.test/api/email-log/internal');
    expect(init.headers['x-internal-secret']).toBe(TEST_SECRET);
  });
});

describe('EntitiesController.findAllUnscoped', () => {
  const controller = () => new EntitiesController({ get: () => 'http://hr.test' } as any);

  it('asks HR nothing and returns an empty list when INTERNAL_SECRET is unset', async () => {
    await expect(controller().findAllUnscoped()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks HR with the configured secret when set', async () => {
    process.env.INTERNAL_SECRET = TEST_SECRET;
    await expect(controller().findAllUnscoped()).resolves.toEqual([{ id: 2, name: 'Org' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://hr.test/api/entities/internal/all');
    expect(init.headers['x-internal-secret']).toBe(TEST_SECRET);
  });
});
