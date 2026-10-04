import { WarehouseActor } from '../auth/actor';

/**
 * Who may read what one person holds (GET /responsibilities/user/:userId).
 *
 * The route had no check at all before 2026-10-02: any signed-in person read
 * anyone's custody — which assets, with serial numbers. Now:
 *
 *   - your own is always yours to read;
 *   - somebody else's needs a responsibility / asset-custody right.
 *
 * The warehouse is global (owner decision 2026-10-05): the organisation acted
 * in (X-Entity-ID) plays no part here — the person is not looked up in HR's
 * org tree, and no organisation has to be declared. The actor's permissions
 * are whatever the guard resolved (in the declared organisation when one was
 * sent, across every assignment otherwise).
 */
export const HOLDINGS_READ_PERMISSIONS = [
  'view_responsibilities',
  'manage_responsibilities',
  // The custody register's rights — the responsibilities page opens for them too.
  'view_asset_custody',
  'issue_assets',
  'approve_asset_requests',
  // The warehouse super-permission (PermissionGuard).
  'manage_warehouse',
];

export type HoldingsVerdict =
  | { kind: 'own' }
  | { kind: 'allowed' }
  | { kind: 'refused'; because: 'no-right' };

export function decideHoldingsRead(actor: WarehouseActor, userId: number): HoldingsVerdict {
  if (userId === actor.userId) return { kind: 'own' };
  const hasRight = actor.isSuperAdmin || HOLDINGS_READ_PERMISSIONS.some((p) => actor.permissionNames.includes(p));
  return hasRight ? { kind: 'allowed' } : { kind: 'refused', because: 'no-right' };
}
