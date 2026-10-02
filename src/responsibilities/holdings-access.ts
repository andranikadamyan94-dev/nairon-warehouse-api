import { WarehouseActor } from '../auth/actor';

/**
 * Who may read what one person holds (GET /responsibilities/user/:userId).
 *
 * The route had no check at all (org sweep 2026-10-02): any signed-in person
 * read anyone's custody — which assets, with serial numbers. Now:
 *
 *   - your own is always yours to read;
 *   - somebody else's needs a responsibility / asset-custody right in the
 *     organisation you are acting in (X-Entity-ID; the actor's permissions are
 *     resolved there), and that person must belong to it — HR's org tree
 *     answers, over the internal channel, as for a delegated write.
 *
 * No organisation declared means there is nothing to hold the colleague to, so
 * somebody else's is refused. Nothing in the product reads it without one:
 * the warehouse client never calls this route, and the assistant always sends
 * the selected organisation.
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
  /** Allowed if HR places `userId` in `entityId`. */
  | { kind: 'if-member'; entityId: number; userId: number }
  | { kind: 'refused'; because: 'no-organisation' | 'no-right' };

export function decideHoldingsRead(actor: WarehouseActor, userId: number): HoldingsVerdict {
  if (userId === actor.userId) return { kind: 'own' };
  if (actor.declared === null) return { kind: 'refused', because: 'no-organisation' };
  const hasRight = actor.isSuperAdmin || HOLDINGS_READ_PERMISSIONS.some((p) => actor.permissionNames.includes(p));
  if (!hasRight) return { kind: 'refused', because: 'no-right' };
  return { kind: 'if-member', entityId: actor.declared, userId };
}
