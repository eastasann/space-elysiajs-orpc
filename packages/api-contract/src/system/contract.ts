import { oc } from '@orpc/contract'
import { SystemStatusSchema } from './schemas.ts'

export const systemContract = {
  /**
   * Report which API replica answered, plus the health of the dependencies
   * that replica owns. Unauthenticated by design: it is the smoke test used by
   * humans, by the admin app, and by `bun run verify:lb`.
   */
  status: oc.output(SystemStatusSchema),
}
