/**
 * The CRM object page's warehouse-backed tabs (owner's decision, 2026-10-05).
 *
 * Each tab is opened by its own right, registered in auth-api and resolved
 * like every other name (across organisations since 827039d). A right opens
 * ONLY that object's read route(s), and those routes are opened ONLY by that
 * right: not by the general warehouse rights (view_resources, manage_inventory,
 * manage_reservations, manage_warehouses, …) and not by the warehouse
 * super-permission — PermissionGuard keeps `manage_warehouse` off them. Super
 * admins pass as always. Where a tab is also where the object's responsible
 * person acts («Գույք», «Պահեստային հայտեր»), the responsible person reads it
 * too — the services ask CRM's internal card who that is.
 *
 * Nothing but the CRM object page calls these routes (the warehouse client
 * never does); writes keep their own rights.
 */
export const OBJECT_PAGE_RIGHT = {
  materials: 'view_object_materials',
  estimate: 'view_object_estimate',
  finance: 'view_object_finance',
  requests: 'view_object_requests',
  assets: 'view_object_assets',
} as const;

export const OBJECT_PAGE_RIGHTS: ReadonlySet<string> = new Set<string>(Object.values(OBJECT_PAGE_RIGHT));

/**
 * Decided without asking CRM: a super admin, or a holder of one of the tab's
 * rights. `permissionNames` is the actor's resolved list — WarehouseActor's
 * `permissionNames` or the custody module's `permissions`.
 */
export const holdsObjectRight = (permissionNames: string[], isSuperAdmin: boolean, ...rights: string[]): boolean =>
  isSuperAdmin || rights.some((r) => permissionNames.includes(r));

/** The object's responsible person as CRM's internal card names them; a card with none, or no card, is nobody. */
export const isResponsibleOf = (card: { responsibleId?: number | null } | null | undefined, userId: number): boolean =>
  card?.responsibleId != null && card.responsibleId === userId;
