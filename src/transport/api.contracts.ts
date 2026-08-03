import { ApiProperty, DocumentBuilder } from '@nestjs/swagger';
import { z } from 'zod';
import type { CanonicalComment, ThreadPage } from '../domain/comment';
import { CallerError } from '../domain/errors';
import { encodeCommentRef, PAGE_SIZE_MAX, PAGE_SIZE_MIN } from '../domain/envelope.codec';
import type { PublicationId } from '../domain/ids';
import type { PlatformCapabilities } from '../application/ports/comment-provider.port';
import type { ReplyRecord } from '../application/ports/comment-repository.port';

/**
 * The public contract: request validation, response shapes, and the mapping from canonical types
 * to the wire.
 *
 * Both halves live together because they are one thing — the API's surface — and splitting them
 * across files means a change to a response shape and its documentation are two edits in two
 * places. Note what is *not* here: no `platformMetadata`, no platform cursor, no vendor field
 * name. ADR-016's containment is that the DTO types have no such member, so leaking one is a
 * compile error rather than something a reviewer has to catch.
 */

/**
 * Lives here rather than in `main.ts` so that exporting the spec does not have to import the
 * bootstrap file — importing a module for its constant should not start a server.
 */
export const swaggerConfig = new DocumentBuilder()
  .setTitle('Multi-platform comments')
  .setDescription(
    'Retrieve the comment thread for a published post, and reply to a comment, across multiple social platforms.\n\n' +
      'Two contracts are unusual enough to state up front:\n\n' +
      "1. **A reply's parentId is a request, not a guarantee.** Platforms disagree about nesting; where one cannot accept a reply at the requested depth, the reply is collapsed onto the thread root with a mention prefix and the response discloses it.\n" +
      '2. **Replies can answer 202.** A platform that never responds leaves the outcome genuinely unknown. Rather than assert a comment exists or invite a duplicate-producing retry, the API returns 202 with a delivery-status resource.\n\n' +
      'All identifiers issued by this API — comment IDs and page cursors — are opaque and versioned. They are not platform identifiers and must be passed back verbatim.',
  )
  .setVersion('1')
  .addGlobalParameters({
    name: 'x-workspace-id',
    in: 'header',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  .build();

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export const parseOrThrow = <S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  code: string,
): z.infer<S> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw CallerError.invalid(code, 'The request is invalid.', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
};

export const uuidParamSchema = z.string().uuid();

export const listCommentsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  // Coerced because query parameters are strings. Bounded by the same constants the cursor
  // envelope re-validates against — one rule, one place (ADR-008).
  pageSize: z.coerce.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX).optional(),
});

export const postReplyBodySchema = z.object({
  /**
   * Bounded generously here and checked properly against the platform's own limit later, after
   * the collapse mention has been rendered (ADR-009). This bound only stops an absurd payload.
   */
  body: z.string().trim().min(1).max(10_000),
});

export const idempotencyKeySchema = z.string().min(8).max(255).optional();

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export class AuthorDto {
  @ApiProperty({ nullable: true, description: 'Platform handle; null where the platform has none.' })
  handle!: string | null;

  @ApiProperty({ description: 'As at the time the comment was fetched — a snapshot, not a live join.' })
  displayName!: string;

  @ApiProperty({ nullable: true })
  avatarUrl!: string | null;
}

export class CommentDto {
  @ApiProperty({
    description:
      'Opaque, versioned identifier issued by this API. Not a platform ID. Pass it back verbatim to reply to this comment.',
  })
  id!: string;

  @ApiProperty({ nullable: true })
  parentId!: string | null;

  @ApiProperty({ description: '0 for a top-level comment.' })
  depth!: number;

  @ApiProperty()
  body!: string;

  @ApiProperty({ type: () => AuthorDto })
  author!: AuthorDto;

  @ApiProperty({ description: 'True when this comment was published by the connected account.' })
  isOwnedByUs!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: () => [CommentDto], description: 'Populated on top-level comments only.' })
  replies!: CommentDto[];
}

export class PageInfoDto {
  @ApiProperty({
    nullable: true,
    description: 'Opaque cursor for the next page, or null at the end of the thread.',
  })
  nextCursor!: string | null;
}

export class ThreadPageDto {
  @ApiProperty({ type: () => [CommentDto] })
  comments!: CommentDto[];

  @ApiProperty({ type: () => PageInfoDto })
  pageInfo!: PageInfoDto;
}

export class CapabilitiesDto {
  @ApiProperty({ description: '1 means a root comment plus one level of replies.' })
  maxThreadDepth!: number;

  @ApiProperty({ description: 'Measured in graphemes, after any mention prefix this API adds.' })
  maxReplyLength!: number;

  @ApiProperty({
    enum: ['collapse', 'reject'],
    description:
      'What happens to a reply deeper than maxThreadDepth. "collapse" re-points it at the thread root and discloses it.',
  })
  onDepthExceeded!: 'collapse' | 'reject';

  @ApiProperty({ enum: ['newest-first', 'oldest-first'] })
  paginationDirection!: 'newest-first' | 'oldest-first';
}

export class ReplyDto {
  @ApiProperty({ description: 'Identifier of the delivery record: GET /api/v1/replies/{replyId}.' })
  replyId!: string;

  @ApiProperty({ enum: ['PENDING', 'SENT', 'FAILED', 'UNKNOWN'] })
  deliveryState!: string;

  @ApiProperty({
    nullable: true,
    description: 'The comment ID of the published reply. Null until the platform has accepted it.',
  })
  id!: string | null;

  @ApiProperty({
    description:
      'The comment this reply was actually posted under. Differs from the requested parent when threadCollapsed is true.',
  })
  effectiveParentId!: string;

  @ApiProperty({
    description:
      'True when the platform could not accept a reply at the requested depth and the reply was re-pointed at the thread root, with a mention of the original author prefixed to the body.',
  })
  threadCollapsed!: boolean;

  @ApiProperty()
  body!: string;

  @ApiProperty({ nullable: true })
  failureCode!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class ErrorBodyDto {
  @ApiProperty({ description: 'Stable, machine-readable. Never a platform error code.' })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ required: false, type: Object })
  details?: Record<string, unknown>;
}

export class ErrorDto {
  @ApiProperty({ type: () => ErrorBodyDto })
  error!: ErrorBodyDto;
}

export class HealthDto {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';
}

export class ReadinessDto {
  @ApiProperty({ enum: ['ready', 'degraded', 'unhealthy'] })
  status!: 'ready' | 'degraded' | 'unhealthy';

  @ApiProperty({ type: Object, description: 'Per-dependency: "up" or "down".' })
  dependencies!: Record<string, 'up' | 'down'>;
}

// ---------------------------------------------------------------------------------------------
// Canonical → wire
// ---------------------------------------------------------------------------------------------

const commentIdOf = (comment: CanonicalComment, publication: PublicationId): string =>
  comment.platformCommentId === null && comment.localReplyId !== null
    ? encodeCommentRef({
        kind: 'local',
        publicationId: publication,
        localReplyId: comment.localReplyId,
      })
    : encodeCommentRef({
        kind: 'platform',
        publicationId: publication,
        platformCommentId: comment.platformCommentId ?? '',
        depth: comment.depth,
        // Carried so a reply that collapses can render its mention with no extra round trip
        // (ADR-014).
        authorHandle: comment.author.handle,
        rootPlatformCommentId: comment.rootPlatformCommentId,
      });

export const toCommentDto = (comment: CanonicalComment, publication: PublicationId): CommentDto => ({
  id: commentIdOf(comment, publication),
  parentId:
    comment.parentPlatformCommentId === null
      ? null
      : encodeCommentRef({
          kind: 'platform',
          publicationId: publication,
          platformCommentId: comment.parentPlatformCommentId,
          depth: Math.max(0, comment.depth - 1),
          authorHandle: null,
          rootPlatformCommentId: comment.rootPlatformCommentId,
        }),
  depth: comment.depth,
  body: comment.body,
  author: {
    handle: comment.author.handle,
    displayName: comment.author.displayName,
    avatarUrl: comment.author.avatarUrl,
  },
  isOwnedByUs: comment.isOwnedByUs,
  createdAt: comment.platformCreatedAt.toISOString(),
  replies: comment.replies.map((reply) => toCommentDto(reply, publication)),
});

export const toThreadPageDto = (page: ThreadPage, nextCursor: string | null): ThreadPageDto => ({
  comments: page.comments.map((comment) => toCommentDto(comment, page.publicationId)),
  pageInfo: { nextCursor },
});

export const toCapabilitiesDto = (capabilities: PlatformCapabilities): CapabilitiesDto => ({
  maxThreadDepth: capabilities.maxThreadDepth,
  maxReplyLength: capabilities.maxReplyLength,
  onDepthExceeded: capabilities.onDepthExceeded,
  paginationDirection: capabilities.paginationDirection,
  // `mentionFormat` is deliberately not exposed: it is how *we* render a collapse prefix, not
  // something a client can act on. A capability no caller reads is dead weight (ADR-005).
});

export const toReplyDto = (reply: ReplyRecord, effectiveParentId: string): ReplyDto => ({
  replyId: reply.id,
  deliveryState: reply.deliveryState,
  id:
    reply.platformCommentId === null
      ? encodeCommentRef({
          kind: 'local',
          publicationId: reply.publicationId,
          localReplyId: reply.id,
        })
      : encodeCommentRef({
          kind: 'platform',
          publicationId: reply.publicationId,
          platformCommentId: reply.platformCommentId,
          depth: reply.depth,
          authorHandle: null,
          rootPlatformCommentId: reply.rootPlatformCommentId,
        }),
  effectiveParentId,
  threadCollapsed: reply.threadCollapsed,
  body: reply.body,
  failureCode: reply.failureCode,
  createdAt: reply.createdAt.toISOString(),
});
