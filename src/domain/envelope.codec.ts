import { z } from 'zod';
import { CallerError } from './errors';
import { localReplyId, publicationId, type LocalReplyId, type PublicationId } from './ids';

/**
 * Every identifier this API hands to a client — page cursors (ADR-008) and comment IDs (ADR-014)
 * — is a base64url-encoded, versioned envelope rather than a raw value. One file, because that is
 * one piece of knowledge applied twice, not two coincidentally similar pieces of syntax.
 *
 * The property both decisions buy: the identifiers already held by clients survive a change of
 * read strategy (ADR-003). Under a mirror, a platform-keyed comment reference resolves by indexed
 * lookup instead of by materialisation, and the wire format does not move.
 *
 * Decoding is validation, not parsing. The envelope is encoded, not signed, so every field is
 * re-checked on the way in. Signing was rejected (ADR-008): the envelope carries no authority,
 * and every request is independently scoped by tenancy, so a tampered value yields a decode
 * failure or a scope violation — never another tenant's data.
 */

export const PAGE_SIZE_MIN = 1;
export const PAGE_SIZE_MAX = 100;
export const PAGE_SIZE_DEFAULT = 25;

const pageSizeSchema = z.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX);

const cursorEnvelopeSchema = z.object({
  v: z.literal(1),
  p: z.string().uuid(),
  /** The platform's own token. Never validated beyond "is a string" — see `containment` below. */
  c: z.string().min(1),
  s: pageSizeSchema,
});

const commentRefSchema = z.discriminatedUnion('k', [
  z.object({
    v: z.literal(1),
    k: z.literal('platform'),
    p: z.string().uuid(),
    id: z.string().min(1),
    /** Depth, so ADR-009's collapse can be evaluated without a platform round trip. */
    d: z.number().int().min(0),
    /** Author handle, so the collapse mention can be rendered without a lookup. */
    h: z.string().min(1).optional(),
    /**
     * The root ancestor's platform ID. ADR-014 as written carries only `d` and `h`; implementing
     * ADR-009 showed that a collapse also has to *address* the root, and re-fetching the comment
     * to learn its root would spend exactly the platform round trip this envelope exists to
     * avoid. Absent on a root comment, where the root is the comment itself.
     */
    r: z.string().min(1).optional(),
  }),
  z.object({
    v: z.literal(1),
    k: z.literal('local'),
    p: z.string().uuid(),
    id: z.string().uuid(),
  }),
]);

export interface DecodedCursor {
  readonly platformCursor: string;
  readonly pageSize: number;
}

export type CommentRef =
  | {
      readonly kind: 'platform';
      readonly publicationId: PublicationId;
      readonly platformCommentId: string;
      readonly depth: number;
      readonly authorHandle: string | null;
      readonly rootPlatformCommentId: string | null;
    }
  | {
      readonly kind: 'local';
      readonly publicationId: PublicationId;
      readonly localReplyId: LocalReplyId;
    };

const encode = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const decode = (raw: string): unknown => {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
};

export const encodeCursor = (input: {
  publicationId: PublicationId;
  platformCursor: string;
  pageSize: number;
}): string =>
  encode({ v: 1, p: input.publicationId, c: input.platformCursor, s: input.pageSize });

/**
 * @param routePublicationId the publication in the request path. A cursor minted for one thread
 * and replayed against another is rejected here, which is the check that makes an unsigned
 * envelope safe to hand out.
 */
export const decodeCursor = (raw: string, routePublicationId: PublicationId): DecodedCursor => {
  const parsed = cursorEnvelopeSchema.safeParse(decode(raw));
  if (!parsed.success) {
    throw CallerError.invalid('CURSOR_INVALID', 'The cursor is not a cursor issued by this API.');
  }
  if (parsed.data.p !== routePublicationId) {
    throw CallerError.invalid('CURSOR_INVALID', 'The cursor was issued for a different publication.');
  }
  // `s` is re-validated by the schema above rather than trusted: it is caller-controlled, and a
  // tampered page size would otherwise be an unbounded-response resource-exhaustion path.
  return { platformCursor: parsed.data.c, pageSize: parsed.data.s };
};

export const encodeCommentRef = (ref: CommentRef): string => {
  if (ref.kind === 'local') {
    return encode({ v: 1, k: 'local', p: ref.publicationId, id: ref.localReplyId });
  }
  return encode({
    v: 1,
    k: 'platform',
    p: ref.publicationId,
    id: ref.platformCommentId,
    d: ref.depth,
    ...(ref.authorHandle === null ? {} : { h: ref.authorHandle }),
    ...(ref.rootPlatformCommentId === null ? {} : { r: ref.rootPlatformCommentId }),
  });
};

export const decodeCommentRef = (raw: string, routePublicationId: PublicationId): CommentRef => {
  const parsed = commentRefSchema.safeParse(decode(raw));
  if (!parsed.success) {
    throw CallerError.invalid('COMMENT_REF_INVALID', 'The comment ID is not an ID issued by this API.');
  }
  const envelope = parsed.data;
  if (envelope.p !== routePublicationId) {
    throw CallerError.invalid(
      'COMMENT_REF_INVALID',
      'The comment ID belongs to a different publication.',
    );
  }
  if (envelope.k === 'local') {
    return {
      kind: 'local',
      publicationId: publicationId(envelope.p),
      localReplyId: localReplyId(envelope.id),
    };
  }
  return {
    kind: 'platform',
    publicationId: publicationId(envelope.p),
    platformCommentId: envelope.id,
    depth: envelope.d,
    authorHandle: envelope.h ?? null,
    rootPlatformCommentId: envelope.r ?? null,
  };
};
