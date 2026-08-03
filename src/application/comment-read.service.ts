import { CallerError } from '../domain/errors';
import { encodeCursor, decodeCursor, PAGE_SIZE_DEFAULT } from '../domain/envelope.codec';
import type { PublicationId, TenantScope } from '../domain/ids';
import type { ThreadPage } from '../domain/comment';
import type {
  CommentRepository,
  PublicationRecord,
} from './ports/comment-repository.port';
import type {
  PlatformCapabilities,
  PlatformProviderRegistry,
} from './ports/comment-provider.port';
import type { ThreadCache } from './ports/thread-cache.port';

/**
 * Use case 1 — retrieve the comments for a published post.
 *
 * The ordering below is the whole of ADR-003's safety argument, so it is worth reading as a
 * sequence rather than as steps: decode the cursor, resolve the publication *under the tenant
 * scope*, only then consult the cache, and only then call the platform. Authorisation happens
 * before the cache, so a cache hit can never skip it.
 */

export interface ReadThreadQuery {
  readonly publicationId: PublicationId;
  readonly cursor: string | null;
  /** Ignored when a cursor is present: the cursor's page size wins (ADR-008). */
  readonly pageSize: number | null;
}

export interface ThreadPageResult {
  readonly page: ThreadPage;
  /** Our envelope, not the platform's token. */
  readonly nextCursor: string | null;
  readonly capabilities: PlatformCapabilities;
}

/**
 * The shared precondition of both use cases (A2): comments exist for a publication in a terminal
 * success state, and only within the caller's workspace. Exported and reused rather than repeated
 * — this is one rule, and two copies of it are two places for it to drift.
 */
export const requirePublicationForComments = async (
  repository: CommentRepository,
  scope: TenantScope,
  id: PublicationId,
): Promise<PublicationRecord> => {
  const publication = await repository.findPublication(scope, id);
  // A publication in another workspace is reported as absent, not as forbidden: "not yours" and
  // "does not exist" must be indistinguishable, or the endpoint becomes an existence oracle.
  if (publication === null) {
    throw CallerError.notFound('PUBLICATION_NOT_FOUND', 'No such publication.');
  }
  if (!publication.isPublished) {
    throw CallerError.unprocessable(
      'PUBLICATION_NOT_PUBLISHED',
      'This publication has not been published, so it has no comment stream.',
    );
  }
  return publication;
};

export class CommentReadService {
  constructor(
    private readonly repository: CommentRepository,
    private readonly cache: ThreadCache,
    private readonly registry: PlatformProviderRegistry,
  ) {}

  async readThreadPage(scope: TenantScope, query: ReadThreadQuery): Promise<ThreadPageResult> {
    const decoded = query.cursor === null ? null : decodeCursor(query.cursor, query.publicationId);
    const pageSize = decoded?.pageSize ?? query.pageSize ?? PAGE_SIZE_DEFAULT;
    const platformCursor = decoded?.platformCursor ?? null;

    const publication = await requirePublicationForComments(
      this.repository,
      scope,
      query.publicationId,
    );
    const provider = this.registry.resolve(publication.platform);
    const cacheKey = { publicationId: publication.id, platformCursor, pageSize };

    const cached = await this.cache.get(scope, cacheKey);
    const page =
      cached ??
      (await provider.fetchThreadPage({
        publicationId: publication.id,
        platformPostId: publication.platformPostId,
        credential: publication.credential,
        cursor: platformCursor,
        pageSize,
      }));

    if (cached === null) {
      // Deliberately not awaited into the critical path's failure surface: a cache write failing
      // must not fail a read that already succeeded.
      await this.cache.set(scope, cacheKey, page).catch(() => undefined);
    }

    return {
      page,
      nextCursor:
        page.nextPlatformCursor === null
          ? null
          : encodeCursor({
              publicationId: publication.id,
              platformCursor: page.nextPlatformCursor,
              pageSize,
            }),
      capabilities: provider.capabilities,
    };
  }

  /**
   * Exposed so a UI can disable a reply box, count characters, or warn about ADR-009's collapse
   * before the user types. The server stays correct without anyone calling it.
   */
  async capabilitiesFor(
    scope: TenantScope,
    id: PublicationId,
  ): Promise<PlatformCapabilities> {
    const publication = await requirePublicationForComments(this.repository, scope, id);
    return this.registry.resolve(publication.platform).capabilities;
  }
}
