import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PermissionGuard, PERMISSIONS_KEY } from './guards/permission.guard';
import { ReservationsController } from '../reservations/reservations.controller';
import { ResourceReturnsController } from '../resource-returns/resource-returns.controller';
import { ProcurementController } from '../procurement/procurement.controller';
import { MaintenanceController } from '../maintenance/maintenance.controller';
import { AssetsController } from '../assets/assets.controller';

/**
 * A viewing permission must not open a route that changes anything.
 *
 * `@Permissions` is ANY-OF. That is right for a read — `view_assets` OR
 * `manage_assets` both mean "may look at assets", and a manager who was never
 * given a separate view grant should not be locked out of the screen they
 * manage. It is wrong for a write, because it makes the weakest of the listed
 * permissions the real requirement.
 *
 * Seven sites paired `view_warehouse` with a manage right on routes that
 * reserve stock, rewrite a task's resources, file returns and cancel them. The
 * two-party rule in the services was meant to be the real authority, but
 * `decideSide` states that an actor unbounded by their roles passes both sides
 * and that this is every account in the installation — so those routes were
 * gated by a viewing permission and nothing else.
 *
 * This reads the metadata off the real controllers, so it fails if somebody
 * puts a view permission back on a mutation.
 */

const permissionsOf = (controller: object, method: string): string[] =>
  Reflect.getMetadata(PERMISSIONS_KEY, (controller as never)[method]) ?? [];

/** Everything that reads as a view grant rather than an authority to change. */
const VIEWING = /^view_/;

function guardWith(permissionNames: string[], isSuperAdmin = false) {
  const reflector = { getAllAndOverride: (_k: string, [handler]: unknown[]) => handler } as unknown as Reflector;
  const guard = new PermissionGuard(reflector, {
    resolve: async () => ({ isSuperAdmin, permissionNames }),
  } as never);
  return (required: string[]) =>
    guard.canActivate({
      getHandler: () => required,
      getClass: () => required,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 1 } }) }),
    } as never);
}

describe('warehouse write routes · no mutation behind a viewing permission', () => {
  const mutations: [string, object, string][] = [
    ['POST /reservations', ReservationsController.prototype, 'create'],
    ['PATCH /reservations/task/:taskId', ReservationsController.prototype, 'updateTaskReservations'],
    ['POST /resource-returns', ResourceReturnsController.prototype, 'create'],
    ['PATCH /resource-returns/:id/receive', ResourceReturnsController.prototype, 'receive'],
    ['PATCH /resource-returns/:id/cancel', ResourceReturnsController.prototype, 'cancel'],
    ['POST /reservations/allocate', ReservationsController.prototype, 'allocate'],
    ['POST /reservations/reallocate', ReservationsController.prototype, 'reallocate'],
    ['PATCH /reservations/:id/approve', ReservationsController.prototype, 'approveConsumable'],
    ['PATCH /reservations/:id/reject', ReservationsController.prototype, 'reject'],
    ['POST /procurement/:id/finalize', ProcurementController.prototype, 'finalize'],
    ['POST /procurement/:id/resubmit', ProcurementController.prototype, 'resubmit'],
    ['POST /maintenance/:id/finalize', MaintenanceController.prototype, 'finalize'],
    ['PATCH /assets/:id', AssetsController.prototype, 'update'],
  ];

  it.each(mutations)('%s requires no viewing permission', (_route, controller, method) => {
    const required = permissionsOf(controller, method);
    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((p) => VIEWING.test(p))).toEqual([]);
  });

  it.each([
    ['POST /reservations', ReservationsController.prototype, 'create'],
    ['PATCH /reservations/task/:taskId', ReservationsController.prototype, 'updateTaskReservations'],
  ])('%s requires manage_reservations exactly', (_route, controller, method) => {
    expect(permissionsOf(controller, method)).toEqual(['manage_reservations']);
  });

  it.each([
    ['POST /resource-returns', ResourceReturnsController.prototype, 'create'],
    ['PATCH /resource-returns/:id/cancel', ResourceReturnsController.prototype, 'cancel'],
  ])('%s requires manage_resource_returns exactly', (_route, controller, method) => {
    expect(permissionsOf(controller, method)).toEqual(['manage_resource_returns']);
  });

  /**
   * A preflight answers "would this be accepted, and what would it do". Its own
   * docblock promises "same guards, same authority, nothing written" — so it
   * must not be reachable by somebody who could not perform the thing it
   * previews.
   */
  it.each([
    ['reservations preflight/create', ReservationsController.prototype, 'preflightCreate', 'create'],
    ['reservations preflight/task', ReservationsController.prototype, 'preflightUpdate', 'updateTaskReservations'],
    ['returns preflight/create', ResourceReturnsController.prototype, 'preflightCreate', 'create'],
  ])('%s asks for the same permission as the mutation it previews', (_label, controller, preview, mutation) => {
    expect(permissionsOf(controller, preview)).toEqual(permissionsOf(controller, mutation));
  });
});

describe('warehouse read routes · ANY-OF is still allowed there', () => {
  it.each([
    ['GET /reservations', ReservationsController.prototype, 'getAll'],
    ['GET /reservations/:id', ReservationsController.prototype, 'getOne'],
    ['GET /assets', AssetsController.prototype, 'findAll'],
    ['GET /maintenance', MaintenanceController.prototype, 'getAll'],
    ['GET /procurement', ProcurementController.prototype, 'findAll'],
  ])('%s accepts a view grant or the matching manage grant', (_route, controller, method) => {
    const required = permissionsOf(controller, method);
    // Deliberately unchanged: a manager given no separate view grant must not
    // be locked out of the screen they manage.
    expect(required.some((p) => VIEWING.test(p))).toBe(true);
    expect(required.some((p) => p.startsWith('manage_'))).toBe(true);
  });
});

describe('the guard itself, on a reservation mutation', () => {
  const REQUIRED = ['manage_reservations'];

  it('denies a view-only warehouse actor', async () => {
    // The developer / technical lead / director shape: view_warehouse and
    // nothing that manages.
    await expect(guardWith(['view_warehouse', 'view_reservations'])(REQUIRED)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('denies an actor with no warehouse permissions at all', async () => {
    await expect(guardWith([])(REQUIRED)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows the manage grant', async () => {
    await expect(guardWith(['manage_reservations'])(REQUIRED)).resolves.toBe(true);
  });

  it('allows manage_warehouse, which is the warehouse super-permission', async () => {
    // Removing view_warehouse must not lock out a warehouse manager who was
    // never given the narrower grant.
    await expect(guardWith(['manage_warehouse'])(REQUIRED)).resolves.toBe(true);
  });

  it('allows a super admin', async () => {
    await expect(guardWith([], true)(REQUIRED)).resolves.toBe(true);
  });

  it('does not let manage_warehouse open a procurement-only route', async () => {
    // The 2026-09-01 split, still holding.
    await expect(guardWith(['manage_warehouse'])(['manage_procurement'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
