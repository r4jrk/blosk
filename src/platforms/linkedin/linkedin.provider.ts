import type { z } from 'zod';
import type { ThreadPage } from '../../domain/comment';
import {
  CallerError,
  SystemError,
  UpstreamAuthError,
  UpstreamIndeterminate,
  UpstreamRateLimited,
  UpstreamRejected,
  UpstreamUnavailable,
} from '../../domain/errors';
import { Platform } from '../../domain/ids';
import type {
  CommentProvider,
  FetchThreadPageInput,
  PlatformCapabilities,
  PlatformCredential,
  PostReplyInput,
  PostedReply,
} from '../../application/ports/comment-provider.port';
import {
  HttpTransportError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../../application/ports/http-client.port';
import {
  linkedInCommentPageSchema,
  linkedInCreatedCommentSchema,
  linkedInErrorSchema,
  type LinkedInComment,
} from './linkedin.payloads';
import { mapLinkedInThreadPage } from './linkedin.mapper';

/**
 * LinkedIn transport. Speaks HTTP and translates LinkedIn's failures into our taxonomy; it does
 * no payload mapping (that is `linkedin.mapper.ts`) and no orchestration (that is the application
 * service). Those three are separate on purpose — the class that does all three is the failure
 * mode this design exists to avoid.
 */

/**
 * Replies are a separately-paginated resource on LinkedIn with no batch endpoint, so a page of
 * roots costs one call per root that has replies. That is an N+1 *against the platform*, and it
 * is a property of their API rather than a defect in ours (ADR-013) — but an unbounded one would
 * still be ours. It is bounded by the page size and capped here.
 */
const REPLY_FETCH_CONCURRENCY = 4;

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      // Safe by the loop bound; `noUncheckedIndexedAccess` cannot see that.
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

export class LinkedInCommentProvider implements CommentProvider {
  readonly platform = Platform.LinkedIn;

  /**
   * Facts about LinkedIn, expressed as data so that nothing above this file has to know which
   * platform it is holding (ADR-005). `onDepthExceeded: 'collapse'` is the product choice, not
   * the limit: LinkedIn's own UI collapses a reply-to-a-reply onto the root with a mention, so
   * doing the same makes the published result match what the audience sees natively (ADR-009).
   */
  readonly capabilities: PlatformCapabilities = Object.freeze({
    maxThreadDepth: 1,
    maxReplyLength: 1250,
    onDepthExceeded: 'collapse',
    mentionFormat: { kind: 'template', template: '@[{handle}]' },
    paginationDirection: 'newest-first',
  } as const);

  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
  ) {}

  async fetchThreadPage(input: FetchThreadPageInput): Promise<ThreadPage> {
    const rootsBody = await this.send(
      {
        method: 'GET',
        url: `${this.baseUrl}/socialActions/${encodeURIComponent(input.platformPostId)}/comments`,
        // The platform cursor travels as a query-parameter *value* and is never interpolated into
        // a path or a template — the containment ADR-008 requires for the one field we cannot
        // meaningfully validate.
        query: {
          count: input.pageSize,
          ...(input.cursor === null ? {} : { start: input.cursor }),
        },
      },
      input.credential,
      { mutating: false },
    );

    const roots = this.parse(linkedInCommentPageSchema, rootsBody);
    const withReplies = roots.elements.filter((comment) => comment.replyCount > 0);
    const replyPages = await mapWithConcurrency(
      withReplies,
      REPLY_FETCH_CONCURRENCY,
      async (root): Promise<[string, readonly LinkedInComment[]]> => [
        root.commentUrn,
        await this.fetchReplies(root.commentUrn, input.credential),
      ],
    );

    return mapLinkedInThreadPage({
      publicationId: input.publicationId,
      roots: roots.elements,
      repliesByRootUrn: new Map(replyPages),
      nextToken: roots.paging.nextToken ?? null,
      ownPlatformUserId: input.credential.platformUserId,
    });
  }

  async postReply(input: PostReplyInput): Promise<PostedReply> {
    const body = await this.send(
      {
        method: 'POST',
        url: `${this.baseUrl}/socialActions/${encodeURIComponent(input.platformPostId)}/comments`,
        body: {
          actor: input.credential.platformUserId,
          message: { text: input.body },
          parentComment: input.parentPlatformCommentId,
        },
      },
      input.credential,
      { mutating: true },
    );

    const created = this.parse(linkedInCreatedCommentSchema, body);
    return {
      platformCommentId: created.commentUrn,
      platformCreatedAt: new Date(created.createdAtMs),
    };
  }

  private async fetchReplies(
    rootUrn: string,
    credential: PlatformCredential,
  ): Promise<readonly LinkedInComment[]> {
    const body = await this.send(
      {
        method: 'GET',
        url: `${this.baseUrl}/socialActions/${encodeURIComponent(rootUrn)}/comments`,
        query: { count: 100 },
      },
      credential,
      { mutating: false },
    );
    return this.parse(linkedInCommentPageSchema, body).elements;
  }

  private async send(
    request: HttpRequest,
    credential: PlatformCredential,
    options: { mutating: boolean },
  ): Promise<unknown> {
    let response: HttpResponse;
    try {
      response = await this.http.send({
        ...request,
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          'x-restli-protocol-version': '2.0.0',
        },
        timeoutMs: 5_000,
      });
    } catch (error) {
      if (error instanceof HttpTransportError && error.indeterminate && options.mutating) {
        // Only a write can be indeterminate in a way that matters: a read is safe to retry, a
        // reply is not (ADR-006).
        throw new UpstreamIndeterminate();
      }
      throw new UpstreamUnavailable('LinkedIn could not be reached.');
    }

    if (response.status >= 200 && response.status < 300) return response.body;
    throw this.translate(response.status, response.headers, response.body, credential);
  }

  private translate(
    status: number,
    headers: Readonly<Record<string, string>>,
    body: unknown,
    credential: PlatformCredential,
  ): Error {
    const error = linkedInErrorSchema.safeParse(body);
    const message = (error.success ? error.data.message : null) ?? 'LinkedIn rejected the request.';

    if (status === 401 || status === 403) {
      // Never surfaced as 401 to our caller: that would tell them *their* credentials failed.
      return new UpstreamAuthError(credential.connectedAccountId, message, status);
    }
    if (status === 429) {
      return new UpstreamRateLimited(Number(headers['retry-after'] ?? 60), message, status);
    }
    // An expired continuation token is a pagination failure the client fixes by restarting, not
    // an upstream outage to retry (ADR-008).
    if (status === 400 && error.success && error.data.code === 'INVALID_PAGINATION_TOKEN') {
      return CallerError.invalid('CURSOR_EXPIRED', 'The cursor has expired; restart pagination.');
    }
    if (status >= 500) return new UpstreamUnavailable(message, status);
    return new UpstreamRejected(message, status);
  }

  private parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
    const result = schema.safeParse(body);
    if (!result.success) {
      // Our integration is out of date with theirs. Deliberately a SystemError, not an upstream
      // one: the platform answered successfully and we failed to understand it.
      throw new SystemError('PLATFORM_PAYLOAD_UNRECOGNISED', 'LinkedIn returned an unexpected payload.');
    }
    return result.data;
  }
}
