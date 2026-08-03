import type { ConnectedAccountId } from './ids';

/**
 * The error taxonomy (ADR-011). Three families, because failures originate from three places
 * that mean different things to a caller:
 *
 *   caller   — you asked for something wrong. Fix the request.
 *   system   — we are broken. Nothing you can do.
 *   upstream — the platform is broken, or refused, or no longer trusts our token.
 *
 * The trap this exists to avoid: a platform returns 401 for a revoked token, and passing that
 * through tells *our* caller that *their* credentials failed. It maps to 424 instead.
 *
 * Nothing here imports a framework. Status codes are assigned by the exception filter at the
 * transport boundary, which is the only layer entitled to know what HTTP is.
 */

export type ErrorFamily = 'caller' | 'system' | 'upstream';

export abstract class DomainError extends Error {
  abstract readonly family: ErrorFamily;

  protected constructor(
    /** Stable and machine-readable. Part of the public contract; never a platform's own code. */
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type CallerErrorKind = 'invalid' | 'not_found' | 'unprocessable' | 'conflict';

export class CallerError extends DomainError {
  readonly family = 'caller';

  private constructor(
    readonly kind: CallerErrorKind,
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(code, message, details);
  }

  static invalid(code: string, message: string, details?: Record<string, unknown>): CallerError {
    return new CallerError('invalid', code, message, details);
  }

  static notFound(code: string, message: string, details?: Record<string, unknown>): CallerError {
    return new CallerError('not_found', code, message, details);
  }

  static unprocessable(code: string, message: string, details?: Record<string, unknown>): CallerError {
    return new CallerError('unprocessable', code, message, details);
  }

  static conflict(code: string, message: string, details?: Record<string, unknown>): CallerError {
    return new CallerError('conflict', code, message, details);
  }
}

export class SystemError extends DomainError {
  readonly family = 'system';

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

/**
 * Reached by the registry for a platform with no adapter, and by the deferred ingestion and
 * reconciliation stubs. Distinguished from `SystemError` because 501 is the honest status: the
 * request was well-formed and we simply do not implement it yet.
 */
export class NotImplementedError extends SystemError {}

export abstract class UpstreamError extends DomainError {
  readonly family = 'upstream';

  protected constructor(
    code: string,
    message: string,
    readonly platformStatus: number | null,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
  }
}

/** Token revoked or expired. Names the account so the client can send the user to re-authorise it. */
export class UpstreamAuthError extends UpstreamError {
  constructor(
    readonly connectedAccountId: ConnectedAccountId,
    message = 'The connected account must be re-authorised.',
    platformStatus: number | null = null,
  ) {
    super('UPSTREAM_AUTH', message, platformStatus, { connectedAccountId });
  }
}

export class UpstreamRateLimited extends UpstreamError {
  constructor(
    readonly retryAfterSeconds: number,
    message = 'The platform is rate limiting this connected account.',
    platformStatus: number | null = null,
  ) {
    super('UPSTREAM_RATE_LIMITED', message, platformStatus, { retryAfterSeconds });
  }
}

/** Platform 5xx that provably did not apply, or an unreachable platform. Retryable. */
export class UpstreamUnavailable extends UpstreamError {
  constructor(message = 'The platform is unavailable.', platformStatus: number | null = null) {
    super('UPSTREAM_UNAVAILABLE', message, platformStatus);
  }
}

/** The platform understood us and said no: comments closed, content blocked, parent deleted. */
export class UpstreamRejected extends UpstreamError {
  constructor(message: string, platformStatus: number | null = null, details?: Record<string, unknown>) {
    super('UPSTREAM_REJECTED', message, platformStatus, details);
  }
}

/**
 * A timeout, or a connection dropped mid-flight. The whole point of ADR-006's outcome matrix:
 * we cannot say the write landed and we cannot say it did not, and by A8 no platform will tell
 * us. It is never mapped to a 5xx, because a 5xx invites the one retry that can duplicate a
 * public comment.
 */
export class UpstreamIndeterminate extends UpstreamError {
  constructor(message = 'The platform did not respond; the outcome is unknown.') {
    super('UPSTREAM_INDETERMINATE', message, null);
  }
}
