import type { AuthorSnapshot, CanonicalComment, ThreadPage } from '../../domain/comment';
import type { PublicationId } from '../../domain/ids';
import type { XMetadata, XTweet, XUser } from './x.payloads';

/**
 * X's half of the anti-corruption layer (ADR-013), and the reason this pair of platforms was
 * chosen: it shares no structure with LinkedIn's mapper at all.
 *
 * X returns a *flat conversation*. A "comment" is a synthetic concept — every element is a post
 * carrying `in_reply_to_status_id`, chains are unbounded, and the tree has to be reconstructed by
 * walking a parent map rooted at the publication's own post. An abstract base mapper shared with
 * LinkedIn would have exactly one thing in common with this file: the return type. That is the
 * interface, not shared code, so the two stay separate (ADR-013).
 */

export interface XThreadSource {
  readonly publicationId: PublicationId;
  /** The publication's own post. Everything replying to it directly is a root comment. */
  readonly rootPostId: string;
  readonly tweets: readonly XTweet[];
  readonly users: readonly XUser[];
  readonly nextToken: string | null;
  readonly ownPlatformUserId: string;
  /** Reported depth is clamped to this so the canonical model never over-promises (ADR-004). */
  readonly maxThreadDepth: number;
}

export const xMetadataOf = (tweet: XTweet): XMetadata => ({
  conversationId: tweet.conversation_id,
  replyCount: tweet.public_metrics?.reply_count ?? 0,
  likeCount: tweet.public_metrics?.like_count ?? 0,
});

interface Position {
  readonly depth: number;
  /** Null when the tweet is a root of this page. */
  readonly rootId: string | null;
}

/**
 * Walk up `in_reply_to_status_id` until the publication's own post is reached.
 *
 * Two stopping conditions, and the second one is a judgement call worth naming: when the chain
 * leaves the page — the parent was not returned in these results — the tweet is surfaced as a
 * root of *this page* rather than dropped. Dropping would silently lose comments; inventing an
 * ancestor would lie. `parentPlatformCommentId` is still populated, so a client can see that the
 * comment had a parent it has not been shown.
 */
const locate = (tweet: XTweet, byId: ReadonlyMap<string, XTweet>, rootPostId: string): Position => {
  let current = tweet;
  let depth = 0;
  const seen = new Set<string>([tweet.id]);

  for (;;) {
    const parentId = current.in_reply_to_status_id ?? null;
    if (parentId === null || parentId === rootPostId) break;
    const parent = byId.get(parentId);
    // `seen` also terminates a cycle. Platforms should not produce one; a mapper that can hang on
    // hostile input is a mapper that can take the process down.
    if (parent === undefined || seen.has(parentId)) break;
    seen.add(parentId);
    current = parent;
    depth += 1;
  }

  return { depth, rootId: depth === 0 ? null : current.id };
};

const authorOf = (
  tweet: XTweet,
  usersById: ReadonlyMap<string, XUser>,
  ownPlatformUserId: string,
): AuthorSnapshot => {
  const user = usersById.get(tweet.author_id);
  return {
    platformId: tweet.author_id,
    handle: user?.username ?? null,
    // The side-loaded user block is normally complete; falling back to the ID keeps a comment
    // renderable rather than failing the whole page over one missing join.
    displayName: user?.name ?? tweet.author_id,
    avatarUrl: user?.profile_image_url ?? null,
  };
};

export const mapXThreadPage = (source: XThreadSource): ThreadPage => {
  const byId = new Map(source.tweets.map((tweet) => [tweet.id, tweet]));
  const usersById = new Map(source.users.map((user) => [user.id, user]));

  const positioned = source.tweets
    // The conversation search returns the publication's own post alongside the replies to it.
    .filter((tweet) => tweet.id !== source.rootPostId)
    .map((tweet) => {
      const position = locate(tweet, byId, source.rootPostId);
      return { tweet, position };
    });

  const repliesByRoot = new Map<string, CanonicalComment[]>();
  const roots: { tweet: XTweet; comment: CanonicalComment }[] = [];

  const toCanonical = (
    tweet: XTweet,
    position: Position,
    replies: CanonicalComment[],
  ): CanonicalComment => ({
    platformCommentId: tweet.id,
    localReplyId: null,
    parentPlatformCommentId: tweet.in_reply_to_status_id ?? null,
    rootPlatformCommentId: position.rootId,
    depth: Math.min(position.depth, source.maxThreadDepth),
    body: tweet.text,
    author: authorOf(tweet, usersById, source.ownPlatformUserId),
    isOwnedByUs: tweet.author_id === source.ownPlatformUserId,
    platformCreatedAt: new Date(tweet.created_at),
    replies,
  });

  const promoteToRoot = (tweet: XTweet): void => {
    const replies: CanonicalComment[] = [];
    repliesByRoot.set(tweet.id, replies);
    roots.push({ tweet, comment: toCanonical(tweet, { depth: 0, rootId: null }, replies) });
  };

  for (const { tweet, position } of positioned) {
    if (position.rootId === null) promoteToRoot(tweet);
  }

  for (const { tweet, position } of positioned) {
    if (position.rootId === null) continue;
    const bucket = repliesByRoot.get(position.rootId);
    if (bucket === undefined) {
      // The ancestry walk stopped somewhere that is not a root of this page — a cycle, in
      // practice. Surfacing the comment as a root loses its indentation; dropping it loses the
      // comment. The first is recoverable by the reader, the second is invisible.
      promoteToRoot(tweet);
      continue;
    }
    // Anything deeper than one level is flattened into its root's ordered descendant list; the
    // true depth is preserved so a client can still indent (ADR-004's accepted cost).
    bucket.push(toCanonical(tweet, position, []));
  }

  for (const replies of repliesByRoot.values()) {
    replies.sort((a, b) => a.platformCreatedAt.getTime() - b.platformCreatedAt.getTime());
  }

  return {
    publicationId: source.publicationId,
    comments: roots
      .sort((a, b) => Date.parse(b.tweet.created_at) - Date.parse(a.tweet.created_at))
      .map((entry) => entry.comment),
    nextPlatformCursor: source.nextToken,
  };
};
