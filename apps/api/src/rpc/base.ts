import { contract } from '@newsdeck/api-contract'
import { implement } from '@orpc/server'
import type { RequestContext } from '../context.ts'

/**
 * The contract-first implementer.
 *
 * `implement(contract)` means the server cannot drift from the published
 * contract: an unimplemented or mis-shaped procedure is a compile error, and
 * clients derive their types from the same contract package.
 */
export const base = implement(contract).$context<RequestContext>()
