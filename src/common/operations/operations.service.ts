import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { PrismaService } from 'prisma/prisma.service';

import { WarehouseActor } from '../../auth/actor';

/**
 * One write, carried out once, however many times it is asked for.
 *
 * WHY THIS IS HERE AND NOT UPSTREAM
 *
 * The assistant already refuses to repeat a write whose outcome it does not
 * know. That protects against the assistant retrying; it protects against
 * nothing else. A create is not idempotent by nature — send `POST /items`
 * twice and there are two items — and the request can commit here while its
 * answer is lost on the way back, at which point nobody upstream can tell a
 * write that landed from one that never did. A browser on a train, a proxy
 * that retries a 502, a person pressing the button again: all of them arrive
 * here, and only here can the question be settled.
 *
 * HOW
 *
 * The caller names its intent with an opaque `Idempotency-Key`. The key is
 * claimed by inserting a row with a unique index on it, BEFORE the work
 * starts, so the database — not this code — decides which concurrent attempt
 * proceeds. The work then runs inside a transaction that also flips the row to
 * SUCCEEDED, so those two facts commit together or not at all.
 *
 * That ordering buys a property worth stating plainly: **a row still saying
 * IN_FLIGHT is proof the write did not commit.** If the transaction had
 * committed, the row would say SUCCEEDED. So an attempt abandoned by a crash
 * can be safely taken over once its lease expires, rather than blocking the
 * key forever or — far worse — being replayed as though it had happened.
 *
 * WHAT A KEY IS NOT
 *
 * It is not authority. It carries no identity and grants nothing: the actor is
 * still the token holder, the workspace is still derived, and every domain
 * assertion still runs. A key only says "this is the same intent as before".
 * It is also bound to the person who claimed it, so one cannot be used to
 * replay somebody else's write back at them or to act in their name.
 */

/** How long a claimed-but-unfinished attempt holds the key. */
const LEASE_MS = 60_000;

export type OperationOutcome<T> = {
  result: T;
  /** True when this answer came from an earlier attempt rather than new work. */
  replayed: boolean;
};

@Injectable()
export class OperationsService {
  private readonly logger = new Logger(OperationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The fingerprint of a request body.
   *
   * Canonicalised first — keys sorted at every depth — so that two bodies which
   * say the same thing in a different order are the same intent, and a body
   * that says something different is not. `undefined` is dropped the way JSON
   * would drop it, so an optional field left out matches one sent as absent.
   */
  static fingerprint(route: string, body: unknown): string {
    return createHash('sha256').update(`${route}\n${canonical(body)}`).digest('hex');
  }

  /**
   * Run `work` at most once for this key.
   *
   * With no key this is a plain call — every client that predates this
   * mechanism keeps working exactly as before, which is most of them.
   *
   * `work` receives the transaction, so anything it writes commits together
   * with the record of having written it.
   */
  async runOnce<T>(
    input: {
      key: string | undefined;
      actor: WarehouseActor;
      route: string;
      body: unknown;
    },
    work: (tx: TxClient) => Promise<T>,
  ): Promise<OperationOutcome<T>> {
    if (!input.key) {
      return { result: await this.prisma.$transaction((tx) => work(tx as TxClient)), replayed: false };
    }

    const key = String(input.key).trim();
    if (!key || key.length > 200) {
      throw new ConflictException('Կրկնության բանալին անվավեր է');
    }
    const fingerprint = OperationsService.fingerprint(input.route, input.body);

    const claim = await this.claim({ key, fingerprint, actor: input.actor, route: input.route });
    if (claim.kind === 'replay') {
      this.logger.log(`replaying operation ${claim.id} for ${input.route}`);
      return { result: claim.result as T, replayed: true };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const result = await work(tx as TxClient);
        await tx.writeOperation.update({
          where: { id: claim.id },
          data: {
            status: 'SUCCEEDED',
            completedAt: new Date(),
            result: (result ?? null) as never,
            resourceId: idOf(result),
          },
        });
        return { result, replayed: false };
      });
    } catch (error) {
      /*
       * The work refused, or the transaction rolled back. Either way nothing
       * was written, so the key is released rather than left to block the
       * corrected attempt that usually follows. This is only reachable for a
       * definite failure: an answer lost in transit does not come through
       * here, and the row it leaves behind is the IN_FLIGHT case above.
       */
      await this.prisma.writeOperation
        .deleteMany({ where: { id: claim.id, status: 'IN_FLIGHT' } })
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Take the key, or find out who has it.
   *
   * Four ways this can go, and they are genuinely different answers:
   *
   *  - nobody has it            → it is ours
   *  - we have it, finished     → replay what it produced
   *  - somebody else's key      → refused, in the same words as a mismatch, so
   *                               that probing with a stolen key tells nothing
   *  - ours, still in flight    → either a second attempt racing the first, or
   *                               an abandoned one. Within the lease, refuse;
   *                               past it, take over — the IN_FLIGHT status is
   *                               proof the earlier attempt never committed.
   */
  private async claim(input: {
    key: string;
    fingerprint: string;
    actor: WarehouseActor;
    route: string;
  }): Promise<{ kind: 'claimed'; id: number } | { kind: 'replay'; id: number; result: unknown }> {
    const mine = {
      key: input.key,
      userId: input.actor.userId,
      entityId: input.actor.declared,
      route: input.route,
      fingerprint: input.fingerprint,
    };

    try {
      const row = await this.prisma.writeOperation.create({ data: mine });
      return { kind: 'claimed', id: row.id };
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }

    const existing = await this.prisma.writeOperation.findUnique({ where: { key: input.key } });
    if (!existing) {
      // Vanishingly rare: the holder released it between the insert and this
      // read. One retry, and if that loses too the caller may simply try again.
      const row = await this.prisma.writeOperation
        .create({ data: mine })
        .catch(() => null);
      if (row) return { kind: 'claimed', id: row.id };
      throw new ConflictException('Այդ հարցումն արդեն մշակվում է');
    }

    if (existing.userId !== input.actor.userId) {
      this.logger.warn(`user ${input.actor.userId} tried to redeem operation key held by ${existing.userId}`);
      throw new ConflictException('Այդ բանալին արդեն օգտագործվել է այլ գործողության համար');
    }
    if (existing.route !== input.route || existing.fingerprint !== input.fingerprint) {
      throw new ConflictException('Այդ բանալին արդեն օգտագործվել է այլ գործողության համար');
    }

    if (existing.status === 'SUCCEEDED') {
      return { kind: 'replay', id: existing.id, result: existing.result };
    }

    const age = Date.now() - existing.createdAt.getTime();
    if (age < LEASE_MS) {
      throw new ConflictException('Այդ հարցումն արդեն մշակվում է');
    }

    /*
     * Past the lease and still IN_FLIGHT. Because the status is written inside
     * the same transaction as the work, that state cannot coexist with a
     * committed write — so the earlier attempt died before committing and this
     * one may take over. The takeover is itself a conditional update, so two
     * attempts arriving at the same moment do not both win.
     */
    const taken = await this.prisma.writeOperation.updateMany({
      where: { id: existing.id, status: 'IN_FLIGHT', createdAt: existing.createdAt },
      data: { createdAt: new Date(), entityId: input.actor.declared },
    });
    if (taken.count !== 1) throw new ConflictException('Այդ հարցումն արդեն մշակվում է');
    this.logger.warn(`took over abandoned operation ${existing.id} for ${input.route}`);
    return { kind: 'claimed', id: existing.id };
  }
}

/**
 * The slice of Prisma a unit of work may use. Deliberately the transaction
 * client and not the service: work that wrote through the service would commit
 * outside the transaction, and the record of having written it could then
 * disagree with what was written.
 */
export type TxClient = Omit<
  PrismaService,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Stable JSON: object keys sorted at every depth, undefined dropped. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** The created row's id, when the work produced one, for the trail. */
function idOf(result: unknown): number | null {
  const id = (result as { id?: unknown })?.id;
  return typeof id === 'number' && Number.isInteger(id) ? id : null;
}
