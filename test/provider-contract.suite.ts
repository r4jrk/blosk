import type { CanonicalComment } from '../src/domain/comment';
import {
  UpstreamAuthError,
  UpstreamIndeterminate,
  UpstreamRateLimited,
  UpstreamRejected,
  UpstreamUnavailable,
} from '../src/domain/errors';
import { decodeCursor, encodeCursor } from '../src/domain/envelope.codec';
import { connectedAccountId, publicationId, type Platform } from '../src/domain/ids';
import type {
  CommentProvider,
  PlatformCredential,
} from '../src/application/ports/comment-provider.port';
import {
  HttpTransportError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../src/application/ports/http-client.port';

/**
 * The contract suite every adapter is run against — the Liskov check, and the single most
 * valuable test in this repository.
 *
 * It is written entirely against the port. Each platform supplies scripted transport responses in
 * its own wire format and the *expected canonical result*; nothing platform-shaped appears in the
 * assertions. If an adapter ever needs the suite bent for it, the port is wrong, and that is the
 * finding — not a reason to add a flag here.
 */

export const PUBLICATION_ID = publicationId('11111111-1111-4111-8111-111111111111');
export const PLATFORM_POST_ID = 'post-1';

export const CREDENTIAL: PlatformCredential = {
  connectedAccountId: connectedAccountId('22222222-2222-4222-8222-222222222222'),
  accessToken: 'token',
  platformUserId: 'own-user',
};

export class ScriptedHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];

  constructor(private readonly handler: (request: HttpRequest) => HttpResponse) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return this.handler(request);
  }
}

export class ConstantHttpClient implements HttpClient {
  constructor(private readonly outcome: HttpResponse | HttpTransportError) {}

  async send(): Promise<HttpResponse> {
    if (this.outcome instanceof HttpTransportError) throw this.outcome;
    return this.outcome;
  }
}

export const response = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({ status, body, headers });

export interface ContractFixture {
  readonly platform: Platform;
  createProvider(http: HttpClient): CommentProvider;
  /** Scripted platform responses for one thread page. */
  thread(request: HttpRequest): HttpResponse;
  /** A successful reply creation, in the platform's own shape. */
  createdReply(): HttpResponse;
  /** The platform IDs of the expected root comments, in the order the page should return them. */
  readonly expectedRootIds: readonly string[];
  /** Expected replies keyed by root platform ID, in the order they should appear. */
  readonly expectedRepliesByRoot: Readonly<Record<string, readonly string[]>>;
  readonly expectedNextPlatformCursor: string;
  readonly expectedCreatedCommentId: string;
}

const flatten = (comments: readonly CanonicalComment[]): CanonicalComment[] =>
  comments.flatMap((comment) => [comment, ...flatten(comment.replies)]);

export const runProviderContract = (fixture: ContractFixture): void => {
  describe(`${fixture.platform} satisfies the CommentProvider contract`, () => {
    const fetchPage = async () => {
      const http = new ScriptedHttpClient((request) => fixture.thread(request));
      const provider = fixture.createProvider(http);
      const page = await provider.fetchThreadPage({
        publicationId: PUBLICATION_ID,
        platformPostId: PLATFORM_POST_ID,
        credential: CREDENTIAL,
        cursor: null,
        pageSize: 10,
      });
      return { page, provider, http };
    };

    it('returns the expected roots, each carrying its own replies', async () => {
      const { page } = await fetchPage();
      expect(page.comments.map((comment) => comment.platformCommentId)).toEqual(
        fixture.expectedRootIds,
      );
      for (const root of page.comments) {
        expect(root.replies.map((reply) => reply.platformCommentId)).toEqual(
          fixture.expectedRepliesByRoot[root.platformCommentId ?? ''] ?? [],
        );
      }
    });

    it('roots are at depth 0 with no root of their own', async () => {
      const { page } = await fetchPage();
      for (const root of page.comments) {
        expect(root.depth).toBe(0);
        expect(root.rootPlatformCommentId).toBeNull();
      }
    });

    it('every non-root resolves to a root within the page', async () => {
      const { page } = await fetchPage();
      const rootIds = new Set(page.comments.map((comment) => comment.platformCommentId));
      for (const comment of flatten(page.comments)) {
        if (comment.rootPlatformCommentId === null) continue;
        expect(comment.depth).toBeGreaterThan(0);
        expect(rootIds.has(comment.rootPlatformCommentId)).toBe(true);
      }
    });

    it('never reports a depth beyond the declared capability', async () => {
      const { page, provider } = await fetchPage();
      for (const comment of flatten(page.comments)) {
        expect(comment.depth).toBeLessThanOrEqual(provider.capabilities.maxThreadDepth);
      }
    });

    it('orders roots by the declared pagination direction, and replies chronologically', async () => {
      const { page, provider } = await fetchPage();
      const times = page.comments.map((comment) => comment.platformCreatedAt.getTime());
      const sorted = [...times].sort((a, b) =>
        provider.capabilities.paginationDirection === 'newest-first' ? b - a : a - b,
      );
      expect(times).toEqual(sorted);

      for (const root of page.comments) {
        const replyTimes = root.replies.map((reply) => reply.platformCreatedAt.getTime());
        expect(replyTimes).toEqual([...replyTimes].sort((a, b) => a - b));
      }
    });

    it('marks our own comments as ours and nobody else’s', async () => {
      const { page } = await fetchPage();
      for (const comment of flatten(page.comments)) {
        expect(comment.isOwnedByUs).toBe(comment.author.platformId === CREDENTIAL.platformUserId);
      }
    });

    it('emits a next cursor that survives our envelope round trip', async () => {
      const { page } = await fetchPage();
      expect(page.nextPlatformCursor).toBe(fixture.expectedNextPlatformCursor);

      const encoded = encodeCursor({
        publicationId: PUBLICATION_ID,
        platformCursor: page.nextPlatformCursor ?? '',
        pageSize: 10,
      });
      expect(decodeCursor(encoded, PUBLICATION_ID)).toEqual({
        platformCursor: fixture.expectedNextPlatformCursor,
        pageSize: 10,
      });
    });

    it('never leaks a platform cursor into a URL path', async () => {
      const http = new ScriptedHttpClient((request) => fixture.thread(request));
      const provider = fixture.createProvider(http);
      await provider.fetchThreadPage({
        publicationId: PUBLICATION_ID,
        platformPostId: PLATFORM_POST_ID,
        credential: CREDENTIAL,
        cursor: 'opaque/../cursor',
        pageSize: 10,
      });
      for (const request of http.requests) {
        expect(request.url).not.toContain('opaque/../cursor');
      }
    });

    it('posts a reply and returns its platform identifier', async () => {
      const http = new ScriptedHttpClient(() => fixture.createdReply());
      const posted = await fixture.createProvider(http).postReply({
        platformPostId: PLATFORM_POST_ID,
        parentPlatformCommentId: fixture.expectedRootIds[0] ?? '',
        body: 'hello',
        credential: CREDENTIAL,
      });
      expect(posted.platformCommentId).toBe(fixture.expectedCreatedCommentId);
      expect(posted.platformCreatedAt).toBeInstanceOf(Date);
    });

    describe('translates platform failures into our taxonomy', () => {
      const postReply = (outcome: HttpResponse | HttpTransportError) =>
        fixture.createProvider(new ConstantHttpClient(outcome)).postReply({
          platformPostId: PLATFORM_POST_ID,
          parentPlatformCommentId: 'parent',
          body: 'hello',
          credential: CREDENTIAL,
        });

      it('an expired or revoked token is never surfaced as a 401 to our caller', async () => {
        await expect(postReply(response(401, {}))).rejects.toBeInstanceOf(UpstreamAuthError);
      });

      it('rate limiting names a retry delay', async () => {
        await expect(postReply(response(429, {}, { 'retry-after': '30' }))).rejects.toBeInstanceOf(
          UpstreamRateLimited,
        );
      });

      it('a platform 5xx is upstream unavailability, not our failure', async () => {
        await expect(postReply(response(503, {}))).rejects.toBeInstanceOf(UpstreamUnavailable);
      });

      it('a refusal is distinguished from an outage', async () => {
        await expect(postReply(response(422, {}))).rejects.toBeInstanceOf(UpstreamRejected);
      });

      it('a timed-out write is indeterminate, never a retryable error', async () => {
        await expect(
          postReply(new HttpTransportError('timeout', 'timed out')),
        ).rejects.toBeInstanceOf(UpstreamIndeterminate);
      });

      it('a timed-out read is merely unavailable — a read is safe to retry', async () => {
        const provider = fixture.createProvider(
          new ConstantHttpClient(new HttpTransportError('timeout', 'timed out')),
        );
        await expect(
          provider.fetchThreadPage({
            publicationId: PUBLICATION_ID,
            platformPostId: PLATFORM_POST_ID,
            credential: CREDENTIAL,
            cursor: null,
            pageSize: 10,
          }),
        ).rejects.toBeInstanceOf(UpstreamUnavailable);
      });
    });
  });
};
