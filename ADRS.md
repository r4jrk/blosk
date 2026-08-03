# Architecture Decision Records — Multi-Platform Comment System

Compressed ADR format. Each record states the decision, the alternatives rejected and why, and the cost accepted. A record with no rejected alternative is a description, not a decision, and does not belong here.

All records are **Accepted** unless marked otherwise.

---

## Assumptions

These are the forks in the road. Each is a thing that could reasonably be otherwise, and each names the decision it would flip if it turned out false. ADRs cite them as `A1`…`A10`. This list is load-bearing: ADR-003 in particular is only correct if `A1`, `A4`, `A5` and `A6` hold.

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

## Vocabulary

These terms are used precisely throughout. They are the ubiquitous language for the feature.

| Term | Meaning |
|---|---|
| **Workspace** | The tenant. Owns connected accounts and posts. |
| **ConnectedAccount** | One authorised social identity on one platform (`workspace × platform × platform user`). Holds the OAuth token and is the unit of rate limiting. |
| **Post** | A piece of content authored in the scheduling product. Platform-agnostic. |
| **PostPublication** | The result of publishing one Post to one ConnectedAccount. Holds the platform-native post ID. The unit a comment stream belongs to. Abbreviated *publication*. |
| **Comment** | A platform-native comment on a PostPublication, by anyone. The only entity in the thread. `parentId = null` makes it a **root comment**; otherwise it is a **reply**. |
| **Reply** | Any Comment with a non-null `parentId`, regardless of author. Not a separate entity. |
| **OwnReply** | A Reply this system authored on the customer's behalf — `isOwnedByUs = true`. The only Comment we ever write to a platform, and the only one with a `deliveryState`. |
| **Thread** | The full set of Comments on one PostPublication, as a tree. A **thread page** is a page of root comments plus their replies. |
| **Author** | The platform-native identity that wrote a Comment. Not a user of this product and never joined to one (ADR-010). |

> **Note on `Reply`.** An earlier draft defined a Reply as *"a Comment we author"*, which made a third party's nested comment not-a-reply and contradicted every other use of the word in this document. `Reply` is now structural (has a parent) and `OwnReply` carries the authorship meaning.

## Index

| # | Decision | Core? |
|---|---|---|
| 001 | Ports and adapters, with a platform provider port | ✅ |
| 002 | Comments attach to a PostPublication, not a Post | ✅ |
| 003 | Read strategy: cache-through proxy, schema shaped for later mirroring | ✅ |
| 004 | Canonical storage model: adjacency list with denormalised `rootId` and `depth` | |
| 005 | Platform differences as declarative capability descriptors | ✅ |
| 006 | Reply is synchronous, local record committed before the platform call | ✅ |
| 007 | Idempotency records in PostgreSQL, not in the cache | |
| 008 | Opaque, versioned cursors owned by this API | |
| 009 | Reply-to-a-reply collapses on shallow platforms, and the response says so | ✅ |
| 010 | Author identity is a denormalised snapshot; no author table | |
| 011 | Three-bucket typed error taxonomy, mapped to HTTP at the edge | ✅ |
| 012 | Tenancy enforced in the data-access layer via a mandatory scope | |
| 013 | Thread assembly happens in the adapter mapper, not in a query | ✅ |
| 014 | Comment IDs are opaque, self-describing envelopes | ✅ |
| 015 | Idempotency record lifecycle: keys are released on determinate failure | |
| 016 | Native platform metadata in JSONB, write-only to the API boundary | |
| 017 | Shallow health check; readiness never probes a platform | |

"Core" marks the records that must appear in `DESIGN.md` §5; the rest are referenced by number and live here.

---

### ADR-001 — Ports and adapters, with a platform provider port

**Context.** This feature has two axes of change with very different frequencies. New social platforms are expected and frequent — the brief says so explicitly. New persistence or transport technology is rare. The domain logic itself is thin; almost all the complexity lives in the integration surface, which is the part we do not control and cannot stabilise.

**Decision.** The domain and application layers depend only on ports and import nothing from `@prisma/client`, `@nestjs/*`, `ioredis`, or any platform SDK. A `CommentProvider` port defines the platform contract; one adapter implements it per platform; a registry resolves platform → provider. Infrastructure sits in the outer ring.

**Rejected.**
- *Conventional NestJS layering (controller → service → repository), with platform clients injected directly into services.* Platform SDK types leak upward into service signatures, so every service test needs the platform mocked at the SDK level rather than at a contract we own.
- *A single `PlatformService` holding a strategy map internally.* Collapses orchestration, mapping, and transport into one class. It survives two platforms and rots at five.

**Accepted cost.** More indirection than a CRUD feature of this size would normally justify, and one extra mapping layer per adapter. This is only worth paying because the platform axis is genuinely open-ended; if it were fixed at two platforms forever, this would be over-engineering.

---

### ADR-002 — Comments attach to a PostPublication, not a Post

**Context.** "Retrieve comments for a published post" is ambiguous in a scheduling product. One Post fans out to N targets, each of which yields its own platform-native post ID, its own comment stream, its own OAuth token, and its own rate-limit budget.

**Decision.** `Comment.publicationId → PostPublication`. The route is `GET /api/v1/publications/{publicationId}/comments`. No `/posts/{postId}/comments` route in this slice.

**Rejected.**
- *`Comment.postId` + `Comment.platform` as the composite parent.* Cannot represent two ConnectedAccounts on the same platform publishing the same Post — a routine case for an agency running several brand accounts on Instagram. It also loses the association to the specific token and rate-limit bucket needed to fetch the stream.
- *Keying comments by the platform post ID alone.* Not globally unique across platforms, and carries no tenancy anchor.
- *Providing `/posts/{postId}/comments` as a convenience.* Merging N heterogeneous streams whose cursors are mutually incomparable is a materially different problem — there is no correct interleaved ordering without buffering every stream. Out of scope; noted, not attempted.

**Accepted cost.** Clients resolve a publication ID before fetching comments. Low cost: publication state is already the thing a scheduling product surfaces per post (A2).

---

### ADR-003 — Read strategy: cache-through proxy, schema shaped for later mirroring

**Context.** Three viable strategies: proxy live to the platform on every read; mirror comments locally via webhook and polling ingestion; or a hybrid. This is the highest-leverage decision in the design and it turns entirely on the assumptions above.

**Decision.** Read through the adapter from the platform. Cache each page response in Dragonfly with a short TTL (30–60s) to absorb refresh-spam and back-and-forth pagination. Persist locally only the comments we have interacted with — those rows must exist anyway for the write path (ADR-014).

**Reasoning, in order of weight.**

1. **Day-one cost.** By A6, a mirror is not "ingest webhooks". It is webhooks *plus* a polling scheduler, backfill, gap detection, dedup, per-platform cursor state, and a reconciliation story for every one of those — all before the first comment renders. That is the whole of this slice's budget spent on infrastructure for a queryability neither use case asks for.
2. **Neither stated use case is a query.** Read one publication's thread; reply to one comment. Both are point lookups against a stream the platform already indexes for us. A mirror earns its keep when you need cross-post search, an aggregated inbox, or analytics — none of which are in scope.
3. **Latency is affordable.** By A1 and A5, a human is waiting on a page they explicitly navigated to, and one platform round trip fits the budget.

**On freshness — stated carefully, because the naive version of this argument is wrong.** A mirror is not inherently staler than a proxy; a webhook-fed mirror can be *fresher* than our 60s cache. And no read strategy prevents the real hazard, which is replying to a comment deleted moments ago — only a write-time failure from the platform catches that, which we get for free under any strategy (mapped to `UpstreamRejected`, ADR-011). Freshness is therefore **not** the reason the mirror loses. The reason is cost against A6. This is recorded explicitly because the earlier draft of this record led with freshness, and that argument does not survive contact with a platform that has good webhooks.

**Rejected.**
- *Full local mirror.* Above. It is the right answer the moment a cross-post inbox, search, or comment analytics appears — which is why the migration path below matters.
- *Pure proxy, no cache.* A manager paging back and forth burns platform rate limit, which is the scarcest resource in the system.

**Cache key and tenancy.** The key is `comments:v1:{workspaceId}:{publicationId}:{cursorHash}:{pageSize}`. `workspaceId` is included **even though `publicationId` is a UUID we mint and is therefore already globally unique** — because ADR-012's guarantee is structural (an unscoped query does not typecheck) and a cache read does not go through the repository, so it sits outside that guarantee. The cache port therefore takes the same `TenantScope` value object the repository does, and composes the key from it rather than from a caller-supplied string. The safety property is then the same one ADR-012 buys, rather than an implicit argument about UUID uniqueness that a future reader has to reconstruct.

The publication is resolved and tenancy-checked *before* the cache is consulted, so a cache hit never skips authorisation. Ordering is: decode cursor → resolve publication under scope → cache lookup → adapter call on miss.

**Accepted cost.** No cross-post querying, no search, no offline availability. Read latency is bound by the slowest platform and our availability is coupled to theirs. All explicitly accepted for this slice.

**Migration path.** The `Comment` table already holds the canonical shape (ADR-004). Moving to a mirror changes *who writes to it* and adds an ingestion port — it does not reshape the schema or the public API. Cursors (ADR-008) and comment IDs (ADR-014) are opaque precisely so that identifiers already handed to clients survive the switch.

---

### ADR-004 — Canonical storage model: adjacency list with denormalised `rootId` and `depth`

**Context.** Platforms disagree about nesting. Instagram, YouTube and LinkedIn allow one level of replies. Facebook is effectively two. On X a reply is itself a first-class post, so chains are unbounded. The canonical model has to accept all three shapes.

**What this record does *not* claim.** Under ADR-003 the read path does not query this table — it assembles the thread from the platform payload (ADR-013). An earlier draft justified these columns by a paginate-over-local-roots query that the chosen read strategy never executes. That justification was wrong and is withdrawn. The columns are justified by two other consumers:

1. **The write path.** An `OwnReply` row needs its position in the thread recorded at insert time (ADR-006 commits it before the platform call, so nothing later can fill it in), and ADR-009's collapse logic needs the target's `depth`.
2. **The mirror, if ADR-003 is revisited.** This is the shape a mirror would need, and choosing it now is what makes that migration a change of writer rather than a schema rewrite.

**Decision.** `parentId` (nullable self-FK), `rootId` (nullable; null on a root, else the top-level ancestor), `depth` (int, 0 at root). Index `(publicationId, rootId, platformCreatedAt)`.

Under a future mirror this supports paginating over roots and then loading that page's replies with one `WHERE rootId IN (...)` — two queries per page, no N+1, no recursion. Today it supports point lookup and insert.

**Rejected.**
- *Materialised path.* Buys prefix-based subtree queries we never issue, and costs path maintenance plus a text index. Named in the original architectural guidance; rejected on the read patterns actually present. *(Deviation from stated guidance — recorded deliberately, see `IMPLEMENTATION_PROMPT.md` §2a.)*
- *Closure table.* O(depth) rows per insert to support ancestor queries no use case needs. Clear over-engineering at a typical maximum depth of two.
- *Storing nothing but `parentId`.* Cheapest today, but forces a recursive CTE or an ancestor walk the moment the mirror lands, and gives ADR-009 nothing to read `depth` from.

**Accepted cost.** Unbounded X chains are represented as a root plus an ordered, flattened set of descendants rather than a true tree. `depth` is preserved so a client can still indent. Re-parenting is unsupported — no platform permits it, so the denormalised `rootId` cannot go stale.

---

### ADR-005 — Platform differences as declarative capability descriptors

**Context.** Callers need to know maximum reply depth, maximum comment length, and mention syntax. If that knowledge lives in conditionals, every new platform edits shared code and the Open/Closed invariant fails.

**Decision.** Each provider exposes a frozen `PlatformCapabilities` value object. Application logic branches on **capability values, never on platform identity**. Reply validation is derived from the descriptor rather than hard-coded per platform.

```ts
readonly maxThreadDepth: number;        // 1 = root + one level of replies
readonly maxReplyLength: number;        // graphemes, post-mention (ADR-009)
readonly onDepthExceeded: 'collapse' | 'reject';
readonly mentionFormat: MentionFormat;  // how to render an @author prefix
readonly paginationDirection: 'newest-first' | 'oldest-first';
```

**On the field set.** The earlier draft carried `maxThreadDepth`, `supportsReplyToReply` **and** `collapsesDeepReplies` — three fields expressing one fact, two of them derivable, all three free to drift apart. `supportsReplyToReply` is exactly `maxThreadDepth > 1` and is deleted. `collapsesDeepReplies` is replaced by `onDepthExceeded`, which is not derivable (it is a product choice per platform, not a platform limit) and reads as an instruction at the call site rather than as a fact needing interpretation. `supportsReplyDeletion` is deleted outright: no caller reads it, because deletion is out of scope. A capability no caller reads is dead weight.

**Exposure.** Capabilities are served at `GET /api/v1/publications/{publicationId}/comment-capabilities` so a UI can disable a reply box, show a character counter, or warn about collapsing before the user types. This is a third endpoint beyond the brief's two use cases and is justified only by ADR-009: that decision makes `parentId` a request rather than a guarantee, and a client with no way to anticipate the collapse would have to surprise its user after the fact. The server remains correct without it (ADR-009).

**Rejected.**
- *Optional methods on the port guarded by `supportsX()`.* Interface Segregation violation. The port grows monotonically and every caller must remember the guard.
- *Sub-interfaces with type narrowing.* Pushes platform branching back into callers as `instanceof` checks — the same conditional, relocated.
- *A capability map keyed by platform, held in shared code.* Adding a platform means editing a shared file. Fails the OCP invariant directly.

**Accepted cost.** The descriptor must be expressive enough that no caller ever needs to know which platform it is holding. When a genuine one-off appears, the correct response is to widen the descriptor, not to add a conditional.

---

### ADR-006 — Reply is synchronous, with the local record committed before the platform call

**Context.** Replying crosses a trust boundary into a system we do not control. The failure modes are platform 5xx, rate limiting, an expired or revoked token, and the genuinely hard one: a network timeout after which we cannot know whether the comment was posted.

**Decision.** Synchronous. Ordering: validate and resolve capabilities; insert the local row in `deliveryState = PENDING` carrying the idempotency key and **commit** — the database transaction closes here, before any network I/O; call the platform; update state per the matrix below.

**Outcome matrix.** The earlier draft said "`201` with the created resource" and separately admitted a row could end in `UNKNOWN` — which left the hardest case with no defined response. It is defined here.

| Platform outcome | `deliveryState` | HTTP | Body |
|---|---|---|---|
| Created | `SENT` | `201` | The comment, with its resolved ID (ADR-014) |
| Rejected — comments closed, content blocked, parent deleted | `FAILED` | `409` | `UpstreamRejected` |
| Rate limited | `FAILED` | `503` + `Retry-After` | `UpstreamRateLimited` (ADR-011) |
| Token revoked or expired | `FAILED` | `424` | `UpstreamAuthError` |
| Determinate 5xx — request provably not applied | `FAILED` | `502` | `UpstreamUnavailable` |
| **Timeout, or a connection dropped mid-flight** | **`UNKNOWN`** | **`202`** | **The pending resource + `Location` of its status** |

The last row is the point of the table. A timeout cannot honestly return `201` (we would be asserting a comment exists, possibly with no ID to name it) and cannot return a 5xx (that tells the client to retry, which is the one action that can duplicate a public comment). `202 Accepted` with a status resource is the only response that describes reality: *we have a durable record, we do not yet know its fate, here is where to watch it.* The client polls `GET /api/v1/replies/{replyId}`, which reports `PENDING | SENT | FAILED | UNKNOWN` and is the same resource the reconciler updates.

So the API is synchronous on the happy path and degrades to asynchronous exactly where synchrony would require lying. Clients must handle `202` — documented loudly, not buried.

**Rejected.**
- *`202 Accepted` + status resource + queue worker for every reply.* The right answer at scale and the natural home for retry and backoff — but by A7 it forces every client into polling for an interaction that is fundamentally synchronous. A manager typing a reply expects to see it posted. Recorded as the migration target once rate-limit smoothing or bulk reply becomes necessary; note that clients built against the outcome matrix above already handle `202`, so that migration is not a breaking change. **That is the main reason for defining the timeout case this way rather than as an error.**
- *Fire-and-forget.* No channel to report failure.
- *Call the platform first, persist afterwards.* A crash between the two loses all record of a comment we published under the customer's name. Unrecoverable, and it makes idempotency impossible.
- *Holding the transaction open across the HTTP call.* Pins a connection for the duration of a third-party round trip. Under any load this exhausts the pool.

**Accepted cost, stated honestly.** Request latency is bound by the platform. **Exactly-once is not achievable here** — by A8 the platforms offer no idempotency keys, so we cannot ask whether our write landed. We guarantee at-most-once *from the client's perspective* (ADR-007, ADR-015) and surface `UNKNOWN` for reconciliation; a stubbed reconciler matches recent comments by our own account on that publication against `UNKNOWN` records. This is a limitation of the domain, not of the design.

---

### ADR-007 — Idempotency records in PostgreSQL, not in the cache

**Context.** Dragonfly is available and idempotency keys are the textbook Redis use case — `SETNX` with a TTL. That is the wrong instinct here.

**Decision.** The idempotency key is a column on the reply row itself, with `UNIQUE (connectedAccountId, idempotencyKey)`. The cache is not involved in the write path. Lifecycle in ADR-015.

**Reasoning.** Match the durability class to the severity of the consequence. An evicted idempotency record produces a **duplicate public comment on a third-party platform** — visible to the customer's audience and not cleanly reversible. Dragonfly is a cache: it evicts under memory pressure, and it sits outside the transaction that creates the reply row. Putting the constraint on the row we are already writing makes deduplication atomic with creation — no reservation step, no time-of-check/time-of-use window between "is this key taken" and "take it".

**Rejected.**
- *`SETNX` in Dragonfly.* Wrong durability class for an irreversible external side effect.
- *A dedicated `IdempotencyKey` table.* An extra row and a two-phase dance to do what a unique index on the existing row already does.

**Accepted cost.** Keys persist as long as reply rows, so a retention policy is eventually required (ADR-015). Marginally more write contention than a cache. Both fine. Under A10 this is a single-primary guarantee; multi-region writes would need revisiting.

**Where the cache is used instead:** page-response caching (ADR-003) and per-ConnectedAccount rate-limit token buckets — both tolerate eviction, because the worst case is a redundant platform call rather than a duplicate public post.

---

### ADR-008 — Opaque, versioned cursors owned by this API

**Context.** Platform cursors are heterogeneous (`after` tokens, `next_token`, page tokens, timestamps), vendor-specific, and sometimes expiring. Offset pagination is not available against a proxied read, and would be unstable under insertion regardless.

**Decision.** Emit a base64url-encoded versioned envelope — `{ v: 1, publicationId, platformCursor, pageSize }`. Clients treat it as opaque.

**Decode is validation, not parsing.** Every field is re-validated on the way in, because the envelope is encoded, not signed:
- `v` must match a supported version, else `CallerError / CURSOR_INVALID` → `400`.
- `publicationId` must equal the route parameter, else `400`. This is what stops a cursor from one thread being replayed against another.
- **`pageSize` is re-validated against the same Zod bounds as the query parameter.** It rides inside the envelope so a page sequence stays self-consistent, which means it is caller-controlled and a tampered value would otherwise be an unbounded-page-size resource-exhaustion path. If the request *also* carries `pageSize` and the two disagree, the envelope wins and the query parameter is ignored — changing page size mid-sequence would corrupt the platform's own cursor semantics. Documented in the OpenAPI description.
- `platformCursor` is passed to the adapter as an opaque string and must never be interpolated into a URL path or template by an adapter — it goes in a query-parameter value through the HTTP client's encoder. This is the one field we cannot meaningfully validate, so the containment is at the point of use.

**Expired platform cursors.** A platform rejecting a stale cursor is a *caller-visible pagination failure*, not an upstream outage: the correct client action is to restart pagination, not to retry. Adapters map it to `CallerError / CURSOR_EXPIRED` → `400`, not to `UpstreamRejected` → `409`. Called out because the naive mapping puts it in the upstream family, where it reads as retryable and is not.

**Rejected.**
- *Passing the platform cursor through raw.* Leaks vendor detail into our public contract, and the read-strategy migration in ADR-003 would invalidate every outstanding client cursor. The envelope is what makes that migration non-breaking.
- *Offset / limit.* Not supported upstream, and unstable under concurrent insertion.
- *Signing the cursor.* Rejected: the cursor carries no authorisation, and every request is independently scoped by tenancy (ADR-012), so a tampered cursor yields a decode failure or a scope violation — never access to another tenant's data. Note the precise claim: tampering cannot reach data *in our system*. It can vary `platformCursor`, which is why that field's containment is specified above rather than assumed. Signing would add key management for no additional guarantee.

**Accepted cost.** Trivial encode/decode overhead. Clients cannot construct cursors by hand — which is the intent.

---

### ADR-009 — Reply-to-a-reply collapses on shallow platforms, and the response says so

**Context.** A client may legitimately try to reply to a depth-1 comment on a platform whose `maxThreadDepth` is 1. Three options: reject the request, silently collapse it to the root, or collapse it and disclose.

**Decision.** Collapse and disclose, when `onDepthExceeded = 'collapse'`. Post to the root comment, prefix the body with the target author's mention using the platform's `mentionFormat`, and return `effectiveParentId` (differing from the requested `parentId`) together with `threadCollapsed: true`. Driven entirely by the capability descriptor — no platform check anywhere.

**Reasoning.** This is what the platforms' own clients do, so the published result matches what the audience sees natively.

**The mention needs a handle we must actually possess.** `mentionFormat` renders something like `@handle` or a LinkedIn URN — not a display name. ADR-010's snapshot therefore stores `authorHandle` alongside `authorDisplayName`, and the comment ID envelope (ADR-014) carries it so the write path needs no lookup. Where a platform exposes no stable handle, `mentionFormat` for that platform is `none`, the prefix is omitted, and `threadCollapsed: true` is still returned — the disclosure is the contract, the mention is a nicety.

**Length is validated after the prefix, not before.** The mention is prepended by us and counts against the platform's limit, so a body at exactly `maxReplyLength` would otherwise be rejected upstream after we had already committed a `PENDING` row. Validation order is: resolve collapse → render the final body → check `maxReplyLength` → insert. A body that fits only without its mention fails as `CallerError / REPLY_TOO_LONG` at `422`, carrying both the limit and the rendered length so the client can explain it.

**Rejected.**
- *`400 PLATFORM_DEPTH_EXCEEDED` always.* Pushes platform trivia onto every consumer, which is exactly what this abstraction exists to prevent — and it is wrong on the merits, because the reply *is* possible. Retained as the `onDepthExceeded = 'reject'` branch for any platform where collapsing would be actively misleading.
- *Silent collapse.* Worse than either alternative: the caller's model of the thread diverges from reality with no signal.
- *Relying on a client-side pre-flight capability check.* The capabilities endpoint exists for UI affordances (ADR-005), but the server must be correct without it.

**Accepted cost.** `parentId` in a request is a *request*, not a guarantee. This is a surprising contract, so it is documented loudly in the OpenAPI description rather than buried.

---

### ADR-010 — Author identity is a denormalised snapshot; no author table

**Context.** Comment authors are platform-native identities. We cannot join to them, cannot reliably refresh them, and do not own their lifecycle.

**Decision.** Store `authorPlatformId`, `authorHandle`, `authorDisplayName`, and `authorAvatarUrl` inline on the comment as a snapshot taken at fetch time, plus `isOwnedByUs`, derived by comparing `authorPlatformId` against the publishing ConnectedAccount's platform user ID. `authorHandle` is nullable — not every platform exposes one — and ADR-009 degrades accordingly.

**Rejected.**
- *A normalised `PlatformAuthor` dimension table.* We could never keep it current, and it would exist to deduplicate a display name. It also invites treating a third-party platform identity as a first-class user of our system, which drags in data-retention and GDPR obligations we have no reason to take on.
- *Storing nothing and re-resolving on read.* An extra platform call per distinct author, spending the scarcest resource in the system.

**Accepted cost.** Display names go stale — though "the name as of when the comment was fetched" is arguably the more correct semantic for a comment record. No cross-post "everything this person said" query, which would require the mirror strategy anyway.

---

### ADR-011 — Three-bucket typed error taxonomy, mapped to HTTP at the edge

**Context.** Failures originate from three sources that mean different things and demand different client responses. The trap is the revoked token: the platform returns `401`, and passing that through tells our caller *their* credentials failed — sending them to re-authenticate entirely the wrong thing.

**Decision.** Framework-free domain errors in three families, mapped to HTTP by a single exception filter at the transport boundary:

| Family | Examples | Status |
|---|---|---|
| `CallerError` | validation, unknown publication, malformed or expired cursor, reply too long | 400 / 404 / 422 |
| `SystemError` | our defect, database unavailable | 500 |
| `UpstreamError` | `UpstreamAuthError` — token revoked or expired | 424 |
| | `UpstreamRateLimited` | **503** (+ `Retry-After`) |
| | `UpstreamUnavailable` | 502 |
| | `UpstreamRejected` — comments closed, content blocked, parent gone | 409 |
| | `UpstreamIndeterminate` — timeout, outcome unknown | 202 (write path only, ADR-006) |

Every error carries a stable machine-readable `code`. `UpstreamAuthError` additionally names the ConnectedAccount requiring re-authorisation.

**On `503` rather than `429` for upstream rate limiting.** The earlier draft mapped this to `429`, which contradicts the principle that produced `424` two rows above it. `429 Too Many Requests` means *the caller* sent too many — it triggers client-side backoff against *us*, and well-behaved HTTP clients and gateways act on it automatically. But our caller did nothing wrong and backing off from us does not replenish the platform's bucket. `503 + Retry-After` says what is true: this endpoint cannot serve you right now, here is when to come back. `429` is reserved for our own limiter, where it means what it says. Applying one principle to `401` and its opposite to `429` was the inconsistency; it is resolved in favour of the principle.

**Rejected.**
- *Throwing NestJS `HttpException` from application services.* Dependency Inversion violation — the core would import the framework, and errors would be untestable without HTTP semantics.
- *Passing platform error codes through.* Leaks vendor vocabulary into our contract and breaks whenever a platform revises it.

**Accepted cost.** `424 Failed Dependency` for a revoked token is an unusual choice and needs documenting. It was chosen over `502` deliberately: it signals an actionable state — re-authorise this account — rather than a transient condition the client should retry. Adding a platform introduces no error-mapping code outside that platform's own adapter, which translates vendor errors into this taxonomy.

---

### ADR-012 — Tenancy enforced in the data-access layer via a mandatory scope

**Context.** Every read and write must be scoped to a Workspace that owns the ConnectedAccount. Endpoint guards are forgettable, and the failure mode is severe and silent: a new endpoint ships without one and serves another tenant's comments.

**Decision.** Repository **and cache** methods take a required `TenantScope` value object. No overload omits it, so an unscoped query does not typecheck. A NestJS guard derives the scope from the authenticated principal and passes it explicitly down the call chain; neither the repository nor the cache reaches into request context on its own. The cache is included because it is a second data path out of the system and the original draft's guarantee did not cover it (ADR-003).

**Rejected.**
- *Guard-only enforcement.* Depends on every future author remembering. The failure is silent, cross-tenant, and exactly the class of bug that should be structurally impossible.
- *PostgreSQL row-level security.* Genuinely the strongest option, and named as the hardening step for real multi-tenant scale. Rejected here because it requires per-request `SET LOCAL` of role and claims through Prisma's connection pool, which is fiddly and easy to get subtly wrong when connections are reused — and it would not cover the cache regardless.
- *Implicit `AsyncLocalStorage` context.* Invisible coupling. It makes the scope easy to forget in precisely the way this decision exists to prevent, and it hides the dependency from tests.

**Accepted cost.** Noisier repository signatures. The noise is the point — it is a compile-time reminder at every call site.

---

### ADR-013 — Thread assembly happens in the adapter mapper, not in a query

**Context.** ADR-003 reads from the platform, so the tree a client receives is built from a platform payload, not from our tables. ADR-004 describes the *storage* shape. These are two different problems and conflating them was a real error in the first draft: it justified index design with a query the system does not run, and left the actual response-shaping step unspecified.

**Decision.** Each adapter's mapper is responsible for turning that platform's payload into a canonical `ThreadPage` — a page of root comments, each with its replies attached, plus a next-cursor. Assembly is in-memory over one page and its declared reply set. The application service receives a `ThreadPage` and never learns how it was built.

This is the anti-corruption layer, and it is where the two chosen platforms differ most:
- **LinkedIn** returns comments and replies as distinct, separately-paginated resources. The mapper pages roots, then fetches replies for that page, and assembles. Depth is capped by the platform at 1.
- **X** returns a flat conversation where a reply is itself a post carrying `in_reply_to`. The mapper builds the parent map, roots it at the publication's own post, computes `depth` and `rootId` by walking that map, and flattens anything beyond `maxThreadDepth` into an ordered descendant list (ADR-004's accepted cost).

**Rejected.**
- *Assembling in the application service.* It would need to know how each platform's payload nests — a `switch (platform)` in the worst possible place, and the exact failure ADR-001 exists to prevent.
- *Returning a flat list and letting the client build the tree.* Pushes the same platform-shaped problem across the network to every consumer, and makes `depth` unverifiable.
- *An abstract base mapper with a template method for the differences.* The two shapes above share no meaningful structure — the similarity is that both produce a `ThreadPage`, which is the interface, not shared code. Composition over an inheritance hierarchy; wait for a third case.

**Consequence — this is what the contract test suite pins.** Every adapter is run against the same suite asserting `ThreadPage` invariants: roots have `depth = 0` and null `rootId`; every non-root's `rootId` resolves within the page; no `depth` exceeds the declared `maxThreadDepth`; ordering matches `paginationDirection`; the next-cursor round-trips. If an adapter needs the suite bent, the port is wrong.

**Accepted cost.** Reply-fetching per root page is an N+1 *against the platform* for platforms shaped like LinkedIn. Bounded by page size, executed concurrently with a per-account concurrency cap, and covered by the ADR-003 cache. If it becomes the dominant cost, that is a strong signal to revisit ADR-003 rather than to optimise the mapper.

---

### ADR-014 — Comment IDs are opaque, self-describing envelopes

**Context.** This is the gap that ADR-003 opens and nothing in the first draft closed. Under a proxy read, a client reads a thread it never persisted, then posts `parentId` back at us. What is that identifier? Every obvious answer breaks something:

- **Our own UUID** — requires a local row for every comment we serve, contradicting ADR-003's "persist only what we have interacted with".
- **The platform-native ID, raw** — leaks vendor identifiers into our public contract, the one thing the abstraction exists to prevent, and it is not unique across platforms.
- **Persist every served comment to mint UUIDs** — quietly reintroduces the mirror's write volume with none of its benefits, and makes every read a write.

**Decision.** The comment ID in our API is a base64url envelope, the same pattern as ADR-008:

```ts
type CommentRef =
  | { v: 1; k: 'platform'; p: PublicationId; id: string; d: number; h?: string }
  | { v: 1; k: 'local';    p: PublicationId; id: LocalReplyId };
```

`k: 'platform'` names a comment that exists upstream; `k: 'local'` names one of our own replies that has no platform ID yet (`PENDING` or `UNKNOWN`, ADR-006). `d` is depth and `h` the author handle, carried so the write path can evaluate ADR-009's collapse and render its mention **without a lookup or a platform round trip**.

Resolution on write: decode → if `local`, load the row under `TenantScope`; if `platform`, look up `(publicationId, platformCommentId)`, and on miss materialise a minimal parent row from the envelope in the same transaction that inserts the reply. That is what makes ADR-006's "insert then commit then call" possible for a parent we have never seen.

**On carrying `d` and `h` in a client-supplied token.** Both are tamperable. Neither is a security boundary: `h` is a public handle the caller just read, and a forged `d` at worst suppresses a collapse we would have performed, after which the platform rejects the reply and we return `UpstreamRejected`. No cross-tenant reach — `p` is validated against the route and the route is scoped (ADR-012). The alternative, re-fetching the comment from the platform on every reply, spends the scarcest resource in the system to defend against a caller lying about their own reply's indentation.

**Rejected.** The three options in the context, above.

**Accepted cost.** Comment IDs are long and not human-readable, and `d`/`h` are a point-in-time snapshot like everything else in ADR-010. Under a future mirror, `k: 'platform'` resolution becomes a plain indexed lookup that always hits — the envelope format does not change, so IDs already held by clients keep working. That is the same non-breaking property ADR-008 buys for cursors, and the reason both are envelopes rather than raw values.

---

### ADR-015 — Idempotency record lifecycle: keys are released on determinate failure

**Context.** ADR-007 puts `UNIQUE (connectedAccountId, idempotencyKey)` on the reply row, and ADR-006 writes that row *before* the platform call. So a row exists for replies that were never posted. A client that receives `502` and retries with the same key — textbook correct behaviour — would collide with a record of a comment that does not exist. The first draft left this undefined; taken literally it made retry-after-failure impossible, which inverts the purpose of an idempotency key.

**Decision.** Replay behaviour is a function of `deliveryState`:

| State on replay | Response | Rationale |
|---|---|---|
| `SENT` | `200` + the existing comment | The canonical idempotent replay. Not `201` — we created nothing this time. |
| `PENDING` | `409 REPLY_IN_FLIGHT` + `Retry-After: 1` | A concurrent duplicate. Not a failure and not a success; the client should wait and re-read. |
| `UNKNOWN` | `202` + the status resource | Same body as the original response. Never retried automatically — this is the one state where a retry can duplicate a public comment. |
| `FAILED` | The key is **released** and the request proceeds as new | The determinate case: we know nothing was posted, so there is nothing to deduplicate against. |

Release is implemented by nulling `idempotencyKey` on transition to `FAILED`, inside the same transaction that sets the state. The unique index is partial — `WHERE idempotencyKey IS NOT NULL` — so released rows are retained for audit without occupying the key. The failed attempt stays queryable; it simply stops being an obstacle.

**Rejected.**
- *Hard-delete the row on failure.* Loses the audit trail of an attempt to publish under the customer's name, which is precisely the record ADR-006 exists to guarantee.
- *Keep the key and return the stored failure forever.* Makes the key single-use-per-outcome and forces clients to mint a new key to retry — at which point the key protects nothing, because a retry is indistinguishable from a new reply.
- *TTL-based expiry of keys.* Reintroduces the durability question ADR-007 settled, and picks an arbitrary window during which a legitimate retry is refused.

**Accepted cost.** `FAILED` rows accumulate; retention is a scheduled cleanup, not a correctness concern. The `PENDING` → `409` case means a client retrying too eagerly gets a conflict rather than an answer — correct, but it does require clients to honour `Retry-After` rather than tight-looping.

---

### ADR-016 — Native platform metadata in JSONB, write-only to the API boundary

**Context.** Platforms carry fields with no canonical equivalent: reaction breakdowns, `is_pinned`, edit history markers, LinkedIn URNs, X `conversation_id`. Discarding them makes debugging an integration guesswork and forecloses features. Promoting each to a column means the schema changes every time a platform does — a direct Open/Closed violation.

**Decision.** `Comment.platformMetadata Jsonb` holds a **mapper-curated** subset of native fields, keyed by names the adapter chooses. Two rules make it safe:

1. **It is never serialised into an API response.** The response DTO is built from canonical fields only; `platformMetadata` is not in the DTO type, so leaking it is a compile error rather than a review catch. This is the containment for the stated failure mode "raw platform payloads leaking into API responses".
2. **Nothing outside the owning adapter reads it.** Domain and application code that branched on a JSONB key would be a `switch (platform)` wearing a disguise. If a value needs to reach a caller, it gets promoted to a canonical field or a capability — a deliberate act, reviewed as such.

**Rejected.**
- *Storing the entire raw payload.* Unbounded row growth, and it silently ingests personal data we have no basis to retain. Curated subsets keep the retention question answerable.
- *A typed column per platform-specific field.* Schema churn per platform; fails OCP.
- *Discarding native fields entirely.* Simplest, and genuinely tempting under ADR-003 where few rows exist — rejected because the fields cost nothing to keep on rows we are already writing, and their absence is only discovered during an incident.

**Accepted cost.** JSONB is unvalidated by the database; each adapter owns a Zod schema for its own metadata shape and parses on read. Queryability is not claimed — no GIN index in this slice, because nothing queries it.

---

### ADR-017 — Shallow health check; readiness never probes a platform

**Context.** `GET /api/v1/health` is required. The question is what it asserts, and the tempting answer — check everything we depend on — is wrong here.

**Decision.** Two concerns, one path:
- `GET /api/v1/health` — liveness. Process is up and serving. No dependency checks, no auth. This is what the container orchestrator restarts on.
- `GET /api/v1/health/ready` — readiness. Checks PostgreSQL (`SELECT 1`) and Dragonfly (`PING`), each with a hard 1s timeout, and reports per-dependency status. Dragonfly being down reports `degraded`, not `unhealthy`: by ADR-003 the cache is an optimisation and the system is correct without it.

**Neither endpoint contacts a social platform.** A deep check would make our health a function of theirs — an outage at one platform would fail our readiness probe, pull healthy instances out of rotation, and take down comment reads for every *other* platform. It would also burn per-account rate limit on a timer, forever, in exchange for information no orchestrator can act on. Platform reachability is a monitoring and alerting concern, not a liveness one.

**Rejected.**
- *One endpoint doing both.* Restarting a container because Postgres blipped is worse than serving errors from a live one.
- *Deep health checks including platform reachability.* Above.
- *Readiness failing when Dragonfly is down.* Conflates degraded with broken.

**Accepted cost.** A green readiness probe does not mean replies will succeed — only that we can accept the request and report a failure properly. That is the honest guarantee.

---

## Deliberately deferred

Not decided here, and not by omission. Each is named in `DESIGN.md` with a sentence on the intended direction.

- **Rate-limit handling** — per-ConnectedAccount token buckets in Dragonfly; the eviction-tolerant use of the cache. Exhaustion surfaces as `UpstreamRateLimited` (ADR-011).
- **Token refresh and revocation** — by A3 the refresh cycle is owned elsewhere in the product. This feature detects failure and reports `UpstreamAuthError` naming the account. If A3 is false, refresh-on-401-with-one-retry belongs inside each adapter's HTTP client, and this becomes a required ADR rather than a deferral.
- **Retry, backoff, dead-lettering** — arrives with the async write path (ADR-006's rejected alternative). Note that `UNKNOWN` records are explicitly *excluded* from any automatic retry (ADR-015).
- **Historical backfill and webhook ingestion** — arrives with the mirror strategy (ADR-003); the schema (ADR-004) and both identifier envelopes (ADR-008, ADR-014) are already shaped for it.
- **Upstream edits and deletions.** *This is the one hard problem in the brief answered with a deferral rather than a decision, so the reasoning is stated rather than assumed.* Under the proxy strategy an upstream edit or delete is self-correcting for reads — the next fetch simply reflects it, at worst 60s late. It matters only for the sparse rows we hold: a reply of ours whose parent was deleted. Today that surfaces at write time as `UpstreamRejected` (ADR-006), which is the correct caller-facing behaviour. What is genuinely undecided is the *tombstone* semantics a mirror needs — whether a platform `404` on a row we hold means soft-delete, hard-delete, or unknown, and how that interacts with a reply we published beneath it. That question has no good answer until there is an ingestion path to raise it, and inventing one now would be a decision with no consumer.
- **Moderation: hide, delete, report** — outside the brief's two use cases.
