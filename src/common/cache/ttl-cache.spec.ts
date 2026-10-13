import { TtlCache } from './ttl-cache';

describe('TtlCache', () => {
  afterEach(() => jest.useRealTimers());

  it('shares one load between concurrent misses', async () => {
    const cache = new TtlCache<string, number>(1000);
    let calls = 0;
    let release!: (v: number) => void;
    const load = () => {
      calls++;
      return new Promise<number>((r) => (release = r));
    };
    const a = cache.get('k', load);
    const b = cache.get('k', load);
    release(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(calls).toBe(1);
  });

  it('serves a hit within the TTL and reloads after it', async () => {
    jest.useFakeTimers();
    const cache = new TtlCache<string, number>(1000);
    let n = 0;
    const load = async () => ++n;
    expect(await cache.get('k', load)).toBe(1);
    expect(await cache.get('k', load)).toBe(1);
    jest.advanceTimersByTime(1001);
    expect(await cache.get('k', load)).toBe(2);
  });

  it('never caches a failed load', async () => {
    const cache = new TtlCache<string, number>(1000);
    await expect(cache.get('k', async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(await cache.get('k', async () => 5)).toBe(5);
  });

  it('drops the oldest key past its bound', async () => {
    const cache = new TtlCache<string, number>(1000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.peek('c')).toBe(3);
  });
});
