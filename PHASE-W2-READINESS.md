# Warehouse W2 readiness hardening

Two of the three candidates are **READY_FOR_W2**; one is
**READY_WITH_LIMITATION**. No AI tool was registered, and the capability counts
are unchanged. **Zero provider calls, $0.**

---

## A · Blocker classification

The nine gaps from the previous phase, classified by what they actually block:

| # | gap | class | done |
|---|---|---|---|
| 1 | no preflight routes | **A — BLOCKS W2** | ✅ three added |
| 2 | `POST /reservations` returns no ids | **A** | ✅ returns `created[]` |
| 3 | one call, many rows | **A** | ✅ modelled as one request; §D |
| 4 | availability not transactional | **A** | ✅ row locks; §C |
| 5 | `receive` rewrites requested quantity | **A** | ✅ frozen; §B |
| 6 | cancel does not restore issued stock | **B — does not block these three** | documented; §J |
| 7 | 12 legacy rows with no requester | **D — manual remediation** | ✅ bounded report; §K |
| 8 | asset returns complete everything | **A for returns** | ✅ refused; §I |
| 9 | client stale workspace | **C — production/pilot** | tracked, untouched; §T |

Verified rather than assumed: 6 was checked against `cancel`, which releases
allocations without restocking — real, and not reachable from the three tools,
since none of them cancels. 9 was checked against ai-api, which sends its own
`x-entity-id` and never reads the client's storage.

## B · Requested / issued / returned / outstanding

`src/reservations/quantities.ts`. One measurement, four numbers:

```
requested   ResourceReservation.quantity — frozen, never a counter
out         Σ live allocations — what is physically in the requester's hands
returned    Σ received returns — immutable rows
issued      out + returned — everything that ever left the shelf
```

and two derived answers: `outstandingToIssue = requested − issued` (what
approval may still hand out) and `returnable = out − pending returns` (what may
still be handed back).

**Receiving a return no longer touches `quantity`.** It reduces the allocation —
what is out — and completes the reservation when nothing is out any more,
measured from the allocations rather than from a counter. No new stored column:
the ledger answers it.

**A bug in the previous phase, found by this:** `returnable` subtracted received
returns *as well as* pending ones, but receiving one already reduces the
allocation it came from. Six genuinely still out read as two returnable. The
live run had never received-then-returned-again; it does now.

**Not derivable, and said out loud:** releasing an allocation without a return —
what cancelling does — reduces `out` and adds nothing to `returned`, so `issued`
falls for goods that did leave the shelf. A release records no reason a query can
read. Recorded as a gap rather than covered with a fifth number.

## C · Transactional inventory

Three different shapes, three different smallest-correct answers:

| what | design | why |
|---|---|---|
| stock decrement on approve | conditional `updateMany` with `quantity: { gte: n }`, affected-row count checked | one counter; the WHERE clause carries the invariant |
| availability at reservation-create | `SELECT … FOR UPDATE` on the item, then measure | an aggregate over other tables — no single row's WHERE can carry it |
| returnable at return-create | `SELECT … FOR UPDATE` on the reservation, then measure | same |

**The lesson worth writing down:** moving a check inside a transaction feels like
it fixes a race and does not. Under READ COMMITTED two transactions each see the
world without the other's uncommitted rows, so both say yes. The live run caught
this twice — two requests for the last three units both accepted, two people
handing back the same six both filing — *after* the checks had been moved
inside transactions. Only a lock somebody has to wait for serialises them.

Locks are always taken before measuring and always in the same order (item, then
reservation) so two callers cannot each hold what the other waits for. No
SERIALIZABLE, no retry loop, no process memory, no JS mutex.

## D · One request, many rows

The domain was **not** distorted into one row per confirmation. A *reservation
request* is one business act that produces a row per resource and, for hourly
items, a row per working day. The preflight describes the act:

```
requesterWorkspaceId, task, project, dates
lines[]:  item, quantity, unit, type,
          rows            ← how many rows this line becomes
          stockOwnerWorkspaceId, stockOwnerName
          freeNow         ← informational
rowsToCreate, needsFulfilment, availabilityIsInformational: true
```

A person agrees to one request; the mutation atomically creates all of it.

## E · Create response

`POST /reservations` now answers `{available, unavailableResources, created[]}`
where each entry is `{id, itemId, itemName, unit, quantity, startDate, endDate,
status, requesterWorkspaceId, stockOwnerWorkspaceId}`.

Bounded on purpose: identifiers, both companies, what was asked, where it
stands. Not the item's row, not the project, not the history — anything else can
be asked for by id, which is what having the id is for. An idempotent replay
returns the identical set.

## F · Preflights

| route | answers |
|---|---|
| `POST /reservations/preflight/create` | `{ok, request: ReservationRequestPreview}` |
| `POST /reservations/preflight/task/:taskId` | `{ok, request: ReservationUpdatePreview}` |
| `POST /resource-returns/preflight/create` | `{ok, request: ReturnPreview}` |

Same guards, same authority, same measurements, nothing written, nobody
notified. Unlike the estate's other preflights these answer more than `{ok:true}`
— one request becomes several rows and a person cannot agree to "a reservation"
without being told which. Each carries an explicit
`availabilityIsInformational` / `outstandingIsInformational` flag: the figure is
true when read and binding only inside the transaction that writes.

No two-party rule is duplicated in ai-api; there is nothing there yet to
duplicate it in.

## G · Reservation update

Audited: `updateTaskReservations` is **already desired-state**. The caller sends
the whole set of resources a task should have; rows for removed items are
cancelled with their allocations released, kept rows are adjusted, new ones
created. It already refuses to reduce a consumable below what has been handed
over — the goods are with the requester and stock has moved.

Fixed here: **rows the update path created carried no requester at all.** It
derives one now, exactly as create does, and never rewrites an existing row's —
`requesterWorkspaceId` is immutable once set.

The preview reports per resource: `before`, `after`, `alreadyOut`,
`added|removed|changed|unchanged`, and `cannotGoBelowIssued` when the ask was
floored to what is already out. `noChange` when nothing would move, so no card
is drawn for a change that is not one.

## H · Return semantics

Invariant kept and now genuinely enforced: `returnable = out − pending`,
measured inside the transaction that writes, behind a row lock. Partial returns,
repeated partial returns and concurrent overlapping returns are all exercised
live.

## I · Asset returns — **STOPPED, consumables only**

Audited, and the model is clearer than expected: `ReservationAllocation.assetId`
names the exact physical unit, one row per asset. So the *product* can identify
which machine is out.

What it cannot do is record which one is coming **back**. `ResourceReturn` holds
a `reservationId` and a number and has nowhere to name an allocation, and
`receive` therefore releases every allocation and completes the whole
reservation whatever quantity was named.

Per §11 that is where to stop rather than guess. An asset return is now refused
by the domain with a reason a person can act on. The human route is unchanged.
Making it work means `ResourceReturn` naming allocations — a migration plus a
client contract, and its own phase.

## J · Cancellation

Not exposed, not expanded, and checked for damage to the invariants the three
tools rely on:

- `cancel` releases live allocations and **does not restock consumables**. For
  goods already handed over that is right — they did not come back — but the
  ledger cannot tell that release apart from a return-driven one, so `issued`
  falls for them. It does not corrupt create, update or return, because none of
  them reads `issued` across a cancellation boundary.
- The distinction §12 asks about — "cancel the unfulfilled remainder" versus
  "cancel everything" — is **not** represented today. Recorded as deferred; it
  does not block the three.

## K · Legacy remediation

`scripts/legacy-reservations-report.mjs` — read-only, bounded, no names, no
notes, nothing about anybody:

```
reservations with no requester   12
  still live                     10
  with stock still out            3
```

Three rows still hold stock, including 550 units of aluminium cable on a
reservation from project 14. Each row prints id, item, status, project, task,
stock owner, requested, still out, and the date. Until a product owner decides
whose work each was, every one is refused to any company-scoped actor — the safe
direction, and it does not block correctly-scoped new reservations.

## L · Idempotency

| operation | classification | mechanism |
|---|---|---|
| `reservation.create` | non-idempotent — N rows per call | `WriteOperation`, one key for the whole set |
| `reservation.update` | desired state | confirmation-once; retry-safe by construction |
| `return.create` | non-idempotent — quantity accumulates | `WriteOperation` |

Proven live: a lost answer retried returns the **same ids** and makes no more
rows; ten simultaneous attempts on one key make one set; the same key with a
changed request is a 409; a retried return gives back the same return row rather
than another four units. Process-restart safety is unchanged from W1 — an
IN_FLIGHT claim is proof the write did not commit — and its 21 checks still pass.

## M · Read coverage

| Astra must resolve | by |
|---|---|
| project / task | crm reads, already accepted |
| reservation | `warehouse.reservations.list` / `.get` / `.list_mine` |
| item | `warehouse.items.list` (free text over name and code) |
| requester | `requesterWorkspaceId`, on the row |
| stock owner | now on `getOne` as `stockOwnerWorkspaceId` |
| outstanding quantity | now on `getOne` as `quantities` |
| existing returns | `warehouse.returns.list`, and now on `getOne` |

One real gap existed — outstanding quantity was arithmetic over allocation rows
that nothing exposed — and it was closed by **enriching the existing point read**
rather than adding a capability. No new read tool was registered.

## N · Deterministic tests

`src/reservations/quantities.spec.ts` — **11 tests** on the four numbers: a
fresh request, fully and partly issued, the request surviving a return, a return
not restoring the right to re-issue, the double-subtraction bug, pending holds,
both at once, never negative, and a missing reservation.

`src/reservations/two-party.spec.ts` — **27 tests**, unchanged and still green.

**Suites: warehouse-api 87 / 6 · crm-api 455 / 19 · ai-api 2,904 / 64.**

## O · Live acceptance

`scripts/w2-readiness-e2e.mjs` — **24 checks, 24 passed**, three companies: A
requests, B owns the shelves, C is party to neither.

Preflight answers and writes nothing, names who asks and how many rows the
request becomes, says its availability is not a promise, and refuses C exactly
as the mutation would. The request returns its rows; a lost answer replays the
same ids; a changed body on the same key is a conflict; ten simultaneous
attempts make one set. **Two requests for the last three units: one accepted.**
The asker cannot issue to themselves; two simultaneous issues of the same
reservation: one succeeds, shelf goes 100 → 90. The return preflight reports
`out` and `requested`; four are handed back; a retry returns the same row; the
shelf reaches 94 **and the request still says ten**; six are still out and six
still returnable; seven refused; **two people handing back the same six: one
filed, one refused.** An asset return is refused with a reason.

Plus `two-party-e2e` 27/27 and `idempotency-e2e` 21/21, both still green.

Cleanup by exact id, verified zero across actors, items, projects and operations.

## P · Provider usage

**0 calls, $0.**

## Q · Commits, local only

`nairon-warehouse-api` `b4e7783`. Nothing pushed, merged, staged or deployed.
ai-api and crm-api untouched this phase.

## R · Readiness

| capability | product semantics | authority | transactional inventory | result shape | idempotency | preflight | read-resolution | verdict |
|---|---|---|---|---|---|---|---|---|
| `warehouse.reservations.create` | ✅ | ✅ two-party | ✅ lock + measure | ✅ `created[]` | ✅ one key, one set | ✅ | ✅ | **READY_FOR_W2** |
| `warehouse.reservations.update` | ✅ desired-state | ✅ requester-side | ✅ inherits create's | ✅ preview before→after | ✅ desired-state | ✅ | ✅ | **READY_FOR_W2** |
| `warehouse.returns.create` | ✅ | ✅ requester-side | ✅ lock + measure | ✅ the return row | ✅ | ✅ | ✅ | **READY_WITH_LIMITATION** — consumables only |

Not registered. That is a separate decision.

## S · Remaining blockers before W2

Nothing blocks the two READY rows. For the third:

1. **Asset returns stay out** until `ResourceReturn` can name the allocation
   being handed back (§I). The AI tool must declare consumables-only in its
   description and refuse assets before the card, mirroring the domain.

And two things the W2 phase itself will have to do, which are tool work rather
than domain work:

2. The preview contract in ai-api renders `rows[]` and `changes[]`. A multi-line
   reservation request needs a card shape somebody can read — probably one row
   per resource plus a total — decided when the tool is written.
3. `reservations.update` takes the **whole** resource set. A person saying "add
   five bags of cement" means a set they did not enumerate, so the tool has to
   read the current set, apply the change and show before→after. The preview
   already answers in that shape.

## T · Deferred, Production / Pilot

- **Warehouse client workspace hardening** — a stale `localStorage` workspace
  would be refused with 403 on every request. Untouched, tracked separately, and
  it does not affect ai-api, which sends its own header.
- **`GET /users`, `GET /responsibilities/user/:userId`** — no guard, no
  authoritative visibility rule to reuse, and needed by none of the three tools.
  Production/privacy hardening. No guard was invented.
- **Cancel semantics** — "cancel the remainder" versus "cancel everything", and
  the fact that a release is indistinguishable from a return in the ledger.
- **Ten legacy reservations** awaiting a product owner (§K).
- **`receive` on an asset** completing the whole reservation — the human route's
  behaviour, unchanged and now written down.
