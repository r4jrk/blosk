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
  xConversationPageSchema,
  xCreatedTweetSchema,
  xErrorSchema,
} from './x.payloads';
import { mapXThreadPage } from './x.mapper';

/**
 * X transport. One search call returns the entire conversation page — there is no per-comment
 * reply resource and therefore none of LinkedIn's N+1. The two adapters' costs differ because
 * the two APIs differ; that difference is contained here rather than expressed as a conditional
 * anywhere upstream.
 */
export class XCommentProvider implements CommentProvider {
  readonly platform = Platform.X;

  /**
   * `maxThreadDepth` is a clamp rather than a platform limit: on X a reply is a post, so chains
   * are effectively unbounded. Declaring a finite depth is what lets the canonical model promise
   * something it can keep, and it is why `onDepthExceeded` is a separate field — collapse here is
   * a policy for pathological chains, not a workaround for a platform restriction.
   */
  readonly capabilities: PlatformCapabilities = Object.freeze({
    maxThreadDepth: 25,
    maxReplyLength: 280,
    onDepthExceeded: 'collapse',
    mentionFormat: { kind: 'at-handle' },
    paginationDirection: 'newest-first',
  } as const);

  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
  ) {}

  async fetchThreadPage(input: FetchThreadPageInput): Promise<ThreadPage> {
    const body = await this.send(
      {
        method: 'GET',
        url: `${this.baseUrl}/2/tweets/search/recent`,
        query: {
          query: `conversation_id:${input.platformPostId}`,
          max_results: input.pageSize,
          expansions: 'author_id',
          'tweet.fields': 'created_at,conversation_id,in_reply_to_status_id,public_metrics',
          'user.fields': 'username,name,profile_image_url',
          ...(input.cursor === null ? {} : { next_token: input.cursor }),
        },
      },
      input.credential,
      { mutating: false },
    );

    const page = this.parse(xConversationPageSchema, body);
    return mapXThreadPage({
      publicationId: input.publicationId,
      rootPostId: input.platformPostId,
      tweets: page.data,
      users: page.includes.users,
      nextToken: page.meta.next_token ?? null,
      ownPlatformUserId: input.credential.platformUserId,
      maxThreadDepth: this.capabilities.maxThreadDepth,
    });
  }

  async postReply(input: PostReplyInput): Promise<PostedReply> {
    const body = await this.send(
      {
        method: 'POST',
        url: `${this.baseUrl}/2/tweets`,
        body: {
          text: input.body,
          reply: { in_reply_to_tweet_id: input.parentPlatformCommentId },
        },
      },
      input.credential,
      { mutating: true },
    );

    const created = this.parse(xCreatedTweetSchema, body);
    return {
      platformCommentId: created.data.id,
      platformCreatedAt:
        created.data.created_at === null || created.data.created_at === undefined
          ? new Date()
          : new Date(created.data.created_at),
    };
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
        headers: { authorization: `Bearer ${credential.accessToken}` },
        timeoutMs: 5_000,
      });
    } catch (error) {
      if (error instanceof HttpTransportError && error.indeterminate && options.mutating) {
        throw new UpstreamIndeterminate();
      }
      throw new UpstreamUnavailable('X could not be reached.');
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
    const error = xErrorSchema.safeParse(body);
    const message =
      (error.success ? (error.data.detail ?? error.data.title) : null) ?? 'X rejected the request.';

    if (status === 401) {
      return new UpstreamAuthError(credential.connectedAccountId, message, status);
    }
    // Note the divergence from LinkedIn, which is the whole reason error translation lives per
    // adapter: X uses 403 for duplicate content and for a protected conversation — a rejection
    // the caller can act on, not an authorisation failure the account owner must fix.
    if (status === 403) return new UpstreamRejected(message, status);
    if (status === 429) {
      const reset = Number(headers['x-rate-limit-reset'] ?? 0);
      const seconds = reset > 0 ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60;
      return new UpstreamRateLimited(seconds, message, status);
    }
    if (status === 400 && /next_token/i.test(message)) {
      return CallerError.invalid('CURSOR_EXPIRED', 'The cursor has expired; restart pagination.');
    }
    if (status >= 500) return new UpstreamUnavailable(message, status);
    return new UpstreamRejected(message, status);
  }

  private parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new SystemError('PLATFORM_PAYLOAD_UNRECOGNISED', 'X returned an unexpected payload.');
    }
    return result.data;
  }
}
