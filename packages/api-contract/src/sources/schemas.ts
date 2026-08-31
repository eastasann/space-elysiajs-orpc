import { z } from 'zod'

/** A `feed_url` must be an absolute http(s) URL — mirrors the rule the service enforces. */
const feedUrlSchema = z.url({ protocol: /^https?$/ })

/**
 * A feed the collector reads from.
 *
 * Mirrors `packages/db/src/schema/sources.ts`. Kept independent so this
 * client-safe package never imports the database schema.
 */
export const SourceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  feedUrl: z.string(),
  siteUrl: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type Source = z.infer<typeof SourceSchema>

export const ListSourcesInputSchema = z.object({
  /** 1-based. */
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
})
export type ListSourcesInput = z.infer<typeof ListSourcesInputSchema>

export const ListSourcesOutputSchema = z.object({
  items: z.array(SourceSchema),
  total: z.number().int().nonnegative(),
})
export type ListSourcesOutput = z.infer<typeof ListSourcesOutputSchema>

export const GetSourceInputSchema = z.object({
  id: z.string().min(1),
})
export type GetSourceInput = z.infer<typeof GetSourceInputSchema>

export const CreateSourceInputSchema = z.object({
  name: z.string().min(1),
  feedUrl: feedUrlSchema,
  siteUrl: z.string().nullable().optional(),
})
export type CreateSourceInput = z.infer<typeof CreateSourceInputSchema>

export const UpdateSourceInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  feedUrl: feedUrlSchema.optional(),
  siteUrl: z.string().nullable().optional(),
})
export type UpdateSourceInput = z.infer<typeof UpdateSourceInputSchema>

export const DeactivateSourceInputSchema = z.object({
  id: z.string().min(1),
})
export type DeactivateSourceInput = z.infer<typeof DeactivateSourceInputSchema>

/** Payload of the `CONFLICT` error `create` and `update` raise for a duplicate `feed_url`. */
export const SourceFeedUrlConflictDataSchema = z.object({
  feedUrl: z.string(),
})
export type SourceFeedUrlConflictData = z.infer<typeof SourceFeedUrlConflictDataSchema>

/** Payload of the `NOT_FOUND` error `update` and `deactivate` raise for an unknown id. */
export const SourceNotFoundDataSchema = z.object({
  id: z.string(),
})
export type SourceNotFoundData = z.infer<typeof SourceNotFoundDataSchema>
