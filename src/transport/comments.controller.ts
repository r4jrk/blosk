import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CallerError } from '../domain/errors';
import { publicationId as toPublicationId } from '../domain/ids';
import { CommentReadService } from '../application/comment-read.service';
import { ReplyService } from '../application/reply.service';
import {
  CapabilitiesDto,
  ErrorDto,
  ReplyDto,
  ThreadPageDto,
  idempotencyKeySchema,
  listCommentsQuerySchema,
  parseOrThrow,
  postReplyBodySchema,
  toCapabilitiesDto,
  toReplyDto,
  toThreadPageDto,
  uuidParamSchema,
} from './api.contracts';
import { TenantScopeGuard, tenantScopeOf } from './tenant-scope.guard';

/**
 * Comments hang off a **publication**, not a post (ADR-002). One scheduled post fans out to N
 * connected accounts, each of which gets its own platform post ID, its own comment stream, its own
 * token and its own rate-limit budget — so `/posts/{id}/comments` would have no single correct
 * answer, and merging N streams whose cursors are mutually incomparable is a different problem.
 */
@ApiTags('comments')
@ApiHeader({
  name: 'x-workspace-id',
  required: true,
  description: 'Tenant scope. Stands in for the workspace claim on the authenticated principal.',
})
@ApiResponse({ status: 400, type: ErrorDto })
@ApiResponse({ status: 404, type: ErrorDto })
@ApiResponse({ status: 424, type: ErrorDto, description: 'The connected account must be re-authorised.' })
@ApiResponse({ status: 502, type: ErrorDto, description: 'The platform is unavailable.' })
@ApiResponse({ status: 503, type: ErrorDto, description: 'The platform is rate limiting us. Honour Retry-After.' })
@UseGuards(TenantScopeGuard)
@Controller('publications/:publicationId')
export class CommentsController {
  constructor(
    private readonly reads: CommentReadService,
    private readonly replies: ReplyService,
  ) {}

  @Get('comments')
  @ApiOperation({
    summary: 'Retrieve the comment thread for a published post',
    description:
      'Returns a page of top-level comments, each with its replies attached. Read live from the platform with a short-lived cache, so freshness is bounded by roughly a minute.\n\n' +
      'Pagination is cursor-based and the cursor is opaque: it is issued by this API, it is not the platform\'s token, and it must be passed back verbatim. The cursor carries its own page size, so once a sequence has started the pageSize query parameter is ignored — changing page size mid-sequence would corrupt the platform\'s own cursor semantics. An expired cursor is a 400 (CURSOR_EXPIRED): restart pagination rather than retrying.',
  })
  @ApiParam({ name: 'publicationId', format: 'uuid' })
  @ApiResponse({ status: 200, type: ThreadPageDto })
  @ApiResponse({ status: 422, type: ErrorDto, description: 'The publication has not been published.' })
  async listComments(
    @Param('publicationId') publication: string,
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<ThreadPageDto> {
    const id = toPublicationId(parseOrThrow(uuidParamSchema, publication, 'PUBLICATION_ID_INVALID'));
    const { cursor, pageSize } = parseOrThrow(listCommentsQuerySchema, query, 'QUERY_INVALID');

    const result = await this.reads.readThreadPage(tenantScopeOf(request), {
      publicationId: id,
      cursor: cursor ?? null,
      pageSize: pageSize ?? null,
    });
    return toThreadPageDto(result.page, result.nextCursor);
  }

  @Get('comment-capabilities')
  @ApiOperation({
    summary: 'What this publication’s platform allows',
    description:
      'Lets a UI disable a reply box, show a character counter, or warn that a reply will be collapsed before the user types. The API is correct without it — this is an affordance, not a precondition.',
  })
  @ApiResponse({ status: 200, type: CapabilitiesDto })
  async capabilities(
    @Param('publicationId') publication: string,
    @Req() request: Request,
  ): Promise<CapabilitiesDto> {
    const id = toPublicationId(parseOrThrow(uuidParamSchema, publication, 'PUBLICATION_ID_INVALID'));
    return toCapabilitiesDto(await this.reads.capabilitiesFor(tenantScopeOf(request), id));
  }

  @Post('comments/:commentId/replies')
  @ApiOperation({
    summary: 'Reply to a comment',
    description:
      '**parentId is a request, not a guarantee.** Where the platform cannot accept a reply at the requested depth, the reply is re-pointed at the thread root with a mention of the original author prefixed to its body, and the response says so via `threadCollapsed` and `effectiveParentId`. This mirrors what the platforms\' own clients do, so the published result matches what the audience sees natively.\n\n' +
      '**Clients must handle 202.** If the platform never answers, the outcome is genuinely unknown: we hold a durable record but cannot claim the comment exists, and returning a 5xx would invite the one retry that can duplicate a public comment. The 202 carries a Location for the delivery-status resource.\n\n' +
      '**Idempotency-Key** deduplicates per connected account. Replaying a key returns 200 with the existing reply if it was posted, 409 if an identical request is still in flight, and 202 if its outcome is unknown. A key whose reply failed determinately is released, so a normal retry proceeds as new.',
  })
  @ApiParam({ name: 'commentId', description: 'A comment ID from the thread response. Opaque.' })
  @ApiHeader({ name: 'idempotency-key', required: false })
  @ApiResponse({ status: 201, type: ReplyDto, description: 'Posted.' })
  @ApiResponse({ status: 200, type: ReplyDto, description: 'Idempotent replay; nothing was created.' })
  @ApiResponse({ status: 202, type: ReplyDto, description: 'Outcome unknown; poll the Location.' })
  @ApiResponse({ status: 409, type: ErrorDto, description: 'Still in flight, or the platform refused.' })
  @ApiResponse({ status: 422, type: ErrorDto, description: 'Too long for the platform, or too deep.' })
  async postReply(
    @Param('publicationId') publication: string,
    @Param('commentId') commentId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReplyDto> {
    const id = toPublicationId(parseOrThrow(uuidParamSchema, publication, 'PUBLICATION_ID_INVALID'));
    const payload = parseOrThrow(postReplyBodySchema, body, 'BODY_INVALID');
    const key = parseOrThrow(idempotencyKeySchema, idempotencyKey, 'IDEMPOTENCY_KEY_INVALID');

    const outcome = await this.replies.postReply(tenantScopeOf(request), {
      publicationId: id,
      parentCommentId: commentId,
      body: payload.body,
      idempotencyKey: key ?? null,
    });

    if (outcome.status === 'in-flight') {
      // Set before throwing: the filter adds its own headers but does not clear ours.
      response.setHeader('retry-after', '1');
      throw CallerError.conflict(
        'REPLY_IN_FLIGHT',
        'An identical reply is already being delivered. Wait and re-read it.',
        { replyId: outcome.reply.id },
      );
    }

    const status = { created: 201, replayed: 200, indeterminate: 202 }[outcome.status];
    response.status(status);
    if (status !== 200) {
      response.setHeader('location', `/api/v1/replies/${outcome.reply.id}`);
    }
    return toReplyDto(outcome.reply, outcome.effectiveParentCommentId);
  }
}
