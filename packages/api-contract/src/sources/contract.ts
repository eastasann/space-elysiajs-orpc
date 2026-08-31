import { oc } from '@orpc/contract'
import {
  CreateSourceInputSchema,
  DeactivateSourceInputSchema,
  GetSourceInputSchema,
  ListSourcesInputSchema,
  ListSourcesOutputSchema,
  SourceFeedUrlConflictDataSchema,
  SourceNotFoundDataSchema,
  SourceSchema,
  UpdateSourceInputSchema,
} from './schemas.ts'

/** Raised by `create` and `update` when `feed_url` collides with an existing source. */
const feedUrlConflict = {
  CONFLICT: {
    message: 'a source with this feed url already exists',
    data: SourceFeedUrlConflictDataSchema,
  },
} as const

/** Raised by `update` and `deactivate` when `id` names no existing source. */
const notFound = {
  NOT_FOUND: {
    message: 'no source with this id exists',
    data: SourceNotFoundDataSchema,
  },
} as const

export const sourcesContract = {
  list: oc.input(ListSourcesInputSchema).output(ListSourcesOutputSchema),
  get: oc.input(GetSourceInputSchema).output(SourceSchema.nullable()),
  create: oc.input(CreateSourceInputSchema).output(SourceSchema).errors(feedUrlConflict),
  update: oc
    .input(UpdateSourceInputSchema)
    .output(SourceSchema)
    .errors({ ...feedUrlConflict, ...notFound }),
  deactivate: oc.input(DeactivateSourceInputSchema).output(SourceSchema).errors(notFound),
}
