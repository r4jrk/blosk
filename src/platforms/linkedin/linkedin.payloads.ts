import { z } from 'zod';

/**
 * LinkedIn's wire shapes. These schemas are the outer edge of the anti-corruption layer: nothing
 * above this directory ever sees a `commentUrn` or an `actor`.
 *
 * Parsing rather than casting is the point. A platform that quietly changes a field fails here,
 * at the boundary, with the payload in hand — not four layers up as an undefined property.
 */

const linkedInActorSchema = z.object({
  id: z.string(),
  localizedName: z.string(),
  /** LinkedIn's public handle. Absent for members who have not set one — hence nullable. */
  vanityName: z.string().nullish(),
  profilePictureUrl: z.string().nullish(),
});

export const linkedInCommentSchema = z.object({
  commentUrn: z.string(),
  actor: linkedInActorSchema,
  message: z.object({ text: z.string() }),
  createdAtMs: z.number().int(),
  /** Present only on a reply. LinkedIn permits exactly one level, so this is always a root URN. */
  parentComment: z.string().nullish(),
  replyCount: z.number().int().nonnegative().default(0),
  likeCount: z.number().int().nonnegative().default(0),
});

export const linkedInCommentPageSchema = z.object({
  elements: z.array(linkedInCommentSchema),
  paging: z
    .object({
      /** LinkedIn's opaque continuation token. Ours never leaves the adapter (ADR-008). */
      nextToken: z.string().nullish(),
    })
    .default({}),
});

export const linkedInCreatedCommentSchema = z.object({
  commentUrn: z.string(),
  createdAtMs: z.number().int(),
});

/** LinkedIn's error envelope, used to tell an expired cursor apart from a real rejection. */
export const linkedInErrorSchema = z.object({
  serviceErrorCode: z.number().int().nullish(),
  code: z.string().nullish(),
  message: z.string().nullish(),
});

export type LinkedInComment = z.infer<typeof linkedInCommentSchema>;
export type LinkedInCommentPage = z.infer<typeof linkedInCommentPageSchema>;

/**
 * The curated subset persisted to `Comment.platformMetadata` (ADR-016). Curated, not raw: a whole
 * payload would be unbounded row growth and would silently retain personal data we have no basis
 * to keep. Nothing outside this adapter reads it.
 */
export const linkedInMetadataSchema = z.object({
  actorUrn: z.string(),
  likeCount: z.number().int(),
  replyCount: z.number().int(),
});

export type LinkedInMetadata = z.infer<typeof linkedInMetadataSchema>;
