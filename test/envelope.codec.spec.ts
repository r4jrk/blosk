import {
  decodeCommentRef,
  decodeCursor,
  encodeCommentRef,
  encodeCursor,
  PAGE_SIZE_MAX,
} from '../src/domain/envelope.codec';
import { localReplyId, publicationId } from '../src/domain/ids';

const PUB = publicationId('11111111-1111-4111-8111-111111111111');
const OTHER_PUB = publicationId('33333333-3333-4333-8333-333333333333');

const tamper = (encoded: string, mutate: (payload: Record<string, unknown>) => void): string => {
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  mutate(payload);
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
};

describe('cursors (ADR-008)', () => {
  const cursor = encodeCursor({ publicationId: PUB, platformCursor: 'plat-1', pageSize: 25 });

  it('round-trips', () => {
    expect(decodeCursor(cursor, PUB)).toEqual({ platformCursor: 'plat-1', pageSize: 25 });
  });

  it('is opaque — no platform token is visible in the value handed to a client', () => {
    expect(cursor).not.toContain('plat-1');
  });

  // The check that makes an unsigned envelope safe: a cursor cannot be replayed against a thread
  // it was not issued for.
  it('refuses a cursor issued for another publication', () => {
    expect(() => decodeCursor(cursor, OTHER_PUB)).toThrow(/different publication/);
  });

  // pageSize rides inside the envelope so a page sequence stays self-consistent, which makes it
  // caller-controlled — and therefore a resource-exhaustion path if it were merely parsed.
  it('re-validates a tampered page size instead of trusting it', () => {
    const inflated = tamper(cursor, (payload) => {
      payload['s'] = PAGE_SIZE_MAX * 1_000;
    });
    expect(() => decodeCursor(inflated, PUB)).toThrow(/not a cursor issued by this API/);
  });

  it('rejects an unsupported envelope version', () => {
    const future = tamper(cursor, (payload) => {
      payload['v'] = 2;
    });
    expect(() => decodeCursor(future, PUB)).toThrow();
  });

  it('rejects a value that is not one of ours at all', () => {
    expect(() => decodeCursor('not-base64url-json', PUB)).toThrow();
  });
});

describe('comment references (ADR-014)', () => {
  it('round-trips a platform-keyed reference with the fields the write path needs', () => {
    const encoded = encodeCommentRef({
      kind: 'platform',
      publicationId: PUB,
      platformCommentId: 'urn:li:comment:1',
      depth: 1,
      authorHandle: 'alice',
      rootPlatformCommentId: 'urn:li:comment:0',
    });

    // depth and handle ride along precisely so that replying to a comment we have never stored
    // costs no platform round trip.
    expect(decodeCommentRef(encoded, PUB)).toEqual({
      kind: 'platform',
      publicationId: PUB,
      platformCommentId: 'urn:li:comment:1',
      depth: 1,
      authorHandle: 'alice',
      rootPlatformCommentId: 'urn:li:comment:0',
    });
  });

  it('round-trips a reference to one of our own replies that has no platform ID yet', () => {
    const id = localReplyId('44444444-4444-4444-8444-444444444444');
    const encoded = encodeCommentRef({ kind: 'local', publicationId: PUB, localReplyId: id });
    expect(decodeCommentRef(encoded, PUB)).toEqual({
      kind: 'local',
      publicationId: PUB,
      localReplyId: id,
    });
  });

  it('omits the optional fields rather than encoding nulls for them', () => {
    const encoded = encodeCommentRef({
      kind: 'platform',
      publicationId: PUB,
      platformCommentId: 'c1',
      depth: 0,
      authorHandle: null,
      rootPlatformCommentId: null,
    });
    expect(decodeCommentRef(encoded, PUB)).toMatchObject({
      authorHandle: null,
      rootPlatformCommentId: null,
    });
  });

  it('does not leak a platform identifier in readable form', () => {
    const encoded = encodeCommentRef({
      kind: 'platform',
      publicationId: PUB,
      platformCommentId: 'urn:li:comment:1',
      depth: 0,
      authorHandle: null,
      rootPlatformCommentId: null,
    });
    expect(encoded).not.toContain('urn:li:comment:1');
  });

  it('refuses a reference belonging to another publication', () => {
    const encoded = encodeCommentRef({
      kind: 'platform',
      publicationId: PUB,
      platformCommentId: 'c1',
      depth: 0,
      authorHandle: null,
      rootPlatformCommentId: null,
    });
    expect(() => decodeCommentRef(encoded, OTHER_PUB)).toThrow(/different publication/);
  });
});
