import { z } from 'zod';

/**
 * X's wire shapes. Structurally nothing like LinkedIn's: there is no comment resource at all. A
 * reply is a post, replies are found by searching the conversation, and the author lives in a
 * side-loaded `includes` block that has to be joined back by hand.
 */

export const xTweetSchema = z.object({
  id: z.string(),
  text: z.string(),
  author_id: z.string(),
  created_at: z.string(),
  conversation_id: z.string(),
  /** Absent on the conversation's own first post. Present on every reply, at any depth. */
  in_reply_to_status_id: z.string().nullish(),
  public_metrics: z
    .object({
      reply_count: z.number().int().nonnegative().default(0),
      like_count: z.number().int().nonnegative().default(0),
    })
    .nullish(),
});

export const xUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  profile_image_url: z.string().nullish(),
});

export const xConversationPageSchema = z.object({
  data: z.array(xTweetSchema).default([]),
  includes: z.object({ users: z.array(xUserSchema).default([]) }).prefault({}),
  meta: z.object({ next_token: z.string().nullish() }).prefault({}),
});

export const xCreatedTweetSchema = z.object({
  data: z.object({ id: z.string(), created_at: z.string().nullish() }),
});

export const xErrorSchema = z.object({
  title: z.string().nullish(),
  detail: z.string().nullish(),
});

export type XTweet = z.infer<typeof xTweetSchema>;
export type XUser = z.infer<typeof xUserSchema>;

/** Curated for `Comment.platformMetadata` (ADR-016); read by nothing outside this adapter. */
export const xMetadataSchema = z.object({
  conversationId: z.string(),
  replyCount: z.number().int(),
  likeCount: z.number().int(),
});

export type XMetadata = z.infer<typeof xMetadataSchema>;
