import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DeliveryState } from '../domain/comment';
import { SystemError } from '../domain/errors';
import {
  connectedAccountId,
  localReplyId,
  publicationId,
  type LocalReplyId,
  type Platform,
  type PublicationId,
  type TenantScope,
} from '../domain/ids';
import type {
  CommentRepository,
  CreatePendingReplyInput,
  CreatePendingReplyResult,
  PublicationRecord,
  ReplyRecord,
} from '../application/ports/comment-repository.port';
import { PrismaService } from './prisma.service';

/**
 * The Prisma-backed repository. Two properties are worth pointing at:
 *
 *  1. Every method threads `scope.workspaceId` into its `where` clause (ADR-012). The port makes
 *     that unforgettable; this file is where it is honoured.
 *  2. No method opens a transaction that outlives its own statements. The platform call in
 *     `ReplyService` happens strictly after `createPendingReply` has committed — a transaction
 *     held across a third-party round trip pins a pool connection for the duration and exhausts
 *     the pool under any load (ADR-006).
 */

const replyInclude = { parent: { select: { platformCommentId: true } } } as const;
type ReplyRow = Prisma.CommentGetPayload<{ include: typeof replyInclude }>;

const isUniqueViolation = (error: unknown): error is Prisma.PrismaClientKnownRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Which unique index we collided with matters: the idempotency index means "you have sent this
 * before" and is the whole point, while the `(publicationId, platformCommentId)` index means two
 * requests materialised the same parent concurrently and is a benign race to retry, not a replay.
 */
const isIdempotencyViolation = (error: Prisma.PrismaClientKnownRequestError): boolean =>
  JSON.stringify(error.meta?.['target'] ?? '').includes('idempotencyKey');

@Injectable()
export class PrismaCommentRepository implements CommentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPublication(scope: TenantScope, id: PublicationId): Promise<PublicationRecord | null> {
    const row = await this.prisma.postPublication.findFirst({
      where: { id, workspaceId: scope.workspaceId },
      include: { connectedAccount: true },
    });
    if (row === null) return null;

    return {
      id: publicationId(row.id),
      platform: row.platform as Platform,
      platformPostId: row.platformPostId,
      connectedAccountId: connectedAccountId(row.connectedAccountId),
      isPublished: row.state === 'PUBLISHED',
      credential: {
        connectedAccountId: connectedAccountId(row.connectedAccountId),
        accessToken: row.connectedAccount.accessToken,
        platformUserId: row.connectedAccount.platformUserId,
      },
    };
  }

  async findReply(scope: TenantScope, id: LocalReplyId): Promise<ReplyRecord | null> {
    const row = await this.prisma.comment.findFirst({
      where: { id, workspaceId: scope.workspaceId, isOwnedByUs: true },
      include: replyInclude,
    });
    return row === null ? null : this.toReplyRecord(row);
  }

  async createPendingReply(
    scope: TenantScope,
    input: CreatePendingReplyInput,
  ): Promise<CreatePendingReplyResult> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // ADR-014: the parent may be a comment we have never fetched. Materialise the little we
        // know from the client's comment reference so the reply has something to hang off. The
        // nullable columns on `Comment` exist for exactly this row.
        const parent = await tx.comment.upsert({
          where: {
            publicationId_platformCommentId: {
              publicationId: input.publicationId,
              platformCommentId: input.parent.platformCommentId,
            },
          },
          update: {},
          create: {
            workspaceId: scope.workspaceId,
            publicationId: input.publicationId,
            platformCommentId: input.parent.platformCommentId,
            rootPlatformCommentId: input.parent.rootPlatformCommentId,
            depth: input.parent.depth,
            authorHandle: input.parent.authorHandle,
          },
        });

        return tx.comment.create({
          data: {
            workspaceId: scope.workspaceId,
            publicationId: input.publicationId,
            parentId: parent.id,
            // Null when the root itself has never been persisted — the denormalised platform-level
            // column carries the ancestry in that case.
            rootId: parent.rootId ?? parent.id,
            rootPlatformCommentId:
              input.parent.rootPlatformCommentId ?? input.parent.platformCommentId,
            depth: input.depth,
            threadCollapsed: input.threadCollapsed,
            body: input.body,
            authorPlatformId: input.authorPlatformId,
            isOwnedByUs: true,
            connectedAccountId: input.connectedAccountId,
            deliveryState: DeliveryState.Pending,
            idempotencyKey: input.idempotencyKey,
          },
          include: replyInclude,
        });
      });

      return { kind: 'created', reply: this.toReplyRecord(row) };
    } catch (error) {
      if (!isUniqueViolation(error) || !isIdempotencyViolation(error)) throw error;

      const existing = await this.prisma.comment.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          connectedAccountId: input.connectedAccountId,
          idempotencyKey: input.idempotencyKey,
        },
        include: replyInclude,
      });
      if (existing === null) {
        // The key was released between the failed insert and this read — the request is safe to
        // treat as new, but retrying it here would obscure a real invariant break if it is not.
        throw new SystemError(
          'IDEMPOTENCY_RACE',
          'The idempotency key was released concurrently; retry the request.',
        );
      }
      return { kind: 'duplicate', existing: this.toReplyRecord(existing) };
    }
  }

  async markReplySent(
    scope: TenantScope,
    id: LocalReplyId,
    platformCommentId: string,
    platformCreatedAt: Date,
  ): Promise<ReplyRecord> {
    return this.transition(scope, id, {
      deliveryState: DeliveryState.Sent,
      platformCommentId,
      platformCreatedAt,
    });
  }

  async markReplyFailed(
    scope: TenantScope,
    id: LocalReplyId,
    failureCode: string,
  ): Promise<ReplyRecord> {
    return this.transition(scope, id, {
      deliveryState: DeliveryState.Failed,
      failureCode,
      // ADR-015: release the key in the same statement that records the failure. The unique index
      // is partial, so the row is retained for audit without occupying the key — a client that
      // received a 502 and retries correctly is not refused forever.
      idempotencyKey: null,
    });
  }

  async markReplyUnknown(scope: TenantScope, id: LocalReplyId): Promise<ReplyRecord> {
    // Deliberately keeps the key. UNKNOWN is the one state where a retry can duplicate a public
    // comment, so the key must keep blocking it until a human or the reconciler resolves the row.
    return this.transition(scope, id, { deliveryState: DeliveryState.Unknown });
  }

  private async transition(
    scope: TenantScope,
    id: LocalReplyId,
    data: Prisma.CommentUpdateManyMutationInput,
  ): Promise<ReplyRecord> {
    // `updateMany` rather than `update`, because only `updateMany` accepts a non-unique filter and
    // the tenancy predicate has to be part of the write, not a check preceding it.
    const updated = await this.prisma.comment.updateMany({
      where: { id, workspaceId: scope.workspaceId },
      data,
    });
    if (updated.count === 0) {
      throw new SystemError('REPLY_VANISHED', 'The reply row disappeared mid-flight.');
    }
    const row = await this.prisma.comment.findFirstOrThrow({
      where: { id, workspaceId: scope.workspaceId },
      include: replyInclude,
    });
    return this.toReplyRecord(row);
  }

  private toReplyRecord(row: ReplyRow): ReplyRecord {
    if (row.connectedAccountId === null || row.deliveryState === null) {
      throw new SystemError('NOT_AN_OWN_REPLY', 'The row is not a reply authored by this system.');
    }
    return {
      id: localReplyId(row.id),
      publicationId: publicationId(row.publicationId),
      connectedAccountId: connectedAccountId(row.connectedAccountId),
      deliveryState: row.deliveryState as DeliveryState,
      platformCommentId: row.platformCommentId,
      parentPlatformCommentId: row.parent?.platformCommentId ?? null,
      rootPlatformCommentId: row.rootPlatformCommentId,
      body: row.body ?? '',
      depth: row.depth,
      threadCollapsed: row.threadCollapsed,
      failureCode: row.failureCode,
      createdAt: row.createdAt,
    };
  }
}
