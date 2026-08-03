import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { encodeCommentRef } from '../domain/envelope.codec';
import { localReplyId } from '../domain/ids';
import { ReplyService } from '../application/reply.service';
import { ErrorDto, ReplyDto, parseOrThrow, toReplyDto, uuidParamSchema } from './api.contracts';
import { TenantScopeGuard, tenantScopeOf } from './tenant-scope.guard';

/**
 * The delivery-status resource. Not optional decoration: ADR-006 answers a timed-out reply with
 * `202` and a `Location` pointing here, so without this endpoint that header dangles.
 *
 * It is also the resource a reconciler would update, which is why the state it reports is the
 * durable `deliveryState` rather than anything derived at read time.
 */
@ApiTags('replies')
@ApiHeader({ name: 'x-workspace-id', required: true })
@UseGuards(TenantScopeGuard)
@Controller('replies')
export class RepliesController {
  constructor(private readonly replies: ReplyService) {}

  @Get(':replyId')
  @ApiOperation({
    summary: 'Delivery status of a reply',
    description:
      'PENDING — committed locally, not yet acknowledged. SENT — published, with its comment ID. FAILED — determinately not published; the idempotency key has been released, so the same key may be retried. UNKNOWN — the platform never answered and the outcome is genuinely undetermined; this state is never retried automatically, because a retry is the one action that can duplicate a public comment.',
  })
  @ApiResponse({ status: 200, type: ReplyDto })
  @ApiResponse({ status: 404, type: ErrorDto })
  async getReply(@Param('replyId') id: string, @Req() request: Request): Promise<ReplyDto> {
    const reply = await this.replies.getReply(
      tenantScopeOf(request),
      localReplyId(parseOrThrow(uuidParamSchema, id, 'REPLY_ID_INVALID')),
    );

    return toReplyDto(
      reply,
      encodeCommentRef({
        kind: 'platform',
        publicationId: reply.publicationId,
        platformCommentId: reply.parentPlatformCommentId ?? '',
        depth: Math.max(0, reply.depth - 1),
        authorHandle: null,
        rootPlatformCommentId: reply.rootPlatformCommentId,
      }),
    );
  }
}
