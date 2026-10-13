import { requireInternalSecret } from '../internal-headers';
import { TtlCache } from '../cache/ttl-cache';

/** One CRM project as the warehouse uses it: pickers and labels, nothing more. */
export type CrmProjectRow = { id: number; name: string; entityId: number | null; parentId: number | null };

/** How long CRM's project list is reused (performance audit 2026-10-13, W1). */
export const CRM_PROJECTS_TTL_MS = 60_000;
/** A CRM that does not answer must not hold a cart or a picker open. */
export const CRM_PROJECTS_TIMEOUT_MS = 5_000;

const cache = new TtlCache<'all', CrmProjectRow[]>(CRM_PROJECTS_TTL_MS, 1);
/** Project ids asked for and still absent after a fresh read — not re-asked within the TTL. */
const missing = new TtlCache<number, true>(CRM_PROJECTS_TTL_MS);

async function load(): Promise<CrmProjectRow[]> {
  const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
  const res = await fetch(`${crmUrl}/api/projects/internal`, {
    headers: { 'x-internal-secret': requireInternalSecret() },
    signal: AbortSignal.timeout(CRM_PROJECTS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CRM projects ${res.status}`);
  const body = (await res.json()) as any[];
  return (Array.isArray(body) ? body : []).map((p) => ({
    id: p.id,
    name: p.name,
    entityId: p.entityId ?? null,
    parentId: p.parentId ?? null,
  }));
}

/**
 * CRM's project list, shared by every warehouse caller (the cart's and the
 * warehouse page's project pickers, project labels on checkout and task
 * chips). Each of those used to download all of CRM's projects on every call,
 * uncached and with no timeout — twice per cart open. Now: one read per
 * minute, concurrent callers share it, five seconds at most.
 *
 * Throws when CRM is unreachable; each caller keeps its own fallback.
 *
 * `wanted`: a project id the caller needs a name for. When the cached list
 * lacks it, the list is read once more past the cache (a project made a moment
 * ago must not leave a card without its name, 2026-10-08); an id still absent
 * after that is remembered for the TTL, so a deleted project does not bust the
 * cache on every call.
 */
export async function crmProjects(wanted?: number): Promise<CrmProjectRow[]> {
  const list = await cache.get('all', load);
  if (wanted == null || list.some((p) => p.id === wanted) || missing.peek(wanted)) return list;
  cache.delete('all');
  const fresh = await cache.get('all', load);
  if (!fresh.some((p) => p.id === wanted)) missing.set(wanted, true);
  return fresh;
}

/** id → name, the shape the catalog's labels read. */
export async function crmProjectNameMap(wanted?: number): Promise<Map<number, string>> {
  return new Map((await crmProjects(wanted)).map((p) => [p.id, p.name]));
}

/** Tests only: forget everything remembered. */
export function resetCrmProjectsCache(): void {
  cache.clear();
  missing.clear();
}
