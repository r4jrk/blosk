import { createHash } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { CanonicalComment, ThreadPage } from '../domain/comment';
import { publicationId, type TenantScope } from '../domain/ids';
import type { HealthIndicator } from '../application/ports/health.port';
import type { ThreadCache, ThreadPageCacheKey } from '../application/ports/thread-cache.port';

/**
 * DragonflyDB (Redis wire protocol) as a page-response cache — one of the two jobs the cache
 * genuinely earns here (ADR-003, ADR-007).
 *
 * The TTL is short on purpose. This exists to absorb refresh-spam and back-and-forth pagination
 * against a platform rate limit, not to make the system fast; a human paging through a thread will
 * not notice 60 seconds of staleness, and no read strategy protects against the hazard that
 * actually matters (replying to a comment deleted moments ago), which only the write path catches.
 */
const TTL_SECONDS = 60;
const PROBE_TIMEOUT_MS = 1_000;

/** Wire shape. Deliberately not the domain type: `Date` does not survive JSON. */
interface CachedComment extends Omit<CanonicalComment, 'platformCreatedAt' | 'replies'> {
  readonly platformCreatedAt: string;
  readonly replies: readonly CachedComment[];
}

interface CachedPage {
  readonly publicationId: string;
  readonly comments: readonly CachedComment[];
  readonly nextPlatformCursor: string | null;
}

const revive = (comment: CachedComment): CanonicalComment => ({
  ...comment,
  platformCreatedAt: new Date(comment.platformCreatedAt),
  replies: comment.replies.map(revive),
});

@Injectable()
export class DragonflyThreadCache implements ThreadCache, HealthIndicator, OnModuleDestroy {
  readonly name = 'dragonfly';
  /**
   * Optional, and this is ADR-017's actual decision rather than a shrug: the cache is an
   * optimisation, so failing readiness when it is down would pull healthy instances out of
   * rotation and turn a degradation into an outage.
   */
  readonly criticality = 'optional' as const;

  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1 });
    // A cache is not a dependency whose failure should crash the process.
    this.redis.on('error', () => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }

  async get(scope: TenantScope, key: ThreadPageCacheKey): Promise<ThreadPage | null> {
    const raw = await this.redis.get(this.keyFor(scope, key)).catch(() => null);
    if (raw === null) return null;
    try {
      const cached = JSON.parse(raw) as CachedPage;
      return {
        publicationId: publicationId(cached.publicationId),
        comments: cached.comments.map(revive),
        nextPlatformCursor: cached.nextPlatformCursor,
      };
    } catch {
      // A malformed entry is a cache miss, never an error: the platform is always the fallback.
      return null;
    }
  }

  async set(scope: TenantScope, key: ThreadPageCacheKey, page: ThreadPage): Promise<void> {
    await this.redis
      .set(this.keyFor(scope, key), JSON.stringify(page), 'EX', TTL_SECONDS)
      .catch(() => undefined);
  }

  async check(): Promise<void> {
    await Promise.race([
      this.redis.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('dragonfly probe timed out')), PROBE_TIMEOUT_MS).unref(),
      ),
    ]);
  }

  /**
   * Composed from the `TenantScope`, never from a caller-supplied string. The publication ID is a
   * UUID we mint and is already globally unique, so the workspace segment is not what makes the
   * key correct — it is what makes the cache obey the *same* structural guarantee the repository
   * does (ADR-003, ADR-012). A cache read does not pass through the repository, so without this
   * it would sit outside that guarantee and the safety argument would have to be reconstructed by
   * whoever reads the code next.
   */
  private keyFor(scope: TenantScope, key: ThreadPageCacheKey): string {
    const cursorHash =
      key.platformCursor === null
        ? 'first'
        : createHash('sha256').update(key.platformCursor).digest('base64url').slice(0, 16);
    return `comments:v1:${scope.cacheNamespace}:${key.publicationId}:${cursorHash}:${key.pageSize}`;
  }
}
