import type { ThreadPage } from '../../domain/comment';
import type { PublicationId, TenantScope } from '../../domain/ids';

/**
 * Page-response caching (ADR-003). This is one of the two jobs the cache genuinely earns:
 * a manager paging back and forth through a thread otherwise burns platform rate limit, which is
 * the scarcest resource in the system.
 *
 * It tolerates eviction completely — the worst case is a redundant platform call. That is the
 * test that kept idempotency records *out* of the cache (ADR-007), where an eviction costs a
 * duplicate public comment instead.
 *
 * The port takes a `TenantScope` for the same reason the repository does (ADR-012): the cache is
 * a second data path out of the system, and it does not go through the repository's guarantee.
 * The key is composed from the scope here, never from a caller-supplied string.
 */
export interface ThreadCache {
  get(scope: TenantScope, key: ThreadPageCacheKey): Promise<ThreadPage | null>;
  set(scope: TenantScope, key: ThreadPageCacheKey, page: ThreadPage): Promise<void>;
}

export interface ThreadPageCacheKey {
  readonly publicationId: PublicationId;
  /** Null on the first page. Hashed by the implementation — platform cursors can be long. */
  readonly platformCursor: string | null;
  readonly pageSize: number;
}

export const THREAD_CACHE = Symbol('ThreadCache');
