# Implementation Prompt — Multi-Platform Comment System

## 0. Context

You are implementing a take-home engineering exercise. The repository is empty (git initialised, no commits, branch `master`).

**Critical framing:** the person reviewing this output has stated they are evaluating *reasoning and engineering decisions*, not feature completeness and not a match against their own implementation. Optimise every choice for demonstrated judgement. A smaller amount of code with sharp, defended decisions beats a large scaffold. Volume of files is a negative signal here, not a positive one.

## 1. The brief, verbatim

> You are working on a social media scheduling API that supports multiple social platforms.
>
> Design and partially implement a comment system.
>
> Requirements:
> * Retrieve comments for a published post
> * Reply to a comment
> * Support multiple social platforms
> * Expose the functionality through a REST API
>
> Please provide:
> * Database schema
> * API design
> * Relevant TypeScript code
> * Explanation of major design decisions
>
> The system currently supports multiple social platforms and is expected to support more in the future.
>
> The requirements intentionally leave some details unspecified. Document any assumptions you make.

Note the exact wording of the two use cases. Retrieve comments **for a published post**. Reply **to a comment**. Do not silently widen this into a full moderation suite, a unified cross-post inbox, sentiment analysis, or comment deletion. Where the schema should obviously not *preclude* those, say so in one line and move on. Scope discipline is part of what is being assessed.

## 2. Tech stack (fixed — do not re-litigate)

- **Language:** TypeScript, `strict: true` (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- **Backend:** NestJS
- **Database:** PostgreSQL
- **ORM:** Prisma
- **Cache:** DragonflyDB (Redis wire-compatible)
- **Validation:** Zod
- **API docs:** Swagger / OpenAPI

Record in the design doc that a Java + Spring stack would have been the author's preference and that TypeScript was mandated by the brief — one sentence, not a digression.

On DragonflyDB specifically: **do not use it decoratively.** Either identify jobs where a cache genuinely changes the design and justify each, or state that caching is deferred and why. Candidate jobs worth evaluating (pick what survives scrutiny, reject the rest out loud): platform response caching keyed by page cursor; idempotency-key records; per-connected-account rate-limit token buckets. Note explicitly that a cache is *not* durable storage, and say which of those jobs can tolerate eviction and which cannot.

## 2a. Reconciling `TASK.md` with the verbatim brief

`TASK.md` is a superset of the brief in §1: it restates the reviewer's requirements and adds constraints of its own. Where the two differ, the resolution is recorded here rather than silently taken. **Nothing below is dropped by oversight; anything not listed is in scope.**

**In scope, restored — these were requirements, not decoration:**

| `TASK.md` | Resolution |
|---|---|
| Docker: DB and backend in separate containers on one network (line 50) | **Build it.** A `docker-compose.yml` with `api`, `postgres` and `dragonfly` on one network is ~30 lines and is the difference between a reviewer running this and reading it. The earlier "no Docker" instruction was a false economy — it was aimed at scaffolding bloat, and compose is not bloat. Does not count against the file ceiling. |
| `GET /api/v1/health/` (line 51) | **Build it**, per ADR-017: shallow liveness plus a separate readiness probe. The ADR exists because "check everything" is the wrong answer and that is worth demonstrating. |
| JSONB column for platform-native metadata (line 25) | **Build it**, per ADR-016. Note the tension the brief creates with it — a raw-payload column is one careless DTO away from being the "platform payloads leaking into responses" failure mode in §6 — and resolve it structurally. |
| `/api/v1` route prefix (line 51 implies it) | **Adopt it globally.** ADR-002's routes are versioned accordingly. |
| OpenAPI HTML output (line 39) | **One npm script** that emits the Swagger JSON and a self-contained HTML page from the running Nest app. It is a script, not a document; do not hand-write the spec. |

**Out of scope, with the reasoning stated rather than assumed:**

- **Background sync (line 12)** is a stated functional requirement and it is being **deliberately overridden**, not overlooked. ADR-003 chooses a cache-through proxy and defers mirroring; ADR-003's "Migration path" section and the deferred-items list carry the justification. This must be called out explicitly in `DESIGN.md` — an unacknowledged deviation from a stated requirement reads as a miss, and the whole value of the decision is in having made it on purpose. If the reviewer's own priority is the mirror, that disagreement should be legible and arguable, not hidden.
- **Materialised Path for threading (line 28)** conflicts with *Adjacency List* at line 26 of the same document. Adjacency list wins; ADR-004 records the rejection on read-pattern grounds and flags the deviation.
- **The `r4-*` skills (lines 53–58)** are not installed in this environment. `grill-me` and `simplify` are, and both are genuinely useful here — grill the plan before writing code, simplify the tree after. `r4-create-db-migration` also conflicts with §3's "no generated migrations"; keep `schema.prisma`, skip the generated migration files, and say so.

**Platform selection — `TASK.md` names two different pairs and neither instance is authoritative on its own.** Line 24 says Facebook + LinkedIn; line 45 says LinkedIn + Twitter. **Resolved as LinkedIn + X (Twitter)**, which satisfies line 45 exactly and line 24 partially, and — the actual reason — is the pair that maximises structural dissimilarity per §4. LinkedIn's native model is shallow (one level of replies, cursor-paginated, comments as a distinct resource type); on X a reply *is* a post, so a "comment" is a synthetic concept over a flat conversation graph with unbounded depth. Facebook + LinkedIn are both shallow parent/child models and would prove almost nothing about the abstraction — an adapter pair that agrees is not a test of a port. Record this choice and this reasoning in `DESIGN.md`; the ADR-013 mapper contrast is where it pays off.

## 3. Deliverable shape

Three artefacts:

**`ADRS.md`** — the decision record. Already written; it is the substrate the other two draw on, not a summary of them. It holds the numbered assumptions (`A1`–`A10`), the vocabulary, and 17 records. Keep it as the single home for decision detail so `DESIGN.md` can stay short.

**`DESIGN.md`** — the primary narrative deliverable. **1,800–2,500 words**, and it may cite `ADRS.md` by record number instead of restating. The original 1,200–2,000 budget did not close: eight sections including a full Prisma schema, a complete API contract, and 5–8 decision records cannot fit it, and the predictable failure is a padded skeleton that satisfies the outline and says nothing. Prefer the low end. Required sections:

1. **Assumptions** — reproduce the `A1`–`A10` table from `ADRS.md` verbatim; it is short and it is the first thing a reviewer needs. Each is a real fork in the road with the decision it would flip. Not "I assume PostgreSQL."
2. **Scope** — a three-column statement of what is fully built, what is stubbed with real type signatures, and what is design-only.
3. **Domain model** — the canonical entities and the vocabulary, deliberately named. This is a domain that suffers badly from ambiguous terms (post / publication / comment / reply / thread / author).
4. **Database schema** — the Prisma schema, plus a short rationale for each non-obvious index, unique constraint, and nullable column. Two constraints must be called out by name: `UNIQUE (publicationId, platformCommentId)`, which makes ingestion idempotent and is what lets ADR-014 resolve a platform-keyed comment reference and lets a future mirror re-ingest without duplicating; and the **partial** `UNIQUE (connectedAccountId, idempotencyKey) WHERE idempotencyKey IS NOT NULL`, whose partiality is exactly what ADR-015's key-release depends on.
5. **Key decisions** — the **nine** records marked *Core* in `ADRS.md`, in the compressed format *Decision / Why / Alternatives rejected and why / Consequences accepted*. Summarise each in a short paragraph and cite the ADR number for the full record — do not paste all seventeen, and do not re-derive them. Nine deliberately exceeds the 5–8 band this section originally specified: the two records added to close the ADR-003/004 contradiction and the comment-identity gap (013, 014) are both load-bearing, and cutting one to hit a number would remove a decision rather than a description. This section carries most of the evaluation weight. An entry with no rejected alternative is not a decision, it is a description.
6. **API design** — endpoints, request and response shapes, status codes, error taxonomy, pagination contract, idempotency contract.
7. **Adding platform #7** — a concrete numbered checklist of every file a new platform requires. If that list contains any file outside the new platform's own directory plus one registry line, the abstraction has failed and should be reworked before submission.
8. **Known gaps / what I would do next** — honest, brief.

**A focused TypeScript source tree.** It must typecheck under `tsc --noEmit` and the unit tests must pass.

*On the budget.* The original "12–18 files, hard ceiling 20" did not survive contact with §4 and §6 of this same document, which between them mandate: framework-free domain types, three ports, an error taxonomy, a tenant scope, an application service, two codecs, a registry, **two adapters each split into transport / payload schema / mapper because §6 forbids fusing them**, a Prisma repository, a cache adapter, a controller, DTOs, an exception filter, a guard, a health controller, and module wiring. That enumerates to roughly 26 before a single test. A ceiling of 20 could only be met by violating the Single Responsibility rule the ceiling sits next to — and the resolution is to fix the number, not to quietly blow past it and hope nobody counts.

Revised budget, checkable:

- **24–30 source files**, excluding tests, config, and `docker-compose.yml`.
- **Tests are not counted**, but they are not unlimited either: the shared adapter contract suite, mapper tests per adapter, the two codecs, and the idempotency lifecycle. Five or six files.
- Config, `docker-compose.yml`, `schema.prisma`, and the OpenAPI export script are outside both counts.

The original intent stands and is what actually matters: **volume is a negative signal.** No generated migrations, no seed scripts, no CI config, no README beyond a few lines and how to run compose. If you find yourself generating a file that exists only to look complete, don't — and if the tree lands above 30, that is a real signal to look for an abstraction that is not paying rent, not a licence to raise the number again.

## 4. What to build deeply vs. stub vs. describe

**Build for real:**
- Canonical domain types and the platform-agnostic comment/thread model
- The platform provider port, its capability model, and the registry that resolves it
- **Two** platform adapters — **LinkedIn and X (Twitter)**, selected in §2a for structural dissimilarity: LinkedIn's native model is shallow (one level of replies, cursor-paginated, comments as their own resource), X's is arbitrary-depth (a reply is itself a post, so "comment" is synthetic over a flat conversation graph). Picking two similar platforms proves nothing about the abstraction. Each adapter is three files — HTTP transport, payload schema, mapper — because §6 forbids one class doing all three. Adapters talk to an injected HTTP client interface; no real network calls.
- The application service for the two use cases
- Repository port + one Prisma-backed implementation
- Cache port + one Dragonfly implementation, taking `TenantScope` (ADR-003, ADR-012)
- NestJS controller, Zod-validated DTOs, Swagger decoration, error mapping
- The health and readiness controller (ADR-017) — small, but it is a stated requirement and it encodes a real decision
- `GET /api/v1/replies/{replyId}` — the delivery-status resource. Not optional: ADR-006 returns `202` pointing at it, so omitting it leaves a dangling `Location` header
- **Both** codecs — the cursor (ADR-008) and the comment reference (ADR-014) — and the error taxonomy
- Tests: a **shared contract test suite that every adapter implementation is run against** (this is the Liskov check and is worth more than any other test), plus unit tests for the mapping layer, the cursor codec, and the idempotency logic.

**Stub with real signatures and a typed `NotImplementedError`:** remaining platforms, webhook ingestion, background reconciliation jobs.

**Describe in `DESIGN.md` only, a paragraph each at most:** rate-limit handling strategy, retry/backoff and dead-lettering, historical backfill, token refresh and revocation.

## 5. The hard problems

These are the places where this exercise separates a considered design from a generated one. Resolve each explicitly; several belong in the ADR section. **Do not treat the framing below as the answer** — some of these have more than one defensible resolution, and the defence is what is being graded.

*Status:* all ten are now resolved in `ADRS.md` — 1→002, 2→003, 3→004/009/013, 4→005, 5→006/007/015, 6→008, 7→010/014, 8→011, 9→012, 10→deferred **with its reasoning written out** rather than left off the list. Problem 10 is the single deferral and is flagged as such; a deferral that explains why the question has no consumer yet is a defensible answer, a deferral that just appears in a bullet list is not.

1. **What does a comment actually attach to?** In a scheduling product, one scheduled post can fan out to several platforms and several connected accounts, each receiving its own platform-native post ID. Work out what the correct parent of a comment is, and what that implies for the route shape. Getting this wrong is the single most likely modelling error in this exercise.
2. **Read strategy.** Live pass-through to the platform on every request, versus mirroring comments locally via webhook/polling ingestion, versus a cache-through hybrid. Each has a different failure mode, freshness guarantee, and pagination story. Pick one, justify it against the assumptions you declared, and show that the schema does not foreclose migrating to another.
3. **Reconciling thread shapes.** Platforms disagree on nesting: some allow exactly one level of replies, some two, some unbounded chains. Decide how the canonical model represents this (adjacency list with depth, materialised path, closure table — with the read patterns as the deciding factor). Then answer the sharp follow-up: what happens when a client asks to *reply to a reply* on a platform that only supports one level? That is a real product behaviour, not an error case to hand-wave.
4. **Expressing platform differences without conditionals.** Capability descriptors as data, versus optional methods on one interface, versus narrower sub-interfaces. Whichever you choose, the test is that no `switch`/`if` on platform identity exists anywhere outside the registry and the adapters themselves.
5. **Replying is a non-idempotent side effect on a third party.** A client retry, or a network timeout where you never learn whether the write landed, must not produce a duplicate public comment. Design the idempotency contract, the local record lifecycle, and how the platform-assigned ID is reconciled back. Decide sync-versus-async (`201` with the created resource, versus `202` plus a status resource) and defend it — the failure characteristics differ substantially.
6. **Pagination.** Platform cursors are heterogeneous, opaque, and vendor-specific. Offset pagination is not available to you on a proxied read. Decide what your API exposes, and make sure a change of read strategy does not break existing clients' cursors.
7. **Identity.** Comment authors are platform-native identities, not users of this product; you cannot join to a users table you don't own. Decide what is stored, what is snapshotted, and how "this reply was written by us" is represented.
8. **Error semantics across a trust boundary.** A revoked or expired platform token produces a 401 from the platform. Your API must not return 401 to *its* caller — that means something entirely different. Build a typed error taxonomy that distinguishes caller error, this system's failure, and upstream platform failure, and map each to a deliberate status code.
9. **Tenancy and authorisation.** Every read and write is scoped to a workspace and to a connected account that workspace owns. State where that check lives so it cannot be forgotten on a new endpoint, and note the IDOR risk if it is left to individual handlers.
10. **Upstream mutation.** Comments get edited and deleted on the platform after you have seen them. Decide the tombstone semantics and what a 404 from the platform means for a row you already hold.

## 6. Quality bar — operationalised

The named principles are checked as concrete, verifiable properties, not as vocabulary. Do not name-drop a pattern in prose; demonstrate it in structure.

- **Open/Closed:** adding a platform touches exactly one new directory plus one registry registration. Nothing in the domain layer, application services, controllers, DTOs, or database schema changes. Assert this invariant in `DESIGN.md` §7 and verify it is actually true of the code you wrote.
- **Liskov:** every adapter passes the same contract test suite. If one adapter needs the suite bent for it, the port is wrong.
- **Interface Segregation:** no port with a dozen optional methods and `supportsX(): boolean` guards. If two capabilities are genuinely independent, they are two interfaces.
- **Dependency Inversion:** domain and application layers import nothing from `@prisma/client`, `@nestjs/*`, `ioredis`, or any platform SDK. Framework and persistence live at the edges. This is mechanically checkable — check it.
- **Single Responsibility:** payload mapping (the anti-corruption layer), HTTP transport, and use-case orchestration are three separate things. A `PlatformService` that does all three is the failure mode.
- **DRY, correctly understood:** DRY applies to knowledge, not to syntax. Two adapters with similar-looking mapping code for unrelated reasons should stay duplicated. Do not introduce an abstract base adapter class to share code — prefer composition, and wait for a third case before extracting.
- **KISS, with teeth:** every abstraction must pay rent. If you introduce an interface, name its second implementation — real or concretely near-term — in `DESIGN.md`. If you cannot, delete the interface. Explicitly out of bounds: event sourcing, a CQRS read/write split, microservice decomposition, a generic runtime plugin loader, a bespoke DI container. If you believe one of those genuinely earns its place, you may use it — but justify it in a full ADR entry.

**Failure modes to actively avoid:**
- `switch (platform)` anywhere in domain, application, or transport code
- raw platform payloads, platform cursors, or platform-specific fields leaking into API responses
- an inheritance hierarchy of adapters with protected template-method hooks
- an N+1 *database* query when loading a thread, or an unbounded nested `include` in Prisma. Note this is about our datastore: ADR-013 accepts a bounded, concurrency-capped N+1 *against the platform* for LinkedIn-shaped APIs, because their reply resource is separately paginated and there is no batch endpoint. That is a property of their API, not a defect in ours — but it must be bounded by page size, capped in concurrency, and named in `DESIGN.md`, not discovered
- **an outbound HTTP call to a platform held inside an open database transaction**
- a port defined for a single implementation with speculative methods no caller uses
- assumptions listed as decoration rather than as things that actually shaped the design

## 7. Process

1. **Plan first.** Before writing any code, output: the numbered assumption list, the chosen answer to each of the ten hard problems in §5 (one or two sentences each), the two platforms selected and *why those two*, and the proposed file tree. **Then stop and wait for approval.**

   *Status:* three of the four exist — assumptions `A1`–`A10` and all ten answers are in `ADRS.md`, platforms are settled in §2a. **Only the file tree is outstanding, and it is the one still worth gating on**, because §3's revised budget is where this design is most likely to sprawl. Present the tree with a file count against that budget, and stop there.
2. After approval, write `DESIGN.md` first, then the code, so the code follows the design rather than the reverse.
3. Run `tsc --noEmit` and the test suite. Report real results — if something fails, say so and show the output. Bring the stack up with `docker compose up` and hit `/api/v1/health/ready` at least once: a compose file that has never been run is worse than no compose file, because it asserts something unverified.
4. **Self-review pass.** Re-read your own output against §6 as a checklist and state, item by item, whether it holds. If the "adding platform #7" checklist touches a file it shouldn't, fix the design rather than softening the claim. Report anything you could not satisfy instead of quietly dropping it.

Write the code the way a senior engineer writes code they expect to be read: comments explain *why*, never *what*; names come from the domain vocabulary you defined; no dead abstractions left behind.
