import { OperationsService } from './operations.service';

/**
 * The fingerprint alone. Everything else about this service is about what two
 * database connections do to each other at the same moment, and a mock cannot
 * say anything true about that — scripts/idempotency-e2e.mjs does, against real
 * Postgres.
 *
 * What is worth pinning here is the one piece of pure judgement: which two
 * bodies count as the same intent.
 */
const fp = OperationsService.fingerprint;

describe('two requests, same intent or not', () => {
  it('is the same body whatever order its keys arrive in', () => {
    expect(fp('POST /items', { name: 'Drill', categoryId: 4 })).toBe(
      fp('POST /items', { categoryId: 4, name: 'Drill' }),
    );
  });

  it('sorts at every depth, not only the top', () => {
    expect(fp('POST /x', { a: { p: 1, q: 2 }, b: [1, { m: 1, n: 2 }] })).toBe(
      fp('POST /x', { b: [1, { n: 2, m: 1 }], a: { q: 2, p: 1 } }),
    );
  });

  it('treats a field left out and a field sent as undefined as the same thing', () => {
    expect(fp('POST /items', { name: 'Drill' })).toBe(
      fp('POST /items', { name: 'Drill', code: undefined }),
    );
  });

  it('does not treat undefined and null as the same thing, because the routes do not', () => {
    // `minQuantity: null` clears the threshold; omitting it leaves it alone.
    expect(fp('PATCH /items/1', { minQuantity: null })).not.toBe(fp('PATCH /items/1', {}));
  });

  it('is a different intent when any value differs', () => {
    expect(fp('POST /items', { name: 'Drill' })).not.toBe(fp('POST /items', { name: 'Drills' }));
    expect(fp('POST /items', { quantity: 1 })).not.toBe(fp('POST /items', { quantity: '1' }));
  });

  it('is a different intent on a different route, so one key cannot do two things', () => {
    expect(fp('POST /items', { name: 'Drill' })).not.toBe(fp('POST /maintenance', { name: 'Drill' }));
  });

  it('keeps array order, because a list that reads differently is different', () => {
    expect(fp('POST /x', { xs: [1, 2] })).not.toBe(fp('POST /x', { xs: [2, 1] }));
  });

  it('survives an empty body and a null one without colliding', () => {
    expect(fp('POST /x', {})).not.toBe(fp('POST /x', null));
  });
});
