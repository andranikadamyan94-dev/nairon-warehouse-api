import { Injectable, Logger } from '@nestjs/common';

import { requireInternalSecret } from './internal-headers';

/**
 * CRM task titles for lists that only hold a task id (#2616 movements report,
 * 2026-10-09). The warehouse has no task data of its own; CRM's internal card
 * (GET /api/project-tasks/:id/internal — there is no batch route) is asked a
 * few at a time and kept briefly, so a page or an export of hundreds of rows
 * costs one round of cards per distinct task, never one call per row. CRM
 * unreachable, or the task gone → no title, the caller prints the id alone.
 * (Same shape and rules as CatalogService.taskLabels.)
 */
export interface TaskLabel {
  id: number;
  title: string | null;
}

@Injectable()
export class TaskLabelsService {
  private readonly logger = new Logger(TaskLabelsService.name);
  private readonly cache = new Map<number, { at: number; value: TaskLabel }>();
  static readonly FRESH_MS = 120_000;
  static readonly BATCH = 8;

  /** `#2325 · Կարգավիճակի սխալ պահպանում`, or `#2325` when the title is unknown. */
  static label(id: number, title: string | null | undefined): string {
    return title ? `#${id} · ${title}` : `#${id}`;
  }

  async titles(ids: number[]): Promise<Map<number, TaskLabel>> {
    const map = new Map<number, TaskLabel>();
    const now = Date.now();
    const missing: number[] = [];
    for (const id of new Set(ids.filter((x) => Number.isInteger(x) && x > 0))) {
      const hit = this.cache.get(id);
      if (hit && now - hit.at < TaskLabelsService.FRESH_MS) map.set(id, hit.value);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += TaskLabelsService.BATCH) {
      await Promise.all(
        missing.slice(i, i + TaskLabelsService.BATCH).map(async (id) => {
          const value = await this.card(id);
          // A miss is not cached: the next list asks again once CRM is back.
          if (value.title !== null) this.cache.set(id, { at: Date.now(), value });
          map.set(id, value);
        }),
      );
    }
    return map;
  }

  private async card(id: number): Promise<TaskLabel> {
    try {
      const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
      const res = await fetch(`${crmUrl}/api/project-tasks/${id}/internal`, { headers: { 'x-internal-secret': requireInternalSecret() } });
      if (!res.ok) return { id, title: null };
      const task: any = await res.json();
      const title = String(task?.title ?? '').trim();
      return { id, title: title || null };
    } catch (e: any) {
      this.logger.debug(`task ${id} title unavailable: ${e?.message ?? e}`);
      return { id, title: null };
    }
  }
}
