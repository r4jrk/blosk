import { Platform } from '../src/domain/ids';
import { LinkedInCommentProvider } from '../src/platforms/linkedin/linkedin.provider';
import {
  ConstantHttpClient,
  CREDENTIAL,
  PLATFORM_POST_ID,
  PUBLICATION_ID,
  ScriptedHttpClient,
  response,
  runProviderContract,
} from './provider-contract.suite';
import type { HttpClient, HttpRequest } from '../src/application/ports/http-client.port';

const BASE = 'https://linkedin.test';

const comment = (
  urn: string,
  actorId: string,
  createdAtMs: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  commentUrn: urn,
  actor: { id: actorId, localizedName: `Name ${actorId}`, vanityName: `handle-${actorId}` },
  message: { text: `body of ${urn}` },
  createdAtMs,
  ...extra,
});

const thread = (request: HttpRequest) =>
  request.url.includes(PLATFORM_POST_ID)
    ? response(200, {
        elements: [
          comment('c1', 'alice', 2_000, { replyCount: 2 }),
          comment('c2', 'own-user', 3_000),
        ],
        paging: { nextToken: 'lnk-next' },
      })
    : response(200, {
        elements: [
          comment('r1', 'bob', 1_500, { parentComment: 'c1' }),
          comment('r2', 'own-user', 1_700, { parentComment: 'c1' }),
        ],
        paging: {},
      });

runProviderContract({
  platform: Platform.LinkedIn,
  createProvider: (http: HttpClient) => new LinkedInCommentProvider(http, BASE),
  thread,
  createdReply: () => response(201, { commentUrn: 'new-comment', createdAtMs: 5_000 }),
  expectedRootIds: ['c2', 'c1'],
  expectedRepliesByRoot: { c1: ['r1', 'r2'], c2: [] },
  expectedNextPlatformCursor: 'lnk-next',
  expectedCreatedCommentId: 'new-comment',
});

describe('LinkedIn adapter specifics', () => {
  const fetchPage = async () => {
    const http = new ScriptedHttpClient(thread);
    const page = await new LinkedInCommentProvider(http, BASE).fetchThreadPage({
      publicationId: PUBLICATION_ID,
      platformPostId: PLATFORM_POST_ID,
      credential: CREDENTIAL,
      cursor: null,
      pageSize: 10,
    });
    return { http, page };
  };

  // ADR-013 accepts an N+1 against LinkedIn because replies are a separately paginated resource
  // with no batch endpoint. Accepting it is only defensible while it stays bounded — one call per
  // root that actually has replies, never one per root.
  it('fetches replies only for roots that have them', async () => {
    const { http } = await fetchPage();
    expect(http.requests).toHaveLength(2);
    expect(http.requests.filter((request) => request.url.includes('c2'))).toHaveLength(0);
  });

  it('caps replies to depth 1, because that is all LinkedIn has', async () => {
    const { page } = await fetchPage();
    const replies = page.comments.flatMap((root) => root.replies);
    expect(replies.map((reply) => reply.depth)).toEqual([1, 1]);
    expect(replies.every((reply) => reply.rootPlatformCommentId === 'c1')).toBe(true);
  });

  it('treats an expired continuation token as a caller-fixable pagination failure, not an outage', async () => {
    const http = new ConstantHttpClient(
      response(400, { code: 'INVALID_PAGINATION_TOKEN', message: 'stale token' }),
    );
    await expect(
      new LinkedInCommentProvider(http, BASE).fetchThreadPage({
        publicationId: PUBLICATION_ID,
        platformPostId: PLATFORM_POST_ID,
        credential: CREDENTIAL,
        cursor: 'stale',
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ code: 'CURSOR_EXPIRED', family: 'caller' });
  });

  it('reports a member with no public handle as having none, rather than inventing one', async () => {
    const http = new ScriptedHttpClient(() =>
      response(200, {
        elements: [
          {
            commentUrn: 'c9',
            actor: { id: 'ghost', localizedName: 'Ghost' },
            message: { text: 'hi' },
            createdAtMs: 1,
          },
        ],
        paging: {},
      }),
    );
    const page = await new LinkedInCommentProvider(http, BASE).fetchThreadPage({
      publicationId: PUBLICATION_ID,
      platformPostId: PLATFORM_POST_ID,
      credential: CREDENTIAL,
      cursor: null,
      pageSize: 10,
    });
    expect(page.comments[0]?.author.handle).toBeNull();
  });

  it('rejects a payload it does not recognise instead of guessing', async () => {
    const http = new ConstantHttpClient(response(200, { unexpected: true }));
    await expect(
      new LinkedInCommentProvider(http, BASE).fetchThreadPage({
        publicationId: PUBLICATION_ID,
        platformPostId: PLATFORM_POST_ID,
        credential: CREDENTIAL,
        cursor: null,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_PAYLOAD_UNRECOGNISED' });
  });
});
