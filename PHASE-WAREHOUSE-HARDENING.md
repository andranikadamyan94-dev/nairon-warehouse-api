# Warehouse Domain Hardening

The question this phase set out to make answerable, inside warehouse-api itself:

> May this authenticated actor perform this operation on this warehouse
> resource, in this workspace?

It is answerable now. Two thirds of the answer are enforced; one third is
reported as unanswerable, with the reason, rather than guessed at. **Zero
provider calls were made — nothing in this phase touched Astra.**

---

## A · What was there before

An inventory came first, before a line was changed. 101 routes across 18
modules. What it found:

**There was no workspace at all.** `x-entity-id` appeared nowhere in
warehouse-api except in the CORS allow-list. `PermissionGuard` called
`getUserAccessInfo(user.id)` with no workspace, and this service's copy of that
query reads a zero workspace as *"no entity context: everything counts"* — the
pre-4B.4 semantics that hr-api tightened. So a person made warehouse manager of
one company passed every warehouse permission check for all seven.

**The service said so itself**, in a comment that was half right:

> `entityId` is accepted for signature parity with the other APIs but unused —
> the warehouse is a single shared physical pool across entities, and `entityId`
> on a reservation is a reporting label, not a scoping key.

**Mutations had no actor.** `items.create(dto)`, `items.update(id, dto)`,
`maintenance.createRecord(dto)`, `maintenance.update(id, dto: any)`,
`resourceReturns.create(dto)` — none of them knew who was calling. Two of them
took the caller's word for who the author was: `createdBy: dto.createdBy` on a
maintenance record and `requestedBy: dto.requestedBy` on a return were numbers in
the request body, settable to anyone.

**One route had no validation at all.** `PATCH /maintenance/:id` took
`@Body() dto: any`, so the global pipe never ran on it.

**One list answered with everything.** `GET /resource-returns` carries no
permission guard — deliberately, because the CRM task screen reads it and the
people on a task hold no warehouse rights — and with no filter it returned every
return in the installation to anybody holding a token.

**The client had the workspace and never sent it.** nairon-warehouse-client
receives an `entityId` through the SSO fragment, writes it to
`localStorage.warehouse_entity`, has a Redux slice with a `selectEntityId`
selector registered in the store — and nothing dispatches into it and nothing
reads it. The axios interceptor sets `Authorization` and nothing else.

**The assistant, however, does send one.** `nairon-api.client.ts` puts
`x-entity-id` on every call to every service, warehouse included. That fact
turned out to decide the design; see §E.

---

## B · Where a warehouse resource lives, and where it cannot say

Exactly one table stores a workspace the server owns: `ItemCategory.entityId`.
Everything reachable from a category along a relation the database enforces can
be derived from it. `src/common/workspace/resource-workspace.service.ts` does
that derivation and nothing else:

| resource | workspace | how |
|---|---|---|
| `ItemCategory` | **known** | its own column |
| `Item` | **known**, when categorised | `category.entityId` |
| `Asset` | **known** | `item.category.entityId` |
| `MaintenanceRecord` | **known** | `asset.item.category.entityId` |
| `ResourceReservation` | **STOP** | see below |
| `ResourceReturn` | **STOP** | inherits the reservation's problem |
| `ProcurementOrder` | **STOP** | nothing in the schema relates to a workspace |
| `Supplier` | **STOP** | same |
| `Maintainer` | **STOP** | same |
| an `Item` with no category | **STOP**, per row | nullable by schema |

Every derivation returns `{ workspace, origin }`, and `workspace: null` means
UNKNOWN — never "everywhere", never entity 1.

### The reservation, and why it is a STOP and not a derivation

`ResourceReservation` has an `entityId` column. It looks like the answer and is
not. Three reasons, all measured against this installation's data:

1. **It is written from the request body** — `entityId: dto.entityId ?? null`.
   Deriving authority from it would be deriving authority from the caller.
2. **It is absent on 18 of the 83 rows.**
3. **Where it is present it usually disagrees with the goods.** 59 of the 65
   labelled rows name a company other than the one whose catalogue the goods sit
   in. 44 of those are company 7, which keeps no catalogue at all; company 3,
   which also keeps none, accounts for 7 more.

That crossing is not corruption. It is what a shared store is for: the label
records **who asked**, the catalogue records **whose stock it is**, and they are
different questions. Neither is a scoping key on its own, and picking one would
either trust the caller or break a working cross-company flow. So reservations
and the returns that hang off them are reported, not enforced.

What *is* done there is smaller and honest: a caller may no longer label a
reservation with a company they hold no role in
(`ReservationsService.assertMayLabelWith`). That is bookkeeping hygiene, and the
code says so in as many words. A reservation is never refused for naming another
company.

---

## C · The trusted actor

`src/auth/actor.ts` — plain functions over plain data, no Nest, no Prisma, no
request, so the mutation path, the preflight path and the tests all ask the same
question and get the same answer.

`src/auth/actor.service.ts` builds a `WarehouseActor` once per request, in
`AuthGuard`, which is global and runs first. `PermissionGuard` then reads the
result instead of asking again — one query where there used to be one, plus one
small new query for the actor's own workspaces.

```ts
type WarehouseActor = {
  userId: number;
  isSuperAdmin: boolean;
  isGlobalSuperAdmin: boolean;
  permissionNames: string[];               // resolved IN `declared`, when there is one
  home: { wildcard: boolean; entityIds: number[] };   // from their own assignments
  declared: number | null;                 // x-entity-id, AFTER it was checked
};
```

Nothing in it comes from the caller except `declared`, and `declared` is a
request rather than a fact: it is checked against `home` before it is allowed to
mean anything, and **a claim that fails is refused outright** rather than quietly
dropped. Silently downgrading "act as company 4" to "everything you can do
anywhere" is the worst available answer.

`readDeclaredWorkspace` treats anything that is not a positive integer —
absent, empty, `0`, `abc`, `1.5`, a repeated header — as declaring nothing.

---

## D · What a declaration does

It narrows **permissions**. `getUserAccessInfo(userId, declared)` resolves
assignments and grants that match that workspace or are wildcards — which is
what this service's query already did for a non-zero workspace; only the callers
had to change.

That is the hole this phase existed to close, and the live run proves it: a
person holding roles in companies 1 and 4, whose `manage_items` grant is scoped
to company 1, edits an item while acting as company 1 (HTTP 200) and is refused
the identical edit while acting as company 4 (HTTP 403). Before this phase both
succeeded.

**The zero case is deliberately left alone.** A caller who declares nothing
still resolves across every assignment, as before. hr-api tightened its
equivalent in 4B.4; doing the same here would take every scoped role's access
away at once, because no warehouse client sends a workspace. The tightening is
opt-in and arrives with the header.

---

## E · What a declaration deliberately does NOT do

It does not filter the catalogue, and this is the one place the warehouse
differs from CRM and HR.

The assistant already sends `x-entity-id` on every warehouse call, carrying the
person's current company — which, for companies 3 and 7, is a company with no
catalogue of its own. Had a declaration narrowed stock, every warehouse read the
assistant makes for those people would have answered with nothing: seven of the
eighteen accepted warehouse read capabilities — items list and get, assets list
and get, categories list, maintenance list and get — would have gone quietly
empty, and the availability and reservation reads that hang off them would have
had nothing to point at.

That is not merely inconvenient, it is wrong: stock is a shared pool, so which
company somebody is acting as says nothing about which stock exists. Resource
scope therefore comes from `home` — the workspaces their roles actually live in,
which the caller cannot influence at all — and a declaration narrows what they
may *do*, not what they may *see*. Somebody who wants one company's catalogue
asks for it: `GET /categories?entityId=4` is a filter, and a bounded actor's own
scope is still applied on top of it, so the query string can narrow and never
widen.

The live run pins this both ways: declaring company 4 still shows both
catalogues, and so does declaring company 7.

---

## F · The rule

```
not bounded              → allowed            (every account in this installation today)
bounded, workspace known → must match
bounded, workspace NULL  → refused: unknown-workspace
```

An unknown workspace is **never** treated as a match, and the refusal says which
of the two problems it was — "this belongs to another workspace" and "this has no
workspace, so it cannot be acted on from inside one" are different facts and a
log should not have to guess between them.

`scopeFor(actor, pathToCategory)` builds the list filter from a relation path
given as data (`['asset','item','category']`), so a typo is a compile error
rather than a silently unfiltered list. It returns `undefined` for an unbounded
actor — no filter, no change. A nested relation filter in Prisma does not match a
row whose relation is NULL, which is the same contract written a second way.

---

## G · Assertions, and the preflights that share them

Every assertion lives next to the service that owns the resource and is called
by the mutation, by the preflight, and by nothing else:

| service | assertion |
|---|---|
| `ItemsService` | `assertMayFileUnder(actor, categoryId)`, `assertMayEdit(actor, id)` |
| `CategoriesService` | `assertMayCreate(actor, dto)`, `assertMayEdit(actor, id)` |
| `AssetsService` | `assertMayCreateFor(actor, itemId)`, `assertMayEdit(actor, id)` |
| `MaintenanceService` | `assertMayMaintain(actor, assetId)`, `assertMayEdit(actor, id)` |
| `ReservationsService` | `assertMayLabelWith(actor, entityId)` — hygiene, not access |

`src/common/preflight/preflight.ts` is the contract, copied verbatim from
crm-api so the estate has one: `POST <resource>/preflight/<action>`, behind the
same guards, calling the same assert, answering `{ ok: true }` or throwing
exactly what the mutation would throw, writing nothing and notifying nobody. It
is UX validation, not authorization, and a successful preflight grants nothing.

Eleven were added: items create/update/delete, categories create/update/delete,
assets create/update/delete, maintenance create/update. The live run checks that
a preflight and its mutation answer **identically** — including answering 404
rather than 403 where the resource is out of scope, so a refusal never reveals
that an id is taken.

---

## H · The actor now reaches the writes

| write | before | now |
|---|---|---|
| `POST /items` | `create(dto)` | `create(dto, actor)`, filed under a category the actor can reach |
| `PATCH /items/:id` | `update(id, dto)` | asserts the item and, if the category moves, the destination |
| `DELETE /items/:id` | `remove(id)` | asserts |
| `POST /categories` | wrote `dto.entityId` verbatim | the workspace is decided, not taken |
| `PATCH /categories/:id` | ditto, including moving companies | asserts both the category and the destination |
| `POST /assets` | `create(dto)` | asserts the item |
| `PATCH /assets/:id` | `update(id, dto)` | asserts the asset and, if the item moves, the destination |
| `POST /maintenance` | `createdBy` from the body | `createdBy` is the token holder; asserts the asset |
| `PATCH /maintenance/:id` | `@Body() dto: any` | a real DTO; asserts the record |
| `POST /maintenance/:id/finalize` | — | asserts before finance is told anything |
| `POST /maintenance/:id/complete` | — | asserts |
| `POST /resource-returns` | `requestedBy` from the body | `requestedBy` is the token holder |
| `GET /resource-returns` | everything, to anyone | warehouse staff still get everything; everybody else must name a task |

---

## I · Idempotency, for the writes a future phase will expose

None of these are AI write tools and none were added here. The classification is
recorded now so the phase that does expose them does not have to guess:

| operation | idempotent? | on what |
|---|---|---|
| `items.create` | **no** | a repeat makes a second item; `code` is unique when given, which is the only natural key |
| `items.update` | **yes** | same body, same end state |
| `items.delete` | **yes** | second call is 404, end state identical |
| `categories.create` | **no** | no natural key at all; two identically named categories are legal |
| `categories.update` / `delete` | **yes** | |
| `assets.create` | **partly** | `serialNumber` is unique, so a repeat with one is refused; without one it duplicates |
| `assets.update` / `delete` | **yes** | |
| `maintenance.create` | **no** | nothing distinguishes two jobs on the same asset on the same day |
| `maintenance.update` | **yes** | |
| `maintenance.finalize` | **NO — and money moves** | raises finance transfers; a repeat is a second payment request |
| `maintenance.complete` | **yes** | status transition, already guarded by state |
| `returns.create` | **no** | quantity accumulates against the reservation |
| `returns.receive` / `cancel` | **yes** | state transitions, refused from the wrong state |
| `reservations.*` | out of scope | reservations are a STOP; see §B |

Anything marked "no" needs a one-time token at the point it is exposed, not a
retry.

---

## J · The finance boundary

Documented rather than changed, because changing it is a finance-api phase.

Warehouse calls finance in two places — `MaintenanceService.finalize` and
`ProcurementService.settleWithFinance` — with `x-internal-secret` and nothing
else. **No user identity and no workspace crosses that line.** Finance is told
what to do and takes warehouse's word for who may ask.

What follows:

- The last place the workspace question can be asked about a maintenance
  settlement is inside `finalize`, so it is asked there now, before the transfer
  is raised.
- Procurement has no workspace to ask about at all (§B), so its finance call
  remains entirely unauthorized in the workspace sense. It stays **STRONG
  WRITE**; it was not reclassified and must not be.
- `settleWithFinance` adjusts an existing `BALANCE` payment row rather than
  stacking, which is correct and was not touched.

The recommendation for whoever does the finance phase: the internal call should
carry the acting user and the workspace, and finance should re-derive rather than
believe. That is a two-service change and is out of scope here.

---

## K · Readiness

| resource | actor known | workspace known | assertion | reads scoped | preflight | status |
|---|---|---|---|---|---|---|
| ItemCategory | yes | **own column** | yes | yes | 3 | **hardened** |
| Item | yes | derived | yes | yes | 3 | **hardened** |
| Asset | yes | derived | yes | list + point | 3 | **hardened** |
| MaintenanceRecord | yes | derived | yes | list + point + upcoming + per-asset | 2 | **hardened** |
| ResourceReturn | yes | — | label hygiene only | list needs a scope | — | **partial — workspace STOP** |
| ResourceReservation | yes | — | label hygiene only | no | — | **partial — workspace STOP** |
| ProcurementOrder | yes | **none** | — | no | — | **STOP — no workspace in the schema** |
| Supplier | yes | **none** | — | no | — | **STOP** |
| Maintainer | yes | **none** | — | no | — | **STOP** |

"Actor known" means the trusted actor now reaches the service; on the STOP rows
that is all it means, and it is still worth having.

---

## L · What was deliberately not done

**No migration.** The plan going in was to add `entityId` to Item, Asset,
MaintenanceRecord and ResourceReturn and backfill from relations. It was dropped
once the derivation was written: the relations are enforced by the database, so
the column would have been a second copy of a fact that already exists, free to
drift the first time a category changes company. The smallest correct change here
turned out to be no schema change at all. Nothing was backfilled, invented, or
inferred from a name.

**No permission added to a previously open read.** `GET /items` has no permission
guard and still has none: the CRM task screen reads it, and the people on a task
hold no warehouse rights. Guarding it would have broken the reservation flow to
close a gap that row scoping closes properly for anyone who is bounded. Reported
here rather than half-fixed. The same applies to `GET /categories`,
`POST /availability/check` and `GET /reservations/task/:taskId`.

**No Warehouse AI write tools, no Batch 5, no change to Astra or the Quality
Center.** Nothing in this phase needed a model.

---

## M · Compatibility, checked rather than assumed

Every account in this installation holds a wildcard role and every warehouse
client declares nothing, so the boundary refuses nobody today. That is not a
weakness of the design, it is the design: the rules are in place and tighten the
moment a scoped role exists.

Two live-compatibility traps were found and fixed rather than shipped:

1. **The catalogue filter** (§E) would have emptied seven accepted read
   capabilities for companies 3 and 7. Caught by following what the assistant
   actually sends, and now pinned by two assertions.
2. **`PATCH /maintenance/:id`** — giving the route a DTO turns the global pipe on,
   and `forbidNonWhitelisted` would have answered 400 to the client's own edit
   form, which sends `assetId` back on every save. The field is accepted; naming
   a *different* asset is refused in words rather than dropped in silence, since
   moving a record between assets can move it between companies. `createdBy` on
   create is likewise still accepted and now documented as ignored.

One inconsistency the live run caught and sent back: a maintenance record outside
the caller's scope answered HTTP 200 with a null body while the same situation on
an item answered 404. Point reads now agree.

---

## N · Tests

**Unit — 41, all green** (`npx jest`).

`src/auth/actor.spec.ts` (23): reading a declared workspace, including nine
kinds of junk that must not become one; who may declare; what an actor is
bounded to; the three-case rule with the two refusals kept distinct; scoped and
global super admins; and where a new row gets filed, including the caller with two
companies who has to say which.

`src/common/workspace/resource-workspace.service.spec.ts` (18): each derivation
and its shape, unknown carried down a whole chain rather than lost, not-found
distinguished from unknown, the shared assertion, and the list filter for every
relation path.

**Live, two workspaces, against the running service — 39 checks, 39 passed.**

`scripts/workspace-boundary-e2e.mjs` makes three people who exist nowhere else —
one whose only role is in company 1, one in company 4, one with a wildcard — plus
two catalogues, an item and an asset in each, an uncategorised item and a
maintenance record. Then it tries to cross the line in both directions:

- company 1's person sees company 1's catalogue, not company 4's, and not the
  item that belongs to nobody;
- another company's item reads 404, not 403;
- editing it is refused, and the preflight refuses *identically*;
- moving their own item into the other catalogue is refused;
- creating an item with no catalogue is refused for somebody acting inside one;
- a category cannot be filed into a company they hold no role in;
- the rule reaches an asset through its item and a record through its asset;
- their own asset can still be maintained, and the author recorded is the token
  holder even though the body asked for user 999;
- claiming a company they hold no role in is refused outright;
- a wildcard role sees both catalogues, before and after declaring, including as
  company 7 which keeps no catalogue of its own;
- a grant scoped to company 1 is refused while acting as company 4, accepted
  while acting as company 1, and accepted when nothing is declared;
- somebody with no warehouse rights can no longer ask for every return there is,
  but may still ask about one task;
- and nothing a refused call touched was written.

It clears its own ids before it starts, deletes by exact id in a `finally`
whatever happens, prints what it left behind (`{"actors":0,"roles":0,"items":0,
"categories":0}`) and reports a crash instead of exiting silently — that last one
after a run did exit silently and cost a diagnosis.

---

## O · Provider calls

**Zero.** No model was invoked at any point in this phase, by any path. Nothing
here required one.

---

## P · Known gaps, stated rather than buried

1. **Procurement, suppliers and maintainers have no workspace.** Giving them one
   is a schema decision with a real backfill question behind it — which company
   owns a supplier used by two? — and is not something to infer. Procurement
   remains STRONG WRITE.
2. **Reservations and returns** are a genuine two-workspace problem (§B), not an
   oversight. Resolving it means deciding, at product level, whether "who asked"
   or "whose stock" governs, and probably storing both.
3. **`GET /items`, `GET /categories`, `POST /availability/check` and
   `GET /reservations/task/:taskId`** are open to any authenticated caller.
   Row scoping confines them for a bounded actor; nothing confines them for an
   unbounded one.
4. **`GET /resource-returns?taskId=` does not check that the caller is on the
   task.** Closing it means a CRM round trip per list, of the kind
   `assertTaskRole` already does for acceptance. Worth doing, not in this phase.
5. **`GET /users` and `GET /responsibilities/user/:userId`** carry no guard.
6. **The client still never sends a workspace**, so the narrowing is available
   and unused. Wiring `selectEntityId` into the axios interceptor is a one-line
   client change and a deliberate product decision, not a hardening task.
7. **The finance boundary** (§J) carries no identity.

---

## Q · Files

New:

```
src/auth/actor.ts                                    the rules, as plain functions
src/auth/actor.service.ts                            builds the trusted actor
src/auth/actor.spec.ts                               23 tests
src/auth/decorators/actor.decorator.ts               @Actor()
src/common/workspace/resource-workspace.service.ts   where a resource lives; the assertion
src/common/workspace/resource-workspace.service.spec.ts  18 tests
src/common/preflight/preflight.ts                    the contract, one per estate
src/maintenance/dto/update-maintenance-record.dto.ts a route that had none
scripts/workspace-boundary-e2e.mjs                   39 live checks, two workspaces
```

Changed: both guards, `app.module.ts`, `users-prisma.service.ts`, and the items,
categories, assets, maintenance, reservations and resource-returns modules.

Also fixed in passing: `test/app.e2e-spec.ts` imported `src/warehouse.module`,
which does not exist — so `npx tsc --noEmit` had never come back clean and the
one e2e file could not run at all. And jest could not resolve the `prisma/…` and
`src/…` imports the services use, which no spec had needed until now.
