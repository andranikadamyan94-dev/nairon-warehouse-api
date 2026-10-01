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
    const hrUrl = (process.env.HR_SERVICE_URL || 'http://localhost:3001').replace(/\/+$/, '');
    try {
      const res = await this.fetcher(`${hrUrl}/api/entities/${entityId}/members/internal?userIds=${userId}`, {
        headers: { 'x-internal-secret': requireInternalSecret() },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HR ${res.status}`);
      const body = await res.json();
      return Array.isArray(body) && body.map(Number).includes(userId);
    } catch (error) {
      this.logger.warn(`delegated write: membership of ${entityId} unavailable: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Կազմակերպության անդամակցությունը հիմա հնարավոր չէ ստուգել');
    }
  }
}
