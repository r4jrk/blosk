import { NotImplementedError } from '../domain/errors';
import type { ConnectedAccountId, Platform, PublicationId, TenantScope } from '../domain/ids';

/**
 * Deliberately unimplemented, and deliberately given real signatures.
 *
 * Neither of these is wired into a module — a stub that is injected somewhere would be an
 * abstraction with no second implementation and no caller, which is the failure mode the brief
 * names. Their value is that the shape of the deferred work is legible, and that the shape shows
 * the deferral was a decision and not an oversight.
 *
 * Ingestion (ADR-003's rejected mirror) is the one that would change the system most: it is the
 * *writer* for the schema that already exists, not a new schema. Reconciliation (ADR-006) is the
 * smaller of the two and is the honest counterpart to `deliveryState = UNKNOWN`.
 */

export interface WebhookDelivery {
  readonly platform: Platform;
  readonly signature: string;
  readonly receivedAt: Date;
  readonly payload: unknown;
}

export interface CommentIngestion {
  /**
   * Verify, decode and upsert. Idempotent by `UNIQUE (publicationId, platformCommentId)` — which
   * is exactly why that constraint exists on a table the current read path never queries.
   */
  ingestWebhookDelivery(delivery: WebhookDelivery): Promise<void>;

  /**
   * Page the whole thread from the platform and upsert it. Needed on day one of a mirror by A6:
   * webhook coverage is inconsistent, so a mirror needs backfill and gap detection immediately,
   * not later. That cost is the substance of ADR-003.
   */
  backfillPublication(scope: TenantScope, publicationId: PublicationId): Promise<void>;
}

export interface ReplyReconciler {
  /**
   * Resolve replies stuck in `UNKNOWN` (ADR-006): list our own recent comments on the affected
   * publications and match them against the pending bodies.
   *
   * The reason this is a stub rather than a small piece of code: it needs a
   * `listOwnRecentComments` capability that the `CommentProvider` port does not have. Adding a
   * port method with one speculative caller would be the wrong order of operations — the method
   * arrives with the reconciler, not before it.
   */
  reconcileUnknownReplies(scope: TenantScope, account: ConnectedAccountId): Promise<number>;
}

export class DeferredCommentIngestion implements CommentIngestion {
  ingestWebhookDelivery(): Promise<void> {
    throw new NotImplementedError('INGESTION_NOT_IMPLEMENTED', 'Webhook ingestion is deferred.');
  }

  backfillPublication(): Promise<void> {
    throw new NotImplementedError('INGESTION_NOT_IMPLEMENTED', 'Backfill is deferred.');
  }
}

export class DeferredReplyReconciler implements ReplyReconciler {
  reconcileUnknownReplies(): Promise<number> {
    throw new NotImplementedError(
      'RECONCILIATION_NOT_IMPLEMENTED',
      'Reconciliation of UNKNOWN replies is deferred.',
    );
  }
}
