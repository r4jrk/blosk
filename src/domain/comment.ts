import type { LocalReplyId, PublicationId } from './ids';

/**
 * The canonical comment model. This is what every adapter mapper produces and what the
 * application layer consumes; no platform vocabulary appears below this line.
 */

/**
 * A platform-native identity, snapshotted at fetch time (ADR-010). Not a user of this product,
 * never joined to one.
 */
export interface AuthorSnapshot {
  readonly platformId: string;
  /** Null where the platform exposes no stable handle — ADR-009's mention degrades accordingly. */
  readonly handle: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface CanonicalComment {
  /** Null only for an OwnReply the platform has not yet assigned an ID to (ADR-006). */
  readonly platformCommentId: string | null;
  /** Set only for an OwnReply of ours; this is the handle for `GET /replies/{id}`. */
  readonly localReplyId: LocalReplyId | null;
  readonly parentPlatformCommentId: string | null;
  /** Null on a root comment, else the top-level ancestor within this publication (ADR-004). */
  readonly rootPlatformCommentId: string | null;
  /** 0 at the root. Clamped by the adapter to the platform's declared `maxThreadDepth`. */
  readonly depth: number;
  readonly body: string;
  readonly author: AuthorSnapshot;
  readonly isOwnedByUs: boolean;
  readonly platformCreatedAt: Date;
  /**
   * Populated on root comments only. A thread page is a page of roots each carrying its replies;
   * deeper structure is flattened here in order, with true `depth` preserved (ADR-004, ADR-013).
   */
  readonly replies: readonly CanonicalComment[];
}

/**
 * One page of a thread, assembled by an adapter mapper (ADR-013) — never by a database query
 * under the current read strategy, and never by the application service.
 */
export interface ThreadPage {
  readonly publicationId: PublicationId;
  readonly comments: readonly CanonicalComment[];
  /**
   * The platform's own next-page token, opaque to us. It is wrapped in our versioned envelope
   * before it ever reaches a client (ADR-008) — this field never crosses the API boundary.
   */
  readonly nextPlatformCursor: string | null;
}

/** Set only on an OwnReply (ADR-006). */
export const DeliveryState = {
  Pending: 'PENDING',
  Sent: 'SENT',
  Failed: 'FAILED',
  Unknown: 'UNKNOWN',
} as const;

export type DeliveryState = (typeof DeliveryState)[keyof typeof DeliveryState];
