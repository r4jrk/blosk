import type { CanonicalComment, ThreadPage } from '../../domain/comment';
import type { PublicationId } from '../../domain/ids';
import type { LinkedInComment, LinkedInMetadata } from './linkedin.payloads';

/**
 * LinkedIn's half of the anti-corruption layer (ADR-013).
 *
 * LinkedIn's model is shallow and *resource-oriented*: comments and replies are separate,
 * separately-paginated collections, and the platform caps nesting at one level. Assembly is
 * therefore a join of two already-flat lists — no tree walking, no depth computation. Compare
 * `x.mapper.ts`, which shares none of this and is deliberately not refactored into a common base
 * (ADR-013): both produce a `ThreadPage`, and that is the interface, not shared code.
 */

export interface LinkedInThreadSource {
  readonly publicationId: PublicationId;
  readonly roots: readonly LinkedInComment[];
  /** Keyed by root comment URN. Fetched per root by the transport, concurrency-capped. */
  readonly repliesByRootUrn: ReadonlyMap<string, readonly LinkedInComment[]>;
  readonly nextToken: string | null;
  /** The publishing account, so `isOwnedByUs` can be derived without a lookup (ADR-010). */
  readonly ownPlatformUserId: string;
}

export const linkedInMetadataOf = (comment: LinkedInComment): LinkedInMetadata => ({
  actorUrn: comment.actor.id,
  likeCount: comment.likeCount,
  replyCount: comment.replyCount,
});

const toCanonical = (
  comment: LinkedInComment,
  rootUrn: string | null,
  ownPlatformUserId: string,
  replies: readonly CanonicalComment[],
): CanonicalComment => ({
  platformCommentId: comment.commentUrn,
  localReplyId: null,
  parentPlatformCommentId: comment.parentComment ?? null,
  rootPlatformCommentId: rootUrn,
  depth: rootUrn === null ? 0 : 1,
  body: comment.message.text,
  author: {
    platformId: comment.actor.id,
    handle: comment.actor.vanityName ?? null,
    displayName: comment.actor.localizedName,
    avatarUrl: comment.actor.profilePictureUrl ?? null,
  },
  isOwnedByUs: comment.actor.id === ownPlatformUserId,
  platformCreatedAt: new Date(comment.createdAtMs),
  replies,
});

export const mapLinkedInThreadPage = (source: LinkedInThreadSource): ThreadPage => {
  const comments = [...source.roots]
    // Roots follow the declared pagination direction (newest first); a sub-thread reads as a
    // conversation and is always chronological.
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .map((root) => {
      const replies = [...(source.repliesByRootUrn.get(root.commentUrn) ?? [])]
        .sort((a, b) => a.createdAtMs - b.createdAtMs)
        .map((reply) => toCanonical(reply, root.commentUrn, source.ownPlatformUserId, []));
      return toCanonical(root, null, source.ownPlatformUserId, replies);
    });

  return {
    publicationId: source.publicationId,
    comments,
    nextPlatformCursor: source.nextToken,
  };
};
