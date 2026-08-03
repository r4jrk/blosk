import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import {
  CallerError,
  DomainError,
  NotImplementedError,
  UpstreamAuthError,
  UpstreamIndeterminate,
  UpstreamRateLimited,
  UpstreamRejected,
  UpstreamUnavailable,
} from '../domain/errors';
import type { ErrorDto } from './api.contracts';

/**
 * The single place where domain errors acquire HTTP semantics (ADR-011).
 *
 * Keeping this at the boundary is what lets the application layer throw meaningfully without
 * importing the framework, and it is what makes the mapping reviewable as one table rather than
 * as thirty scattered `throw new BadRequestException(...)` calls.
 *
 * Adding a platform adds no code here: an adapter translates its vendor's failures into these
 * types, and the types already have statuses.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body, headers } = this.translate(exception);

    for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
    response.status(status).json(body);
  }

  private translate(exception: unknown): {
    status: number;
    body: ErrorDto;
    headers: Record<string, string>;
  } {
    if (exception instanceof CallerError) {
      const status = { invalid: 400, not_found: 404, unprocessable: 422, conflict: 409 }[
        exception.kind
      ];
      return { status, body: this.body(exception), headers: {} };
    }

    if (exception instanceof UpstreamAuthError) {
      // 424 Failed Dependency, not 401. 401 would tell our caller that *their* credentials failed
      // and send them to re-authenticate — entirely the wrong action. 424 names an actionable
      // state: re-authorise this connected account.
      return { status: 424, body: this.body(exception), headers: {} };
    }

    if (exception instanceof UpstreamRateLimited) {
      // 503, not 429. 429 means the *caller* sent too many requests; it makes well-behaved clients
      // and gateways back off from us, which does nothing to replenish the platform's bucket.
      // 429 stays reserved for our own limiter, where it means what it says.
      return {
        status: 503,
        body: this.body(exception),
        headers: { 'retry-after': String(exception.retryAfterSeconds) },
      };
    }

    if (exception instanceof UpstreamRejected) {
      return { status: 409, body: this.body(exception), headers: {} };
    }

    if (exception instanceof UpstreamUnavailable) {
      return { status: 502, body: this.body(exception), headers: {} };
    }

    if (exception instanceof UpstreamIndeterminate) {
      // Unreachable by construction: the reply service converts this into an UNKNOWN record and a
      // 202 (ADR-006). If it ever surfaces here, a write path lost the record, and 502 is the
      // least-wrong answer — it is at least not a 2xx claiming the comment exists.
      return { status: 502, body: this.body(exception), headers: {} };
    }

    if (exception instanceof NotImplementedError) {
      return { status: 501, body: this.body(exception), headers: {} };
    }

    if (exception instanceof DomainError) {
      this.logger.error(`${exception.code}: ${exception.message}`, exception.stack);
      return { status: 500, body: this.body(exception), headers: {} };
    }

    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        body: { error: { code: 'HTTP_ERROR', message: exception.message } },
        headers: {},
      };
    }

    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : exception);
    return {
      status: 500,
      // Deliberately opaque: an unexpected exception's message can carry internals.
      body: { error: { code: 'INTERNAL', message: 'Unexpected error.' } },
      headers: {},
    };
  }

  private body(error: DomainError): ErrorDto {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
}
