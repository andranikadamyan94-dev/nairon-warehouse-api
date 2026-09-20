import { ForbiddenException, Injectable } from '@nestjs/common';

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
  constructor(private readonly usersPrisma: UsersPrismaService) {}

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

    const home = await this.usersPrisma.getUserWorkspaces(userId);
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
