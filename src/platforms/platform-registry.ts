import { NotImplementedError } from '../domain/errors';
import type { Platform } from '../domain/ids';
import type {
  CommentProvider,
  PlatformProviderRegistry,
} from '../application/ports/comment-provider.port';
import type { HttpClient } from '../application/ports/http-client.port';
import { LinkedInCommentProvider } from './linkedin/linkedin.provider';
import { XCommentProvider } from './x/x.provider';

/**
 * The registry is the *only* place in this system that knows platforms differ by identity. Adding
 * platform #7 is one new directory plus one line in `createPlatformProviders` below — nothing in
 * the domain layer, the application services, the controllers, the DTOs or the database schema
 * changes. DESIGN.md §7 asserts that as an invariant; this file is where it is kept.
 *
 * Note that even the keying is derived: providers declare their own `platform`, so the map is
 * built from the list rather than written out by hand, and a mismatched key is not a mistake
 * anyone can make.
 */
export class StaticPlatformProviderRegistry implements PlatformProviderRegistry {
  private readonly byPlatform: ReadonlyMap<Platform, CommentProvider>;

  constructor(providers: readonly CommentProvider[]) {
    this.byPlatform = new Map(providers.map((provider) => [provider.platform, provider]));
  }

  resolve(platform: Platform): CommentProvider {
    const provider = this.byPlatform.get(platform);
    if (provider === undefined) {
      // A publication on a platform we have not adapted yet. 501, not 500: the request was
      // well-formed and the gap is ours and known.
      throw new NotImplementedError(
        'PLATFORM_NOT_SUPPORTED',
        `Comments are not implemented for ${platform}.`,
      );
    }
    return provider;
  }
}

export const createPlatformProviders = (
  http: HttpClient,
  env: NodeJS.ProcessEnv,
): readonly CommentProvider[] => [
  new LinkedInCommentProvider(http, env['LINKEDIN_API_BASE_URL'] ?? 'https://api.linkedin.com/rest'),
  new XCommentProvider(http, env['X_API_BASE_URL'] ?? 'https://api.x.com'),
  // ← platform #7 goes here, and nowhere else.
];
