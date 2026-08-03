-- Indexes Prisma's schema language cannot express. Applied by `npm run db:push` immediately
-- after `prisma db push`, and by the api container's start command.

-- ADR-007 / ADR-015. Deduplicates reply creation per connected account, and stops occupying the
-- key the moment a reply transitions to FAILED (the release is a NULL write, and a partial index
-- does not index NULL rows at all). Retaining the failed row for audit is therefore free.
CREATE UNIQUE INDEX IF NOT EXISTS "Comment_connectedAccountId_idempotencyKey_key"
    ON "Comment" ("connectedAccountId", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;
