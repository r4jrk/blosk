/**
 * The outbound HTTP contract adapters are written against. They never import a platform SDK or
 * `fetch` directly, which is what makes the contract test suite able to run every adapter against
 * scripted responses with no network and no SDK-level mocking.
 */

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly query?: Readonly<Record<string, string | number>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Thrown only when we did not get an answer. A non-2xx status is a normal return value, because
 * a 429 or a 401 is information the adapter has to translate, not an exception to unwind.
 *
 * `indeterminate` is the load-bearing flag: it is what separates ADR-006's `UNKNOWN`/202 outcome
 * from a plain retryable failure. A connection refused before the request left is determinate; a
 * timeout after it did is not.
 */
export class HttpTransportError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'HttpTransportError';
  }

  get indeterminate(): boolean {
    return this.kind === 'timeout';
  }
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export const HTTP_CLIENT = Symbol('HttpClient');
