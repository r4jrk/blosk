# Multi-Platform Comment System — Design

Two use cases: **retrieve the comments for a published post**, and **reply to a comment**, across
platforms that disagree about almost everything. Decision detail lives in [`ADRS.md`](ADRS.md);
this document is the narrative and cites records by number rather than restating them.

*On the stack:* Java + Spring would have been my preference; TypeScript, NestJS, Prisma,
PostgreSQL, Dragonfly and Zod were mandated, so the design is expressed in those.

---

## 1. Assumptions

Each of these is a real fork in the road, and each names the decision it flips if it turns out
false. ADR-003 in particular is only correct if A1, A4, A5 and A6 hold.

| # | Assumption | If false, this flips |
|---|---|---|
| **A1** | The consumer is this product's own web client, used by social-media managers reviewing one publication at a time. Not a public API, not an end-user-facing feed. | ADR-003. A public API with unknown access patterns needs a mirror to bound its own latency and rate-limit exposure. |
| **A2** | A "published post" is a `PostPublication` in a terminal success state. Comments are only ever requested for those; scheduled-but-unpublished content has no comment stream. | ADR-002's route shape. |
| **A3** | OAuth tokens, the connected-account lifecycle, and token refresh already exist in the product. This feature *consumes* `ConnectedAccount` and reports auth failure; it does not own acquisition or refresh. | ADR-011 and the deferred token-refresh item. If tokens are ours to manage, refresh-on-401-and-retry belongs inside the adapter and is no longer deferrable. |
| **A4** | Typical volume is tens to low hundreds of comments per publication; the p99 is a few thousand. This is not viral-scale content. | ADR-003 and ADR-004. At 100k comments per post, proxy pagination becomes the product experience and a mirror with local search is mandatory. |
| **A5** | A p95 read latency of 1–2s is acceptable, because a human is reading the result. One platform round trip per page is therefore affordable. | ADR-003. A 200ms budget rules out proxying entirely. |
| **A6** | Webhook coverage is inconsistent across our target platforms — at least one has none, or none we can rely on. A mirror would therefore need polling, backfill, gap detection and dedup on day one, not later. | ADR-003. Universal, reliable webhooks make the mirror materially cheaper and it likely wins. |
| **A7** | Replies are composed by a human, one at a time, in a UI that is waiting for the result. There is no bulk or automated reply path in this slice. | ADR-006. Bulk reply makes the synchronous write untenable and forces the queue. |
| **A8** | No target platform offers idempotency keys on comment creation. We cannot ask a platform whether our write landed. | ADR-006's honesty about at-most-once, and ADR-015 entirely. |
| **A9** | The workspace / connected-account authorisation model already exists upstream of this feature. We enforce it; we do not define it. | ADR-012's shape, not its substance. |
| **A10** | Single region, single primary PostgreSQL, single Dragonfly. No cross-region replication or multi-writer concerns. | ADR-007. Under multi-region writes, a unique constraint on one primary stops being a global guarantee. |

---

## 2. Scope

| Fully built | Stubbed, with real signatures | Design-only |
|---|---|---|
| Canonical domain model, both identifier codecs, error taxonomy, tenant scope | Remaining platforms (the registry throws a typed `NotImplementedError`) | Rate-limit token buckets |
| `CommentProvider` port, capability descriptors, registry | Webhook ingestion and backfill (`application/deferred.ts`) | Retry, backoff, dead-lettering |
| **LinkedIn** and **X** adapters — transport, payload schemas, mapper each | Reconciliation of `UNKNOWN` replies | Historical backfill |
| Read and reply application services; Prisma repository; Dragonfly cache | | Token refresh and revocation |
| Controllers, Zod validation, Swagger, error filter, tenancy guard, health/readiness | | Upstream edits and deletions (ADR "Deliberately deferred") |
| Adapter contract suite, mapper tests, codec tests, idempotency lifecycle tests | | |

**Platform selection.** `TASK.md` names two different pairs (Facebook + LinkedIn, then LinkedIn +
Twitter). Resolved as **LinkedIn + X** — which satisfies the second exactly and, more to the point,
maximises structural dissimilarity. LinkedIn's model is shallow and resource-oriented: comments and
replies are separate, separately-paginated collections capped at one level. On X a reply *is* a
post, so "comment" is synthetic over a flat conversation graph with unbounded depth and a
side-loaded author block. Facebook and LinkedIn are both shallow parent/child models; an adapter
pair that agrees is not a test of a port. The payoff is `linkedin.mapper.ts` versus `x.mapper.ts`,
which share nothing but a return type.

**Background sync is deliberately overridden, not overlooked.** `TASK.md` states it as a functional
requirement; ADR-003 chooses a cache-through proxy and defers mirroring, because by A6 a mirror is
not "ingest webhooks" but webhooks *plus* polling, backfill, gap detection, dedup and per-platform
cursor state — this slice's whole budget spent on a queryability neither use case asks for. If the
reviewer's priority is the mirror, that disagreement should be arguable rather than hidden.
ADR-003's migration path is the answer to "what does changing my mind cost?": a change of writer,
not a schema rewrite.

---

## 3. Domain model

The vocabulary is deliberate, because this domain is unusually good at ambiguity.

A **Post** is content authored in the product, platform-agnostic. A **PostPublication** is the
result of publishing one Post to one **ConnectedAccount**; it holds the platform-native post ID and
is the parent of a comment stream. A **Comment** is a platform-native comment on a publication, by
anyone; `parentId = null` makes it a **root comment**, otherwise a **Reply**. `Reply` is structural
— "has a parent", regardless of author. An **OwnReply** is a Reply this system authored on the
customer's behalf: the only Comment we ever write to a platform, and the only one with a
`deliveryState`. An **Author** is a platform-native identity, never joined to a user of ours
(ADR-010).

---

## 4. Database schema

Full schema in [`prisma/schema.prisma`](prisma/schema.prisma). The `Comment` model, condensed:

```prisma
model Comment {
  id                    String   @id @default(uuid()) @db.Uuid
  workspaceId           String   @db.Uuid
  publicationId         String   @db.Uuid
  platformCommentId     String?
  parentId              String?  @db.Uuid   // adjacency list (ADR-004)
  rootId                String?  @db.Uuid
  rootPlatformCommentId String?             // denormalised: the root may not exist locally
  depth                 Int      @default(0)
  body                  String?
  authorPlatformId      String?             // snapshot, not a join (ADR-010)
  authorHandle          String?
  authorDisplayName     String?
  isOwnedByUs           Boolean  @default(false)
  platformCreatedAt     DateTime?
  platformMetadata      Json?               // curated, never serialised outbound (ADR-016)
  connectedAccountId    String?  @db.Uuid   // ─┐
  deliveryState         DeliveryState?      //  │ OwnReply only
  idempotencyKey        String?             //  │
  threadCollapsed       Boolean  @default(false) // ─┘
  @@unique([publicationId, platformCommentId])
  @@index([publicationId, rootId, platformCreatedAt])
  @@index([connectedAccountId, deliveryState])
}
```

**`UNIQUE (publicationId, platformCommentId)`** makes ingestion idempotent. It is what lets ADR-014
resolve a platform-keyed comment reference, and what would let a future mirror re-ingest a thread
without duplicating it. PostgreSQL treats NULLs as distinct, so own-replies still awaiting a
platform ID do not collide.

**Partial `UNIQUE (connectedAccountId, idempotencyKey) WHERE idempotencyKey IS NOT NULL`** — in
[`prisma/partial-indexes.sql`](prisma/partial-indexes.sql), because Prisma's schema language cannot
express a `WHERE` clause on an index. The partiality is exactly what ADR-015's key release depends
on: a reply transitioning to `FAILED` nulls the key in the same transaction, and a partial index
does not index NULL rows at all, so the failed attempt is retained for audit without occupying the
key. (A plain unique index behaves identically here, NULLs being distinct in PostgreSQL; the
partial form is still what to write, because it states the intent and indexes nothing it can match.)

**Nullable columns are load-bearing.** `body`, `authorPlatformId`, `authorDisplayName` and
`platformCreatedAt` are nullable because two legitimate rows lack them: an `OwnReply` in `PENDING`
has no platform timestamp yet, and a parent materialised from a comment reference (ADR-014) is known
only by its platform ID, depth and handle. `authorHandle` is nullable because not every platform
exposes one. `rootPlatformCommentId` is denormalised alongside `rootId` because under a proxy read
we routinely hold a reply whose root was never persisted — without it, resolving the root of one of
our own replies would cost a platform round trip.

**Indexes.** `(publicationId, rootId, platformCreatedAt)` is the mirror's page query — roots by
time, then `WHERE rootId IN (...)` — in one index; today it serves point lookups.
`(connectedAccountId, deliveryState)` is the reconciler's scan for replies stuck in `UNKNOWN`.
`PostPublication` leads with `workspaceId` so the tenancy predicate is index-satisfied.

---

## 5. Key decisions

Each entry is *decision / why / what was rejected / what it costs*. Full records in `ADRS.md`.

**ADR-001 — Ports and adapters.** The platform axis changes often, the persistence axis rarely, so
domain and application code depends only on ports and imports nothing from `@prisma/client`,
`@nestjs/*`, `ioredis` or any platform SDK. Rejected: conventional NestJS layering with platform
clients injected into services (SDK types leak upward, and every service test then mocks at SDK
level); one `PlatformService` with an internal strategy map (survives two platforms, rots at five).
Cost: more indirection than a CRUD feature this size normally earns.

**ADR-002 — Comments attach to a PostPublication.** One Post fans out to N targets, each with its
own platform post ID, token and rate-limit budget; the route is `/publications/{id}/comments`.
Rejected: `postId + platform` as composite parent — it cannot represent two brand accounts on one
platform publishing the same post, a routine agency case; and `/posts/{id}/comments`, because
merging N streams whose cursors are mutually incomparable has no correct interleaved ordering
without buffering all of them.

**ADR-003 — Cache-through proxy, schema shaped for later mirroring.** Read live; cache each page for
30–60s; persist only comments we have interacted with. Rejected: the full mirror, on day-one cost
under A6 — explicitly *not* on freshness, since a webhook-fed mirror can be fresher than a 60s
cache; and pure proxy, which burns rate limit on back-and-forth paging. Cost: no cross-post search,
and our availability is coupled to theirs.

**ADR-005 — Capabilities as declarative data.** Each provider exposes a frozen
`PlatformCapabilities` — depth, length, `onDepthExceeded`, mention format, pagination direction —
and application logic branches on those *values*, never on platform identity. Rejected: optional
port methods behind `supportsX()` guards (ISP violation; every caller must remember the guard);
sub-interfaces with narrowing (the same conditional, relocated); a capability map in shared code
(adding a platform edits a shared file — fails OCP directly).

**ADR-006 — Reply is synchronous, record committed before the platform call.** Insert the row
`PENDING` and **commit**, then call the platform. A timeout returns `202` with a status resource —
not `201` (we would be asserting a comment exists) and not a 5xx (which invites the one retry that
can duplicate a public comment). Rejected: queue-everything (right at scale, but by A7 it forces
polling onto a synchronous interaction — and clients built against the outcome matrix already
handle `202`, so that migration is non-breaking); call-then-persist (a crash loses all record of a
comment published under the customer's name); holding the transaction open across the HTTP call
(exhausts the pool). Cost: **exactly-once is unachievable** — by A8 no platform will tell us whether
our write landed.

**ADR-009 — Reply-to-a-reply collapses, and the response says so.** Where the platform cannot accept
the requested depth, the reply is posted to the root with the target author's mention prefixed, and
the response returns `effectiveParentId` and `threadCollapsed: true`. This is what the platforms'
own clients do. Length is checked *after* the mention is rendered, since we add it and it counts.
Rejected: always 400 (pushes platform trivia onto every consumer, and is wrong on the merits — the
reply *is* possible); silent collapse (the caller's model diverges with no signal). Cost: `parentId`
is a request, not a guarantee.

**ADR-011 — Three-bucket typed error taxonomy.** `CallerError` → 400/404/409/422, `SystemError` →
500/501, `UpstreamError` → 424 auth, 503 + `Retry-After` rate limited, 502 unavailable, 409 rejected.
A revoked platform token becomes **424, never 401** — 401 would tell our caller *their* credentials
failed. Upstream rate limiting is **503, not 429**, by the same principle: 429 means the caller sent
too much and makes clients back off from us, which does not replenish the platform's bucket.
Rejected: throwing `HttpException` from services (DIP violation); passing platform codes through.
Cost: 424 is unusual and needs documenting.

**ADR-013 — Thread assembly in the adapter mapper.** The canonical `ThreadPage` is built from the
payload by that platform's mapper; the service never learns how. Rejected: assembling in the service
(a `switch (platform)` in the worst possible place); returning a flat list for the client to
assemble (same problem, pushed across the network); an abstract base mapper (the two shapes share
only their return type — that is the interface, not shared code). Cost: for LinkedIn-shaped APIs,
fetching replies per root is an **N+1 against the platform** — bounded by page size, capped at 4
concurrent, cache-covered. Not an N+1 against our database, which this path never issues.

**ADR-014 — Comment IDs are opaque, self-describing envelopes.** Under a proxy read the client holds
comments we never persisted, so `parentId` can be neither one of our UUIDs nor a raw platform ID. It
is a base64url envelope carrying kind, publication, platform ID, depth and author handle. Rejected:
our own UUID (requires persisting everything we serve); the raw platform ID (leaks vendor
identifiers, not unique across platforms); persisting every served comment (the mirror's write
volume with none of its benefits). Cost: long, unreadable IDs — plus one correction: ADR-014 as
written carries `d` and `h`, but implementing ADR-009 showed a collapse must also *address* the
root, so the envelope carries `r`. Without it every collapsed reply would spend a platform round
trip to learn what the client had already been told.

---

## 6. API design

All routes are under `/api/v1` and require `x-workspace-id` (standing in for the workspace claim on
the authenticated principal — A9).

| Method | Route | Notes |
|---|---|---|
| `GET` | `/publications/{id}/comments?cursor=&pageSize=` | A page of root comments, each with its replies. `200`. |
| `GET` | `/publications/{id}/comment-capabilities` | Lets a UI disable a reply box or warn about a collapse. `200`. |
| `POST` | `/publications/{id}/comments/{commentId}/replies` | `Idempotency-Key` optional. `201` / `202` / `200` / `409`. |
| `GET` | `/replies/{replyId}` | Delivery status. Required — ADR-006's `202` points here. |
| `GET` | `/health`, `/health/ready` | Liveness; readiness (ADR-017). |

**Pagination.** Cursors are opaque, versioned envelopes we own, never the platform's token. Decode
is validation: the version must be supported, the publication must equal the route parameter (this
stops a cursor from one thread being replayed against another), and `pageSize` is re-validated
against the same Zod bounds as the query parameter — it rides inside the envelope so a sequence
stays self-consistent, which makes it caller-controlled and otherwise an unbounded-page exhaustion
path. If both are present the envelope wins. An expired platform cursor is `400 CURSOR_EXPIRED` — a
caller-fixable pagination failure, not a retryable outage.

**Idempotency.** Keyed per connected account. Replay is a function of `deliveryState`: `SENT` →
`200` with the existing reply, `PENDING` → `409 REPLY_IN_FLIGHT` + `Retry-After: 1`, `UNKNOWN` →
`202`, `FAILED` → the key is released and the request proceeds as new. Errors are
`{ error: { code, message, details? } }` — a stable code, never a platform's own.

**Deferred, one sentence each.** *Rate limits*: per-ConnectedAccount token buckets in Dragonfly,
surfacing as `UpstreamRateLimited`. *Retry/backoff/dead-lettering*: arrives with the async write
path, and `UNKNOWN` records are explicitly excluded from automatic retry. *Backfill*: arrives with
the mirror; schema and both envelopes are already shaped for it. *Token refresh*: owned elsewhere by
A3 — if that is false, refresh-on-401-with-one-retry belongs inside each adapter's HTTP client.

**On Dragonfly, non-decoratively.** Two jobs survive scrutiny — page-response caching and (deferred)
rate-limit token buckets — and both tolerate eviction, the worst case being a redundant platform
call. One job was rejected outright: idempotency records. `SETNX` with a TTL is the textbook Redis
use and it is wrong here, because an evicted idempotency record produces a **duplicate public
comment on a third-party platform**. A cache is not durable storage; match the durability class to
the severity of the consequence (ADR-007).

---

## 7. Adding platform #7

1. Create `src/platforms/<platform>/` with three files: `<p>.payloads.ts` (Zod schemas for the
   vendor's wire format), `<p>.mapper.ts` (payload → canonical `ThreadPage`), `<p>.provider.ts`
   (implements `CommentProvider`: HTTP via the injected client, capability descriptor, vendor errors
   → our taxonomy).
2. Add the platform to the `Platform` enum in `src/domain/ids.ts` and `prisma/schema.prisma`.
3. Add one line to `createPlatformProviders` in `src/platforms/platform-registry.ts`.
4. Add `test/<platform>.provider.spec.ts` calling `runProviderContract` with a fixture.

Steps 2 and 3 are the only edits outside the new directory, and step 2 is an enum widening rather
than a behaviour change. Nothing in the domain model, application services, controllers, DTOs,
repository or error mapping changes.

Checked rather than asserted: grepping for platform identity outside `src/platforms/` returns
exactly two hits — the enum declaration, and one illustrative doc comment in the port. There is no
conditional on platform identity anywhere. The registry does not even key its map by hand: providers
declare their own `platform` and the map is built from the list.

---

## 8. Known gaps

- **`platformMetadata` has no writer.** The column and each adapter's curation schema exist for the
  ingestion path (ADR-016); under the proxy we do not persist fetched comments. An honest cost of
  ADR-003, not an oversight.
- **The reconciler is a stub.** `UNKNOWN` replies are durable, queryable and reported, but nothing
  resolves them automatically; that needs a `listOwnRecentComments` capability the port deliberately
  does not have until there is a caller.
- **X can promote an off-page reply to a root.** Where a comment's ancestor is not in the page it is
  surfaced as a root with its parent reference preserved, rather than dropped or given an invented
  ancestor. A real seam under a proxy; it disappears under a mirror.
- **No automated integration test against a live database.** The idempotency *lifecycle* is covered
  by fakes; the Prisma transaction and unique-violation paths were verified by running the compose
  stack and posting a reply, not by a test that runs in CI.
- **Materialised Path was rejected** for an adjacency list (ADR-004) — a deliberate deviation from
  `TASK.md`, which also contradicts itself on this point.
