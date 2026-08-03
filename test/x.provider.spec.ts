import { Platform, publicationId } from '../src/domain/ids';
import { mapXThreadPage } from '../src/platforms/x/x.mapper';
import { XCommentProvider } from '../src/platforms/x/x.provider';
import {
  PLATFORM_POST_ID,
  PUBLICATION_ID,
  response,
  runProviderContract,
} from './provider-contract.suite';
import type { HttpClient } from '../src/application/ports/http-client.port';
import type { XTweet } from '../src/platforms/x/x.payloads';

const BASE = 'https://x.test';
const at = (minute: number): string => `2024-01-01T00:0${minute}:00.000Z`;

const tweet = (
  id: string,
  authorId: string,
  minute: number,
  inReplyTo: string | null,
): Record<string, unknown> => ({
  id,
  text: `body of ${id}`,
  author_id: authorId,
  created_at: at(minute),
  conversation_id: PLATFORM_POST_ID,
  ...(inReplyTo === null ? {} : { in_reply_to_status_id: inReplyTo }),
});

const conversation = () =>
  response(200, {
    // The conversation search returns the publication's own post alongside the replies to it.
    data: [
      tweet(PLATFORM_POST_ID, 'own-user', 0, null),
      tweet('r1', 'alice', 1, PLATFORM_POST_ID),
      tweet('r2', 'own-user', 2, PLATFORM_POST_ID),
      tweet('r1a', 'bob', 3, 'r1'),
      tweet('r1a1', 'alice', 4, 'r1a'),
    ],
    includes: {
      users: [
        { id: 'own-user', username: 'ourbrand', name: 'Our Brand' },
        { id: 'alice', username: 'alice', name: 'Alice' },
        { id: 'bob', username: 'bob', name: 'Bob' },
      ],
    },
    meta: { next_token: 'x-next' },
  });

runProviderContract({
  platform: Platform.X,
  createProvider: (http: HttpClient) => new XCommentProvider(http, BASE),
  thread: conversation,
  createdReply: () => response(201, { data: { id: 'new-tweet', created_at: at(9) } }),
  expectedRootIds: ['r2', 'r1'],
  // A depth-2 reply is flattened into its root's ordered descendant list — ADR-004's accepted
  // cost, and the reason the canonical model reports `depth` separately from nesting.
  expectedRepliesByRoot: { r1: ['r1a', 'r1a1'], r2: [] },
  expectedNextPlatformCursor: 'x-next',
  expectedCreatedCommentId: 'new-tweet',
});

describe('X thread assembly', () => {
  const map = (tweets: readonly XTweet[], maxThreadDepth = 25) =>
    mapXThreadPage({
      publicationId: publicationId(PUBLICATION_ID),
      rootPostId: PLATFORM_POST_ID,
      tweets,
      users: [],
      nextToken: null,
      ownPlatformUserId: 'own-user',
      maxThreadDepth,
    });

  const raw = (id: string, inReplyTo: string | null, minute = 1): XTweet =>
    ({
      id,
      text: id,
      author_id: 'alice',
      created_at: at(minute),
      conversation_id: PLATFORM_POST_ID,
      in_reply_to_status_id: inReplyTo,
    }) as XTweet;

  it('excludes the publication’s own post from its comment thread', () => {
    const page = map([raw(PLATFORM_POST_ID, null), raw('r1', PLATFORM_POST_ID)]);
    expect(page.comments.map((comment) => comment.platformCommentId)).toEqual(['r1']);
  });

  it('preserves true depth while flattening the structure', () => {
    const page = map([
      raw('r1', PLATFORM_POST_ID, 1),
      raw('r1a', 'r1', 2),
      raw('r1a1', 'r1a', 3),
      raw('r1a1a', 'r1a1', 4),
    ]);
    expect(page.comments[0]?.replies.map((reply) => reply.depth)).toEqual([1, 2, 3]);
  });

  it('clamps reported depth to the declared capability rather than over-promising', () => {
    const page = map([raw('r1', PLATFORM_POST_ID, 1), raw('r1a', 'r1', 2), raw('r1a1', 'r1a', 3)], 1);
    expect(page.comments[0]?.replies.map((reply) => reply.depth)).toEqual([1, 1]);
  });

  // The alternative is dropping the comment, which silently loses data, or inventing an ancestor,
  // which lies about the thread. Promotion keeps the page honest and keeps the contract invariant.
  it('promotes a comment whose ancestor is off-page to a root, keeping its parent reference', () => {
    const page = map([raw('orphan', 'not-in-this-page', 1)]);
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0]?.depth).toBe(0);
    expect(page.comments[0]?.rootPlatformCommentId).toBeNull();
    expect(page.comments[0]?.parentPlatformCommentId).toBe('not-in-this-page');
  });

  it('terminates on a cyclic reply chain instead of hanging', () => {
    const page = map([raw('a', 'b', 1), raw('b', 'a', 2)]);
    expect(page.comments.length).toBeGreaterThan(0);
  });

  it('falls back to the author id rather than failing a page over one missing join', () => {
    const page = map([raw('r1', PLATFORM_POST_ID)]);
    expect(page.comments[0]?.author.displayName).toBe('alice');
    expect(page.comments[0]?.author.handle).toBeNull();
  });
});
