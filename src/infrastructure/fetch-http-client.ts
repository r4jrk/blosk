import { Injectable } from '@nestjs/common';
import {
  HttpTransportError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../application/ports/http-client.port';

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The one place in the system that performs outbound network I/O.
 *
 * It never throws on a non-2xx: an adapter has to *translate* a 401 or a 429, and an exception
 * would smuggle the platform's own semantics past the anti-corruption layer. It throws only when
 * there is no answer to translate — and it distinguishes a timeout from a connection failure,
 * because that distinction is what separates ADR-006's `UNKNOWN`/202 from a plain retryable error.
 */
@Injectable()
export class FetchHttpClient implements HttpClient {
  async send(request: HttpRequest): Promise<HttpResponse> {
    const url = new URL(request.url);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      // Platform cursors arrive here and are encoded as parameter values by the URL API — never
      // interpolated into a path (ADR-008).
      url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: request.method,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });

      const text = await response.text();
      return {
        status: response.status,
        body: text === '' ? null : safeJson(text),
        headers: Object.fromEntries(response.headers.entries()),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HttpTransportError('timeout', `Request to ${url.host} timed out.`);
      }
      throw new HttpTransportError('network', `Request to ${url.host} failed.`);
    } finally {
      clearTimeout(timer);
    }
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};
