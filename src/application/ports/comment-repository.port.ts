import type { DeliveryState } from '../../domain/comment';
import type {
  ConnectedAccountId,
  LocalReplyId,
  Platform,
  PublicationId,
  TenantScope,
} from '../../domain/ids';
import type { PlatformCredential } from './comment-provider.port';

/**
 * The persistence port. Every method takes a `TenantScope` (ADR-012) — there is no overload that
 * omits it, so an unscoped query does not compile. The signatures are noisier for it; the noise
 * is the point.
 */

export interface PublicationRecord {
  readonly id: PublicationId;
  readonly platform: Platform;
  readonly platformPostId: string;
  readonly connectedAccountId: ConnectedAccountId;
  readonly isPublished: boolean;
  /** A2: a comment stream only exists for a publication in a terminal success state. */
  readonly credential: PlatformCredential;
}

export interface ReplyRecord {
  readonly id: LocalReplyId;
  readonly publicationId: PublicationId;
  readonly connectedAccountId: ConnectedAccountId;
  readonly deliveryState: DeliveryState;
  readonly platformCommentId: string | null;
  readonly parentPlatformCommentId: string | null;
  /** The top-level ancestor, so a reply to one of our own replies can still resolve a collapse. */
  readonly rootPlatformCommentId: string | null;
  readonly body: string;
  readonly depth: number;
  /** ADR-009's disclosure, as recorded at insert time. */
  readonly threadCollapsed: boolean;
  readonly failureCode: string | null;
  readonly createdAt: Date;
}

/**
 * The parent a reply is being attached to, as known from the client's comment reference
 * (ADR-014). If we have never persisted it — the normal case under ADR-003 — a minimal row is
 * materialised from these fields in the same transaction that inserts the reply.
 */
export interface ParentCommentSeed {
  readonly platformCommentId: string;
  readonly rootPlatformCommentId: string | null;
  readonly depth: number;
  readonly authorHandle: string | null;
}

export interface CreatePendingReplyInput {
  readonly publicationId: PublicationId;
  readonly connectedAccountId: ConnectedAccountId;
  /** The comment the reply is *actually* attached to, after ADR-009's collapse has been applied. */
  readonly parent: ParentCommentSeed;
  /** The reply's own depth, which is 1 whenever the thread was collapsed. */
  readonly depth: number;
  readonly threadCollapsed: boolean;
  readonly body: string;
  readonly authorPlatformId: string;
  /** Null when the caller sent no `Idempotency-Key`; the partial index ignores those rows. */
  readonly idempotencyKey: string | null;
}

/**
 * Deduplication is a property of the insert, not a preceding "is this key taken?" read — there is
 * no time-of-check/time-of-use window to lose a race in (ADR-007).
 */
export type CreatePendingReplyResult =
  | { readonly kind: 'created'; readonly reply: ReplyRecord }
  | { readonly kind: 'duplicate'; readonly existing: ReplyRecord };

export interface CommentRepository {
  findPublication(scope: TenantScope, id: PublicationId): Promise<PublicationRecord | null>;

  findReply(scope: TenantScope, id: LocalReplyId): Promise<ReplyRecord | null>;

  createPendingReply(
    scope: TenantScope,
    input: CreatePendingReplyInput,
  ): Promise<CreatePendingReplyResult>;

  markReplySent(
    scope: TenantScope,
    id: LocalReplyId,
    platformCommentId: string,
    platformCreatedAt: Date,
  ): Promise<ReplyRecord>;

  /** Releases the idempotency key in the same transaction that sets the state (ADR-015). */
  markReplyFailed(scope: TenantScope, id: LocalReplyId, failureCode: string): Promise<ReplyRecord>;

  /** Keeps the key: an UNKNOWN reply is the one state a retry could duplicate (ADR-015). */
  markReplyUnknown(scope: TenantScope, id: LocalReplyId): Promise<ReplyRecord>;
}

export const COMMENT_REPOSITORY = Symbol('CommentRepository');
