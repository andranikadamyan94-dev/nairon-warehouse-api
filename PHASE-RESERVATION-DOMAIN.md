# Warehouse reservation / return domain model

The ambiguity is resolved. Two concepts, two sources of truth, two sides of
authority — and the reservation and return AI tools are still **not registered**,
because this phase ends in a readiness decision and three of the items on it are
not ready.

**Zero provider calls. $0.** Nothing here needed Astra.

---

## A · The real flow, end to end

**Who creates a reservation.** One path in the whole product: the CRM task
screen (`nairon-crm-client` → `TaskReservationModal`) posting `POST /reservations`
with `taskId`, `projectId`, `projectName`, `entityId`, `entityName`, dates and a
list of `{itemId, quantity}`. The warehouse client has a `reservationsApi.create`
and **never calls it** — its reservations page only fulfils: approve, reject,
release, reclaim, uncancel.

**What one call does.** One row per resource, and for HOUR-unit items one row
per working day slot. Availability is checked *before* the transaction; the rows
are written *inside* it. Each row lands `APPROVED` if the stock was free and
`PENDING` if it was not, and a PENDING one notifies everybody holding
`receive_reservation_alerts` or `manage_warehouse` — across every company. The
call returns `{available, unavailableResources}` and **no ids at all**.

**Who fulfils.** `approve` (consumables, optionally partial) creates an
allocation, decrements `Item.quantity`, writes an `InventoryMovement` and moves
the reservation to `ALLOCATED` or `PARTIALLY_ALLOCATED`. `allocate` does the
asset equivalent. `reject`, `cancel`, `uncancel`, `releaseAllocation`,
`reallocate` are the rest.

**Who accepts.** The task side, through `PATCH /reservations/:id/accept` —
already guarded by `assertTaskRole`, which asks CRM for the acceptor/executor/
responsible slots. Full acceptance is the only thing that sets `COMPLETED`.

**Returns.** `POST /resource-returns` with `reservationId` and a quantity;
`receive` puts consumable stock back and writes the movement, or for an asset
releases every allocation and completes the reservation; `cancel` calls it off.

**Notifications** go to the task's assignees, resolved from CRM — a reservation
records no requester of its own.

**Who later sees it.** `getMine` (via CRM's assigned tasks), `getAll` and
`getOne` behind `view_reservations`, `getTaskReservations` behind *nothing at
all*, and `GET /resource-returns?taskId=` behind nothing either.

---

## B · Requester and stock owner

| | requester | stock owner |
|---|---|---|
| means | the company whose **work** asked for the resource | the company whose **catalogue** the item is filed under |
| comes from | the CRM project the reservation was raised against | `item.category.entityId` |
| stored? | **yes**, pinned at creation | **no**, derived on the spot |
| unknown when | the project has been deleted | the item has no category |

They are not two names for one thing, and in this installation they are never
the same thing:

```
requester 3 → stock owner 1     1
requester 3 → stock owner 4     1
requester 7 → stock owner 1    31
requester 7 → stock owner 4    38
                       ------------
   cross-company               71
   same company                 0
```

Companies 3 and 7 do the work and keep **no catalogue at all**. Companies 1 and
4 own every shelf. Reading either one as "the workspace of a reservation" breaks
the product in one direction or the other.

### What the old `entityId` column was actually saying

Measured, not assumed, across all 83 rows:

| | |
|---|---|
| empty | 28 |
| agrees with the project's company | 46 |
| names the **stock owner** | 3 |
| names **neither** | 6 |

Three meanings in one column. It is kept exactly as it is — it is the history of
what callers sent — and nothing authorizes anything with it.

---

## C · Where each answer comes from

**Stock owner** — `ResourceWorkspaceService.partiesOfReservation`, along
relations the database enforces: reservation → item → category → `entityId`.
Derivable for **83 of 83** rows.

**Requester** — `RequesterWorkspaceService`, asking crm-api
`GET /projects/:id/workspace/internal` (new, and deliberately three fields: no
members, no description, nothing to browse with). Derivable for **71 of 83**.

Why stored rather than derived: it lives in another service's database, so no
query here can join to it; and it is a fact about a moment — a project that moves
company next year did not change who asked for a drill last March.

Why the other one is **not** stored: the relation already holds it, and a copy
would drift the first time a category changes company. The same argument that
kept the last phase from adding four columns.

**Creation paths and their sources:**

| path | requester from | verdict |
|---|---|---|
| `POST /reservations` from the CRM task screen | `projectId` → project | authoritative ✓ |
| `PATCH /reservations/task/:taskId` | same | authoritative ✓ |
| `POST /reservations` naming only a task | `taskId` → task → project | authoritative ✓ |
| `POST /reservations` naming neither | — | **STOPPED**: refused with a 400 |

Nothing in the product sends the last one. Guessing "the company you are acting
as" there would be exactly the caller-supplied answer this phase exists to stop
trusting.

---

## D · The authorization rules

`src/reservations/two-party.ts`. Operations are classified once, as data:

| requester's | stock owner's | either party's |
|---|---|---|
| `reservation.create` | `reservation.approve` | `reservation.cancel` |
| `reservation.update` | `reservation.allocate` | `reservation.uncancel` |
| `reservation.accept` | `reservation.reject` | `return.cancel` |
| `return.create` | `reservation.release` | |
| | `reservation.reallocate` | |
| | `return.receive` | |

The rule per side is the three-case one the rest of the warehouse uses — an actor
whose roles are not confined passes everything (that is every account here
today), a confined one must hold that side's company, and **unknown is never a
match**. An operation nobody has classified is refused rather than allowed.

Answers to §5's questions, as the code now has them:

- **May a requester reserve another company's stock?** Yes, with no approval
  step beyond the one that already exists — that is what the store is for. They
  need `view_warehouse`/`manage_reservations` and standing in the requester's
  company.
- **Is stock-owner permission required to create?** No. It is required to
  *approve*, which is where the stock actually moves.
- **Who may change quantity?** The stock owner, through approve/allocate — and
  the requester through `updateTaskReservations`, which rewrites the request.
  Which fields freeze in which state is §I.
- **May either workspace change after creation?** The requester cannot: it is
  pinned. The stock owner can, by moving the item's category — which is a
  catalogue act, guarded by the previous phase.
- **Who may initiate a return?** The requester. **Receive it?** The stock owner.
  **Cancel it?** Either.
- **What state is required to return?** Something must be out: live allocations
  greater than what has already been returned.

---

## E · Data model

One nullable column, `ResourceReservation.requesterWorkspaceId`, plus an index.
No stored stock owner. `entityId` and `entityName` untouched.

Migration `20260912192848_reservation_requester_workspace`, local only.

---

## F · Backfill

`scripts/backfill-requester-workspace.mjs` — report-only by default, `--apply`
to write, idempotent, and it never invents a value.

```
reservations                  83
can be answered from CRM      71   (cross-company 71 · same company 0)
cannot — left NULL            12
```

The twelve are reservations whose projects (14, 51, 52) have been deleted; **ten
of them are still in live states** (PENDING, APPROVED, ALLOCATED). They keep
saying NULL, they are listed by id at the end of every run, and under the rules
above they cannot be acted on from inside a company at all. That is the correct
direction to fail in, and it is a real operational item: somebody has to decide
what those ten are.

Validation runs after the write, from the database rather than from the script's
own bookkeeping, and the run fails if the two disagree.

---

## G · Read visibility

Five audiences, none of which could be dropped without breaking something:

| | reservations | returns |
|---|---|---|
| requester's people | yes | yes |
| stock owner's people | yes | yes |
| people on the task | yes (CRM decides) | yes (CRM decides) |
| warehouse staff **whose roles are not confined** | yes | yes |
| global admins | yes | yes |
| anybody else with a token | **no** | **no** |

Two surfaces were open to any authenticated caller and are not any more:

- `GET /reservations/task/:taskId` — naming a task id was enough.
- `GET /resource-returns?taskId=` — the same.

Neither gained a permission, because the CRM task screen reads both and the
people on a task hold no warehouse rights. Both gained the question they were
actually about — *are you on this task?* — answered by CRM through
`assertTaskRole`, which this service already uses for acceptance. **No new round
trip and no second rule.**

Rows are filtered individually rather than the whole request being refused: one
task can draw on several catalogues, and somebody may have standing on some of
them and not others. A caller left with nothing, and not on the task, is told the
task does not exist.

Point reads answer **404**, not 403.

---

## H · Quantity and inventory

**Fixed here.** Returns were measured against the **requested** quantity and
counted only **pending** returns. Ask for 5, be issued 2, return 5 — accepted,
and receiving it put three kilos on the shelf that had never left it. **Stock
could be invented by asking for more than you were given.**

What can come back is now what went out and has not come back yet:

```
returnable = Σ live allocations − Σ (pending + received) returns
```

measured **inside the transaction that writes the return**, so two people
pressing return at the same moment cannot both pass a check that read before it
wrote. The live run exercises both the excess and the overlap.

**Invariants as they now stand:**

- requested quantity > 0 — enforced by the DTO;
- issuing is refused beyond the outstanding remainder, and beyond stock on hand;
- returning is refused beyond what is out;
- accepted ≤ issued ≤ requested — enforced, with optimistic concurrency;
- cancelling releases live allocations and does not restore consumable stock —
  see the blockers.

**Not fixed, and reported as blockers:** availability at reservation-create is
still checked before the transaction rather than inside it (only the open-ended
case re-checks); `approveConsumable` reads stock and then decrements in a
separate statement; receiving an asset return completes the whole reservation
whatever quantity was named.

---

## I · Reservation state machine, as the code actually has it

```
            ┌─────────── create ───────────┐
            │                              │
        available                      unavailable
            ▼                              ▼
        APPROVED ─── approve/allocate ─> PENDING ─── approve ──┐
            │                              │                   │
            │                              ├─ reject ─> REJECTED (terminal)
            ▼                              ▼
   PARTIALLY_ALLOCATED <──partial── ALLOCATED ── accept(full) ─> COMPLETED
            │                              │                     (terminal)
            └────────── cancel ────────────┴─> CANCELLED ─ uncancel ─> PENDING
```

| transition | side | mutable | inventory | notifies |
|---|---|---|---|---|
| create | requester | — | none | alerts staff when PENDING |
| approve / allocate | stock owner | quantity out | **−qty**, movement OUT | requester's task assignees |
| reject | stock owner | — | none | assignees |
| cancel | either | — | releases allocations, **no stock restored** | — |
| uncancel | either | — | none | — |
| accept | requester (task role) | acceptedQuantity | none | — |
| release | stock owner | — | releases allocation | — |

`COMPLETED` and `REJECTED` are terminal; `CANCELLED` is the only reversible end.

## J · Return state machine

```
   create ──> PENDING ──receive──> RECEIVED (terminal)
                  │
                  └───cancel────> CANCELLED (terminal)
```

| transition | side | inventory |
|---|---|---|
| create | requester | none — nothing moves until it is received |
| receive (consumable) | stock owner | **+qty**, movement IN, reservation quantity reduced |
| receive (asset) | stock owner | releases every allocation, reservation → COMPLETED |
| cancel | either | none |

**Defect, not fixed:** `receive` reduces `ResourceReservation.quantity`, which is
the *requested* amount — recording a physical event by rewriting the request.
Fixing it means separating requested from outstanding, which changes what every
screen reads, and belongs to its own phase.

---

## K · Idempotency

| operation | idempotent | mechanism |
|---|---|---|
| `reservation.create` | **no** — one call makes N rows | `WriteOperation`, wired |
| `reservation.update` | yes — desired state | none needed |
| `return.create` | **no** — quantity accumulates | `WriteOperation`, wired |
| `return.receive` | yes — refused from any other state | none needed |
| `reservation.approve` | **no** — issues again each time | not wired; see blockers |

Both creates now go through the durable mechanism built in Warehouse W1: opaque
`Idempotency-Key`, actor-bound, route-bound, payload-fingerprinted, claim
inserted before the work and flipped to SUCCEEDED inside the same transaction.
Nothing AI-specific. Its 21 live checks still pass with the new wiring.

---

## L · CRM compatibility

Nothing the CRM client sends has to change. It already sends `projectId` and
`taskId` on every reservation, which is precisely what the new derivation reads;
`entityId` keeps being accepted and keeps being stored as the label it always
was.

What *is* new for CRM: a reservation with neither a project nor a task is now a
400. No CRM path sends one.

The only cross-service addition is `GET /projects/:id/workspace/internal` in
crm-api, replacing a pull of every project in the installation to read one
integer.

---

## M · Warehouse client workspace wiring — **report and stop**

The client does hold a workspace: `main.tsx` writes `localStorage.warehouse_entity`
from the SSO fragment and `entity.slice.ts` reads it into the store at boot. So
wiring `selectEntityId` into the axios interceptor would genuinely start sending
`x-entity-id`.

It is **not safe to do now**, for a specific reason. `WarehouseActorService`
refuses — 403, deliberately, not silently — a declared workspace the actor holds
no role in. The stored value is written once at SSO and never revalidated. A
person who leaves a company, or whose SSO handed over a stale id, would have
**every warehouse request refused** until they cleared their browser storage.
That is a worse failure than the gap it closes.

Two ways forward, both product decisions rather than guesses:

1. the client clears its stored workspace and retries once when a request is
   refused for it; or
2. an unheld declaration is treated as "declared nothing" for reads and refused
   only for writes.

Neither is in this phase. Nothing was changed in the client.

---

## N · Open read surfaces

| route | class | done |
|---|---|---|
| `GET /reservations/task/:taskId` | **C — leaked** | fixed: task role, then per-row |
| `GET /resource-returns?taskId=` | **C — leaked** | fixed: task role, then per-row |
| `GET /items` | A — intentionally broad, row-scoped | unchanged; the CRM task screen needs it |
| `GET /categories` | A | unchanged, same reason |
| `POST /availability/check` | A | unchanged; answers about stock, not about anyone |
| `GET /users` | **B** | **not fixed** — a plain directory pull with no guard |
| `GET /responsibilities/user/:userId` | **B** | **not fixed** — no guard |

The two B rows have no authoritative rule to reuse: what a warehouse caller may
know about the staff directory is a product question, not a bug with an obvious
fix. Adding a permission to make an audit green is exactly what §15 says not to
do.

---

## O · Tests

`src/reservations/two-party.spec.ts` — **27 tests**: both sides in and out of
scope; both companies held by one person; a third company held by neither; an
unbounded actor refused nothing; unknown never a match; same-company as the
ordinary case; every operation's side; either-party operations from both sides
and refused from a third; an unclassified operation refused; the cross-company
flow that must keep working; and all five read audiences including the one that
must not be an audience.

**Suites: warehouse-api 76 / 5 · crm-api 455 / 19**, all green.

## P · Live cross-company acceptance

`scripts/two-party-e2e.mjs` — **27 checks, 27 passed**. Three people who exist
nowhere else: a planner with a role only in company 7, a storekeeper with a role
only in company 1, and a stranger with a role only in company 3. One reservation,
carried the whole way.

- the planner asks across the company line — and the requester written down is
  the project's company, not the body's;
- naming another company in the body does not make you it;
- a reservation attached to no work at all is refused;
- the planner cannot approve stock out of a store that is not theirs, and no
  stock moves;
- the stranger can do neither side, and cannot even see it — 404, not 403;
- the storekeeper approves; ten kilos leave the shelf; the reservation says
  ALLOCATED;
- the stranger cannot hand back what it never had;
- **nobody can hand back more than went out** — the way stock used to be
  inventable — and a second return cannot exceed what is still out;
- the planner cannot put stock back on somebody else's shelf; the storekeeper
  receives it and four kilos are back;
- both companies can see it, the person on the task can see it, naming a task id
  is no longer enough;
- and the ledger reads `OUT:-10 IN:4`.

Two of these failed on the first run and found a real defect: a warehouse
permission was letting a company-scoped storekeeper read another company's task,
because two call sites asked `isWarehouseViewer` without the "roles not confined"
condition the rule itself carries. Fixed by filtering per row.

## Q · Provider usage

**0 calls, $0.**

## R · Commits, local only

- `nairon-crm-api` `a45a0a9` — the internal project-workspace route.
- `nairon-warehouse-api` `def790a` — the domain model, the migration, the
  backfill, the read fixes, the return invariant, 27 tests and 27 live checks.

Nothing pushed, merged, staged or deployed. No AI tool was registered.

## S · Readiness

| capability | product semantics | workspace-safe | inventory-safe | idempotency-ready | preflight-ready | verdict |
|---|---|---|---|---|---|---|
| `warehouse.reservations.create` | **yes** | **yes** | **no** | yes | **no** | **NOT READY** |
| `warehouse.reservations.update` | **yes** | **yes** | **no** | n/a (desired state) | **no** | **NOT READY** |
| `warehouse.returns.create` | **yes** | **yes** | **yes** | yes | **no** | **NOT READY — closest** |

The ambiguity that blocked all three is gone. What blocks them now is smaller,
concrete, and listed below.

## T · Exact blockers before Warehouse AI Writes W2

1. **No preflight routes exist** for reservations or returns. Every accepted AI
   write in the estate has `POST <resource>/preflight/<action>` calling the same
   assert the mutation calls. These have the asserts and not the routes.
2. **`POST /reservations` returns no ids.** It answers
   `{available, unavailableResources}`. A confirmation card cannot say what it
   made, a replay cannot show what was made, and an AI result cannot cite it.
   The route has to return what it created.
3. **One call, many rows.** A single request creates a row per resource and, for
   HOUR items, per working day. Both the preview and the confirmation contract
   assume one act; this needs a shape somebody can agree to.
4. **Availability is not enforced transactionally** at create, and
   `approveConsumable` reads stock then decrements in a separate statement. Two
   requests can both pass. §10 forbids relying on PREPARE-time availability.
5. **`receive` rewrites the requested quantity** to record a physical event.
   Requested and outstanding need separating before anything automated reasons
   about either.
6. **Cancelling does not restore consumable stock** that was already issued —
   defensible, undocumented, and not something to expose while it is unclear.
7. **Ten live reservations have no requester** and cannot be acted on from inside
   a company. Somebody has to decide what they are.
8. **Asset returns complete the whole reservation** regardless of the quantity
   named.
9. **The client workspace wiring** (§M) is still open, so the narrowing this
   model enables is available and unused.
