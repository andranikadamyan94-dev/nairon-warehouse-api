import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { requireInternalSecret } from '../common/internal-headers';

type Fetcher = (input: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Is this person in this organisation — asked of HR for a delegated WRITE
 * token (delegated-write.policy.ts), over the internal channel.
 *
 * Not with the caller's token, as WarehouseActorService.fromHr asks: hr-api
 * refuses a write-scoped token outright, and the answer here must not depend
 * on anything the token says. HR's own rule (OrgTreeService.belongsToEntity,
 * GET /api/entities/:id/members/internal) answers; nothing is cached, because
 * a write follows. HR unreachable is a 503 — never assumed either way.
 */
@Injectable()
export class DelegatedWriteMembership {
  private readonly logger = new Logger(DelegatedWriteMembership.name);

  /** A property rather than a constructor argument, so tests can stand it in. */
  fetcher: Fetcher = (input, init) => fetch(input, init) as never;

  async isMember(entityId: number, userId: number): Promise<boolean> {
    if (!Number.isSafeInteger(entityId) || entityId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) return false;
    return (await this.membersAmong(entityId, [userId])).has(userId);
  }

  /**
   * Which of these people belong to the organisation — one HR call per 500
   * (HR's cap).
   */
  async membersAmong(entityId: number, userIds: number[]): Promise<Set<number>> {
    const wanted = [...new Set(userIds.filter((u) => Number.isSafeInteger(u) && u > 0))];
    if (!Number.isSafeInteger(entityId) || entityId <= 0 || !wanted.length) return new Set();
    const hrUrl = (process.env.HR_SERVICE_URL || 'http://localhost:3001').replace(/\/+$/, '');
    const found = new Set<number>();
    try {
      for (let i = 0; i < wanted.length; i += 500) {
        const chunk = wanted.slice(i, i + 500);
        const res = await this.fetcher(`${hrUrl}/api/entities/${entityId}/members/internal?userIds=${chunk.join(',')}`, {
          headers: { 'x-internal-secret': requireInternalSecret() },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HR ${res.status}`);
        const body = await res.json();
        if (!Array.isArray(body)) throw new Error('HR: not a list');
        for (const u of body.map(Number)) if (chunk.includes(u)) found.add(u);
      }
      return found;
    } catch (error) {
      this.logger.warn(`membership of ${entityId} unavailable: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Կազմակերպության անդամակցությունը հիմա հնարավոր չէ ստուգել');
    }
  }
}
