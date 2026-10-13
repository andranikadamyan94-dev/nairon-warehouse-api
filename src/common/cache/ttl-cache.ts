/**
 * A small time-boxed memo with in-flight de-duplication (performance audit
 * 2026-10-13).
 *
 * Every hot read this service repeats — a caller's access info, CRM's project
 * names, the users directory — is the same answer asked many times a second by
 * parallel requests. A plain TTL map still lets a burst of misses all go to the
 * source at once; here the first miss parks its promise and every concurrent
 * caller awaits that one. A failed load is never cached: the next caller tries
 * again rather than inheriting the error for the whole TTL.
 *
 * Process-local on purpose. The service runs as one container per environment,
 * and the owner accepted the staleness each caller picks (≤ its TTL).
 */
export class TtlCache<K, V> {
  private readonly values = new Map<K, { value: V; expiresAt: number }>();
  private readonly pending = new Map<K, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    /** Bound on remembered keys; the oldest are dropped first. */
    private readonly maxEntries = 5_000,
  ) {}

  get(key: K, load: () => Promise<V>): Promise<V> {
    const hit = this.values.get(key);
    if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const p = (async () => {
      try {
        const value = await load();
        this.set(key, value);
        return value;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, p);
    return p;
  }

  /** A remembered value still within its TTL, without loading. */
  peek(key: K): V | undefined {
    const hit = this.values.get(key);
    return hit && hit.expiresAt > Date.now() ? hit.value : undefined;
  }

  set(key: K, value: V): void {
    if (this.values.size >= this.maxEntries && !this.values.has(key)) {
      const oldest = this.values.keys().next();
      if (!oldest.done) this.values.delete(oldest.value);
    }
    this.values.delete(key);
    this.values.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}
