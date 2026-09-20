import { ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { UsersPrismaService } from '../common/users-prisma.service';
import { WarehouseActor, mayDeclare, readDeclaredWorkspace } from './actor';

/** Where the resolved actor is parked so one request costs one resolution. */
const CACHE = Symbol('warehouseActor');

type RequestLike = {
  user?: { id?: number | string };
  headers?: Record<string, unknown>;
  [CACHE]?: Promise<WarehouseActor>;
};

/**
 * Builds the trusted actor for a request.
 *
 * Everything here comes from the token's subject and the users database. The
 * only thing the caller contributes is `x-entity-id`, and it is a request, not
 * a fact: it is checked against the person's own assignments before it is
 * allowed to mean anything, and a claim that fails is refused rather than
 * silently dropped — somebody asking to act as a company they have no role in
 * has made a mistake worth hearing about, and if it was not a mistake then a
 * silent downgrade to "everything you can do anywhere" is the worst possible
 * answer.
 *
 * Resolved once per request, in AuthGuard, so the rest of the service can read
 * `request.actor` without paying for it again.
 */
@Injectable()
export class WarehouseActorService {
  private readonly logger = new Logger(WarehouseActorService.name);
  /** HR's answer per person, briefly — it is asked on every request. */
  private readonly homes = new Map<number, { ids: number[]; at: number }>();
  private static readonly FRESH_MS = 30_000;

  constructor(private readonly usersPrisma: UsersPrismaService) {}

  /**
   * The organizations HR says this person may act in: the units they belong
   * to or head, and the scopes of their roles. HR is the owner of that fact;
   * the roles table here is only the floor, so that a brief HR outage
   * narrows nobody below what their roles already grant.
   */
  private async fromHr(userId: number, authorization: unknown): Promise<number[]> {
    if (typeof authorization !== 'string' || !authorization) return [];
    const cached = this.homes.get(userId);
    if (cached && Date.now() - cached.at < WarehouseActorService.FRESH_MS) return cached.ids;
    const hrUrl = process.env.HR_SERVICE_URL || 'http://localhost:3001';
    try {
      const res = await fetch(`${hrUrl}/api/entities`, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HR ${res.status}`);
      const body = (await res.json()) as { id?: unknown }[];
      const ids = (Array.isArray(body) ? body : [])
        .map((e) => Number(e?.id))
        .filter((id) => Number.isInteger(id) && id > 0);
      this.homes.set(userId, { ids, at: Date.now() });
      return ids;
    } catch (e) {
      this.logger.warn(`HR membership lookup for user ${userId} failed: ${(e as Error)?.message}`);
      return cached?.ids ?? [];
    }
  }

  /** Memoised per request; the promise is cached so parallel guards share one query. */
  resolve(request: RequestLike): Promise<WarehouseActor> {
    if (!request[CACHE]) request[CACHE] = this.build(request);
    return request[CACHE];
  }

  private async build(request: RequestLike): Promise<WarehouseActor> {
    const userId = Number(request.user?.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new ForbiddenException('Access denied');
    }

    const roles = await this.usersPrisma.getUserWorkspaces(userId);
    const member = roles.wildcard ? [] : await this.fromHr(userId, request.headers?.['authorization']);
    const home = {
      wildcard: roles.wildcard,
      entityIds: [...new Set([...roles.entityIds, ...member])].sort((x, y) => x - y),
    };
    const asked = readDeclaredWorkspace(request.headers?.['x-entity-id']);

    if (asked !== null && !mayDeclare(home, asked)) {
      // Deliberately the same shape as any other refusal: it says the claim was
      // rejected, not which workspaces exist or which ones this person holds.
      throw new ForbiddenException('Դուք նշված կազմակերպությունում դեր չունեք');
    }

    const { isSuperAdmin, isGlobalSuperAdmin, permissionNames } =
      await this.usersPrisma.getUserAccessInfo(userId, asked ?? 0);

    return { userId, isSuperAdmin, isGlobalSuperAdmin, permissionNames, home, declared: asked };
  }
}
