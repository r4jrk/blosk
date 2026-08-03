import { DeliveryState } from '../domain/comment';
import {
  CallerError,
  SystemError,
  UpstreamError,
  UpstreamIndeterminate,
} from '../domain/errors';
import { decodeCommentRef, encodeCommentRef } from '../domain/envelope.codec';
import type { LocalReplyId, PublicationId, TenantScope } from '../domain/ids';
import {
  renderMention,
  type CommentProvider,
  type PlatformProviderRegistry,
} from './ports/comment-provider.port';
import type {
  CommentRepository,
  ParentCommentSeed,
  PublicationRecord,
  ReplyRecord,
} from './ports/comment-repository.port';
import { requirePublicationForComments } from './comment-read.service';

/**
 * Use case 2 — reply to a comment.
 *
 * This is the side of the feature where the interesting failures live, because a reply is a
 * non-idempotent side effect on a system we do not control. Two decisions shape everything below:
 *
 *   ADR-006 — the local row is inserted and *committed* before any network I/O. A crash between
 *             the two must not lose the record of something published under the customer's name,
 *             and no database transaction is ever held open across a platform round trip.
 *   ADR-015 — replay behaviour is a function of `deliveryState`, and a determinate failure
 *             releases the idempotency key so that a correct client retry is not refused forever.
 */

export interface PostReplyCommand {
  readonly publicationId: PublicationId;
  /** The encoded comment reference from the route (ADR-014). */
  readonly parentCommentId: string;
  readonly body: string;
  readonly idempotencyKey: string | null;
}

export type ReplyOutcomeStatus =
  /** Posted now. 201. */
  | 'created'
  /** Idempotent replay of a reply already posted. 200 — we created nothing this time. */
  | 'replayed'
  /** A concurrent duplicate is still in flight. 409 + Retry-After. */
  | 'in-flight'
  /** The platform never answered. 202 + the status resource. */
  | 'indeterminate';

export interface ReplyOutcome {
  readonly status: ReplyOutcomeStatus;
  /** Carries ADR-009's `threadCollapsed` disclosure, read off the durable record. */
  readonly reply: ReplyRecord;
  /** The encoded reference of the comment we actually replied under. */
  readonly effectiveParentCommentId: string;
}

interface ResolvedTarget {
  /** What we will actually post under — the requested parent, unless ADR-009 collapsed the thread. */
  readonly effectiveParent: ParentCommentSeed;
  /** The reply's own depth. */
  readonly depth: number;
  readonly threadCollapsed: boolean;
  readonly body: string;
}

/**
 * Platform limits are stated in characters-as-users-see-them. Code units would over-count an
 * emoji by a factor of two and reject a body the platform would have accepted.
 */
const countGraphemes = (value: string): number => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(value)) count += 1;
  return count;
};

export class ReplyService {
  constructor(
    private readonly repository: CommentRepository,
    private readonly registry: PlatformProviderRegistry,
  ) {}

  async postReply(scope: TenantScope, command: PostReplyCommand): Promise<ReplyOutcome> {
    const publication = await requirePublicationForComments(
      this.repository,
      scope,
      command.publicationId,
    );
    const provider = this.registry.resolve(publication.platform);
    const target = await this.resolveTarget(scope, publication, provider, command);

    const created = await this.repository.createPendingReply(scope, {
      publicationId: publication.id,
      connectedAccountId: publication.connectedAccountId,
      parent: target.effectiveParent,
      depth: target.depth,
      threadCollapsed: target.threadCollapsed,
      body: target.body,
      authorPlatformId: publication.credential.platformUserId,
      idempotencyKey: command.idempotencyKey,
    });

    const effectiveParentCommentId = encodeCommentRef({
      kind: 'platform',
      publicationId: publication.id,
      platformCommentId: target.effectiveParent.platformCommentId,
      depth: target.effectiveParent.depth,
      authorHandle: target.effectiveParent.authorHandle,
      rootPlatformCommentId: target.effectiveParent.rootPlatformCommentId,
    });

    if (created.kind === 'duplicate') {
      // The replayed record carries its own `threadCollapsed`, so a replay describes the reply
      // that actually exists rather than what this request would have done.
      return { ...this.replay(created.existing), effectiveParentCommentId };
    }

    const reply = await this.deliver(scope, provider, publication, created.reply, target);
    return {
      status: reply.deliveryState === DeliveryState.Unknown ? 'indeterminate' : 'created',
      reply,
      effectiveParentCommentId,
    };
  }

  async getReply(scope: TenantScope, id: LocalReplyId): Promise<ReplyRecord> {
    const reply = await this.repository.findReply(scope, id);
    if (reply === null) {
      throw CallerError.notFound('REPLY_NOT_FOUND', 'No such reply.');
    }
    return reply;
  }

  /**
   * ADR-009: where the requested parent is deeper than the platform allows, collapse to the root
   * and disclose it. Driven entirely by the capability descriptor — there is no platform check
   * here, and adding a platform adds no branch.
   */
  private async resolveTarget(
    scope: TenantScope,
    publication: PublicationRecord,
    provider: CommentProvider,
    command: PostReplyCommand,
  ): Promise<ResolvedTarget> {
    const parent = await this.resolveParent(scope, publication.id, command.parentCommentId);
    const capabilities = provider.capabilities;
    const requestedDepth = parent.depth + 1;
    const exceedsDepth = requestedDepth > capabilities.maxThreadDepth;

    if (exceedsDepth && capabilities.onDepthExceeded === 'reject') {
      throw CallerError.unprocessable(
        'PLATFORM_DEPTH_EXCEEDED',
        'This platform does not accept a reply at that depth.',
        { maxThreadDepth: capabilities.maxThreadDepth },
      );
    }

    const collapsed = exceedsDepth;
    const mention = collapsed
      ? renderMention(capabilities.mentionFormat, parent.authorHandle)
      : null;
    // The mention is prepended by us and counts against the platform's limit, so the length check
    // has to happen after rendering — otherwise a body at exactly the limit is committed as
    // PENDING and then rejected upstream (ADR-009).
    const body = mention === null ? command.body : `${mention} ${command.body}`;
    const length = countGraphemes(body);
    if (length > capabilities.maxReplyLength) {
      throw CallerError.unprocessable(
        'REPLY_TOO_LONG',
        'The reply exceeds this platform’s length limit.',
        { limit: capabilities.maxReplyLength, length, mentionPrefixed: mention !== null },
      );
    }

    return {
      effectiveParent: collapsed
        ? {
            // Collapsing re-points the reply at the thread root, which is by definition at depth 0
            // with no root of its own.
            platformCommentId: parent.rootPlatformCommentId ?? parent.platformCommentId,
            rootPlatformCommentId: null,
            depth: 0,
            authorHandle: null,
          }
        : parent,
      depth: collapsed ? 1 : requestedDepth,
      threadCollapsed: collapsed,
      body,
    };
  }

  private async resolveParent(
    scope: TenantScope,
    publicationId: PublicationId,
    encodedRef: string,
  ): Promise<ParentCommentSeed> {
    const ref = decodeCommentRef(encodedRef, publicationId);

    // A platform-keyed reference is self-describing (ADR-014): depth, handle and root ride in the
    // envelope precisely so that replying to a comment we have never stored costs no round trip.
    if (ref.kind === 'platform') {
      return {
        platformCommentId: ref.platformCommentId,
        rootPlatformCommentId: ref.rootPlatformCommentId,
        depth: ref.depth,
        authorHandle: ref.authorHandle,
      };
    }

    const parent = await this.repository.findReply(scope, ref.localReplyId);
    if (parent === null) {
      throw CallerError.notFound('COMMENT_NOT_FOUND', 'No such comment.');
    }
    if (parent.platformCommentId === null) {
      // Our own reply that has not landed yet. There is nothing on the platform to attach to, and
      // guessing would post an orphan.
      throw CallerError.conflict(
        'PARENT_NOT_DELIVERED',
        'The comment being replied to has not been published to the platform yet.',
        { deliveryState: parent.deliveryState },
      );
    }
    return {
      platformCommentId: parent.platformCommentId,
      rootPlatformCommentId: parent.rootPlatformCommentId,
      depth: parent.depth,
      authorHandle: null,
    };
  }

  /** ADR-015's replay table. */
  private replay(existing: ReplyRecord): { status: ReplyOutcomeStatus; reply: ReplyRecord } {
    switch (existing.deliveryState) {
      case DeliveryState.Sent:
        return { status: 'replayed', reply: existing };
      case DeliveryState.Pending:
        return { status: 'in-flight', reply: existing };
      case DeliveryState.Unknown:
        return { status: 'indeterminate', reply: existing };
      case DeliveryState.Failed:
        // Unreachable: `markReplyFailed` releases the key in the same transaction, and the unique
        // index is partial, so a FAILED row cannot be the one we collided with. If it is, the
        // release is broken and silently proceeding would risk a duplicate public comment.
        throw new SystemError(
          'IDEMPOTENCY_INVARIANT',
          'A failed reply is still occupying an idempotency key.',
        );
    }
  }

  /**
   * The network call, outside any transaction. Every exit path leaves the row in a state that
   * describes what we actually know.
   */
  private async deliver(
    scope: TenantScope,
    provider: CommentProvider,
    publication: PublicationRecord,
    reply: ReplyRecord,
    target: ResolvedTarget,
  ): Promise<ReplyRecord> {
    try {
      const posted = await provider.postReply({
        platformPostId: publication.platformPostId,
        parentPlatformCommentId: target.effectiveParent.platformCommentId,
        body: target.body,
        credential: publication.credential,
      });
      return await this.repository.markReplySent(
        scope,
        reply.id,
        posted.platformCommentId,
        posted.platformCreatedAt,
      );
    } catch (error) {
      if (error instanceof UpstreamIndeterminate) {
        // The only state we never retry from automatically (ADR-015).
        return await this.repository.markReplyUnknown(scope, reply.id);
      }
      if (error instanceof UpstreamError) {
        await this.repository.markReplyFailed(scope, reply.id, error.code);
        throw error;
      }
      await this.repository.markReplyFailed(scope, reply.id, 'SYSTEM');
      throw error;
    }
  }
}
