import type { ThreadPage } from '../../domain/comment';
import type { ConnectedAccountId, Platform, PublicationId } from '../../domain/ids';

/**
 * The platform port (ADR-001). One adapter implements it per platform; the registry below
 * resolves platform → provider, and it is the only place in the system entitled to know that
 * platforms differ by identity rather than by capability.
 *
 * Two methods, both mandatory. No `supportsX(): boolean` guards and no optional members: a port
 * that grows one optional method per platform quirk is a port that every caller has to interpret
 * (ADR-005, and the Interface Segregation bar in the brief).
 */

export type MentionFormat =
  /** The platform exposes no stable handle to mention. ADR-009's prefix is simply omitted. */
  | { readonly kind: 'none' }
  | { readonly kind: 'at-handle' }
  /** e.g. LinkedIn's `@[Name](urn:li:person:xxx)`. `{handle}` is substituted. */
  | { readonly kind: 'template'; readonly template: string };

/**
 * Platform differences expressed as data (ADR-005). Application logic branches on these values
 * and never on platform identity — that is the mechanically checkable form of the Open/Closed
 * claim in DESIGN.md §7.
 */
export interface PlatformCapabilities {
  /** 1 = root plus one level of replies. */
  readonly maxThreadDepth: number;
  /** Graphemes, measured *after* the mention prefix is rendered (ADR-009). */
  readonly maxReplyLength: number;
  /** Not derivable from `maxThreadDepth`: it is a product choice per platform, not a limit. */
  readonly onDepthExceeded: 'collapse' | 'reject';
  readonly mentionFormat: MentionFormat;
  readonly paginationDirection: 'newest-first' | 'oldest-first';
}

/** Renders ADR-009's collapse prefix. Branches on the descriptor, never on the platform. */
export const renderMention = (format: MentionFormat, handle: string | null): string | null => {
  if (handle === null || format.kind === 'none') return null;
  return format.kind === 'at-handle' ? `@${handle}` : format.template.replace('{handle}', handle);
};

/** A3: token acquisition and refresh are owned elsewhere in the product. We consume and report. */
export interface PlatformCredential {
  /**
   * Carried so an adapter can name the account in `UpstreamAuthError` — "re-authorise *this*
   * account" is the only actionable form of that failure (ADR-011).
   */
  readonly connectedAccountId: ConnectedAccountId;
  readonly accessToken: string;
  /** Used to derive `isOwnedByUs` on a fetched comment (ADR-010). */
  readonly platformUserId: string;
}

export interface FetchThreadPageInput {
  readonly publicationId: PublicationId;
  readonly platformPostId: string;
  readonly credential: PlatformCredential;
  readonly cursor: string | null;
  readonly pageSize: number;
}

export interface PostReplyInput {
  readonly platformPostId: string;
  /** Already resolved through ADR-009's collapse; the adapter posts exactly here. */
  readonly parentPlatformCommentId: string;
  /** Already includes any mention prefix and has already passed the length check. */
  readonly body: string;
  readonly credential: PlatformCredential;
}

export interface PostedReply {
  readonly platformCommentId: string;
  readonly platformCreatedAt: Date;
}

export interface CommentProvider {
  readonly platform: Platform;
  readonly capabilities: PlatformCapabilities;

  /** Assembles the canonical page itself (ADR-013). The caller never learns the payload shape. */
  fetchThreadPage(input: FetchThreadPageInput): Promise<ThreadPage>;

  postReply(input: PostReplyInput): Promise<PostedReply>;
}

export interface PlatformProviderRegistry {
  /** Throws `NotImplementedError` for a platform with no adapter. */
  resolve(platform: Platform): CommentProvider;
}

export const PLATFORM_PROVIDER_REGISTRY = Symbol('PlatformProviderRegistry');
