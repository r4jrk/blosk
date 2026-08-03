import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CommentReadService } from './application/comment-read.service';
import { ReplyService } from './application/reply.service';
import {
  PLATFORM_PROVIDER_REGISTRY,
  type PlatformProviderRegistry,
} from './application/ports/comment-provider.port';
import { COMMENT_REPOSITORY, type CommentRepository } from './application/ports/comment-repository.port';
import { HEALTH_INDICATORS } from './application/ports/health.port';
import { HTTP_CLIENT, type HttpClient } from './application/ports/http-client.port';
import { THREAD_CACHE, type ThreadCache } from './application/ports/thread-cache.port';
import { DragonflyThreadCache } from './infrastructure/dragonfly-thread-cache';
import { FetchHttpClient } from './infrastructure/fetch-http-client';
import { PrismaCommentRepository } from './infrastructure/prisma-comment.repository';
import { PrismaService } from './infrastructure/prisma.service';
import { createPlatformProviders, StaticPlatformProviderRegistry } from './platforms/platform-registry';
import { CommentsController } from './transport/comments.controller';
import { DomainErrorFilter } from './transport/domain-error.filter';
import { HealthController } from './transport/health.controller';
import { RepliesController } from './transport/replies.controller';

/**
 * Composition root.
 *
 * The application services are registered with `useFactory` rather than `@Injectable()` because
 * they are plain classes: the domain and application layers import nothing from `@nestjs/*`, and
 * decorating them would break exactly the property that makes them testable with three hand-built
 * fakes and no test module (ADR-001). Nest is wiring here, not architecture.
 */
@Module({
  controllers: [CommentsController, RepliesController, HealthController],
  providers: [
    PrismaService,
    { provide: COMMENT_REPOSITORY, useClass: PrismaCommentRepository },
    { provide: HTTP_CLIENT, useClass: FetchHttpClient },
    {
      provide: DragonflyThreadCache,
      useFactory: () => new DragonflyThreadCache(process.env['REDIS_URL'] ?? 'redis://localhost:6379'),
    },
    { provide: THREAD_CACHE, useExisting: DragonflyThreadCache },
    {
      provide: PLATFORM_PROVIDER_REGISTRY,
      inject: [HTTP_CLIENT],
      useFactory: (http: HttpClient) =>
        new StaticPlatformProviderRegistry(createPlatformProviders(http, process.env)),
    },
    {
      provide: CommentReadService,
      inject: [COMMENT_REPOSITORY, THREAD_CACHE, PLATFORM_PROVIDER_REGISTRY],
      useFactory: (
        repository: CommentRepository,
        cache: ThreadCache,
        registry: PlatformProviderRegistry,
      ) => new CommentReadService(repository, cache, registry),
    },
    {
      provide: ReplyService,
      inject: [COMMENT_REPOSITORY, PLATFORM_PROVIDER_REGISTRY],
      useFactory: (repository: CommentRepository, registry: PlatformProviderRegistry) =>
        new ReplyService(repository, registry),
    },
    {
      provide: HEALTH_INDICATORS,
      inject: [PrismaService, DragonflyThreadCache],
      useFactory: (postgres: PrismaService, cache: DragonflyThreadCache) => [postgres, cache],
    },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AppModule {}
