# Task overview
You are an expert Backend & System Design Engineer. We are building a multi-platform comment management module inside a Social Media Scheduling API (CRUD). Greenfield.

The system currently manages published posts across multiple social networks and must support fetching comments and replying to comments via REST API, with an extensible architecture to add future platforms easily.

---

# Functional requirements:
1. **Retrieve Comments:** Fetch top-level comments and nested replies for a given published post (with pagination and optional refresh from social platform API).
2. **Reply to Comment:** Submit a reply to a specific comment (supporting both top-level and nested replies where the platform allows).
3. **Multi-Platform Extensibility:** Adding a new social platform in the future must only require creating a new adapter class without changing core business logic or REST endpoints.
4. **Background sync:** Comments need to be synchronized in the background with local in-memory DB caching.
4. **REST API Exposure:** Expose endpoints for listing comments and posting replies. (Personally, I'd use GraphQL instead of REST but you explicitly stated REST API).

# Tech stack and constraints:
- **Language:** TypeScript (in Strict Mode)
- **Database:** PostgreSQL
- **ORM:** Prisma
- **Backend:** NestJS. (I'd prefer Java + Spring for backend but you mentioned TypeScript, so here it is). DragonflyDB for caching.
- **Validation:** Zod
- **Plus:** Swagger

# Architectural guidance:
- **Adapter / Strategy Pattern:** Define a unified `SocialPlatformAdapter` interface (`fetchComments()`, `postReply()`). Implement concrete adapters for at least two sample platforms (`FacebookAdapter`, `LinkedInAdapter`).
- **Normalized Storage vs Native Metadata:** Store unified comment fields (ID, author, text, timestamps, platform reference) in the primary DB, using a JSONB column for platform-specific metadata (native IDs, platform-specific reaction counts and others).
- **Threading Model:** Implement a clear comment hierarchy approach (Adjacency List) suitable for social comment threads.
- **Async & Resilience Considerations:** Document how rate limits, access token expiration, and external API failures are handled as most of this is platform-specific.
- **Other patterns:** Hexagonal architecture. Materialized Path for comment threading.

---

# Required deliverables:
### 1. Database Schema
- Complete relational schema (ORM schema definition).
- Indexing strategy for high-performance lookup of comments by post ID and parent comment ID.
- Schema support for multi-platform ID mapping (internal UUID vs. external platform ID).

### 2. API Specification (REST)
- OpenAPI (Swagger) generated report in HTML.
- Error handling schema (handling platform rate limits, token errors, network failures).

### 3. Production-Ready TypeScript Implementation
Provide actual, clean TypeScript code for:
- Core domain models & `SocialPlatformAdapter` interface.
- Sample platform adapters (`LinkedInPlatformAdapter`, `TwitterPlatformAdapter`).
- `CommentService` containing business logic for fetching and posting.
- REST API Controller / Route Handlers with request validation (Zod).

### 4. Additional notes
- DB and Backend need to run in a separate container, on same network within Docker.
- Expose a health check endpoint - GET /api/v1/health/.

# Skills to use:
-- **r4-grill-me**
-- **r4-create-db-migration**
-- **r4-generate-api-route**
-- **r4-security-audit**
-- **simplify**

---

Conceptualize first. Prepare a plan before touching any files/implementing anything.

Runner: /model claude-opus-5 /effort max