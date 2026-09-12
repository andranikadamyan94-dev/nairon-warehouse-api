import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WarehouseActor } from '../actor';
import { WarehouseActorService } from '../actor.service';

export const PERMISSIONS_KEY = 'permissions';
export const Permissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Procurement is its own domain of responsibility (2026-09-01 split): the
 * warehouse super-permission deliberately does NOT satisfy routes that only
 * procurement rights may open. Everything else it still covers.
 */
const PROCUREMENT_ONLY = new Set(['view_procurement', 'manage_procurement']);

/**
 * Route-level permission check. Relies on the global AuthGuard having set
 * request.user and request.actor. `manage_warehouse` acts as the warehouse
 * super-permission and satisfies any requirement — except procurement-only
 * routes (see above).
 *
 * The permissions it tests are the actor's, resolved in the workspace the
 * caller declared. Before Warehouse Domain Hardening they were resolved with no
 * workspace at all, which in this service's query means every assignment in
 * every company counts — so a person made warehouse manager of one company
 * passed this guard for all of them. A caller that declares nothing still gets
 * that union, because no warehouse client sends a workspace yet and taking it
 * away would lock working people out; a caller that declares one is held to it.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private actors: WarehouseActorService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest();
    if (!request.user) throw new ForbiddenException('Access denied');
    // Normally already resolved by AuthGuard; resolved here too so that this
    // guard is still correct if it is ever mounted somewhere AuthGuard is not.
    const actor: WarehouseActor = request.actor ?? (await this.actors.resolve(request));
    request.actor = actor;
    const { isSuperAdmin, permissionNames } = actor;
    // Handlers with creator-or-admin rules (e.g. procurement cancel) read this.
    request.isSuperAdmin = isSuperAdmin;
    if (isSuperAdmin) return true;
    const procurementOnly = required.every((p) => PROCUREMENT_ONLY.has(p));
    if (!procurementOnly && permissionNames.includes('manage_warehouse')) return true;

    if (!required.some((p) => permissionNames.includes(p))) {
      throw new ForbiddenException('Insufficient warehouse permissions');
    }
    return true;
  }
}
