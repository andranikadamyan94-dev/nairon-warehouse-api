import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import { DelegatedWriteMembership } from '../auth/delegated-write.membership';
import { ObjectsService } from '../objects/objects.service';

type HeldRow = { holderUserId?: number | null; holderObjectId?: number | null };

/**
 * Whose custody belongs to an organisation (org sweep follow-up, 2026-10-02).
 *
 * Custody rows name a holder, not an organisation. A person's row belongs to
 * the organisations HR's org tree places them in (members/internal, over the
 * internal channel); an object's row to the object's organisation in CRM's
 * catalogue. An object CRM files under no organisation, or no longer lists,
 * stays visible — as an order with no organisation does. The assets themselves
 * are the one shared warehouse and are never filtered here.
 *
 * HR or CRM unreachable is a 503: nothing is assumed either way.
 */
@Injectable()
export class HolderScope {
  constructor(
    private readonly membership: DelegatedWriteMembership,
    private readonly objects: ObjectsService,
  ) {}

  isMember(entityId: number, userId: number): Promise<boolean> {
    return this.membership.isMember(entityId, userId);
  }

  /** The object's organisation per CRM; null when it has none or CRM does not list it. */
  async objectEntity(objectId: number): Promise<number | null> {
    let row: { entityId: number | null } | undefined;
    try {
      row = await this.objects.crmObject(objectId);
    } catch {
      throw new ServiceUnavailableException('Օբյեկտների ցանկը հիմա հասանելի չէ (CRM)');
    }
    return row?.entityId ?? null;
  }

  /** Only the rows whose holder belongs to `entityId`. */
  async filter<T extends HeldRow>(rows: T[], entityId: number): Promise<T[]> {
    const people = rows.map((r) => r.holderUserId).filter((u): u is number => !!u);
    const members = people.length ? await this.membership.membersAmong(entityId, people) : new Set<number>();
    const objectIds = [...new Set(rows.filter((r) => !r.holderUserId && r.holderObjectId).map((r) => r.holderObjectId as number))];
    const objectEntity = new Map<number, number | null>();
    for (const id of objectIds) objectEntity.set(id, await this.objectEntity(id));
    return rows.filter((r) => {
      if (r.holderUserId) return members.has(r.holderUserId);
      if (r.holderObjectId) {
        const owner = objectEntity.get(r.holderObjectId) ?? null;
        return owner === null || owner === entityId;
      }
      return true;
    });
  }
}
