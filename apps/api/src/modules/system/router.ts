import { base } from '../../rpc/base.ts'

/**
 * Transport layer for the system module.
 *
 * Handlers stay one line each on purpose: they translate an oRPC call into a
 * service call and nothing more.
 */
export const systemRouter = {
  status: base.system.status.handler(({ context }) =>
    context.services.system.getStatus(context.requestId),
  ),
}
