import type { JobDefinition } from '@newsdeck/jobs'
import type { Logger } from '@newsdeck/logger'

export interface JobContext {
  logger: Logger
  instanceId: string
}

/**
 * A background job: its contract plus the work it performs.
 *
 * The payload is validated against the definition's schema before `process`
 * runs, so a handler never has to defend against a malformed payload left in
 * the queue by an older deploy.
 */
export interface JobHandler<TPayload> {
  definition: JobDefinition<TPayload>
  process(payload: TPayload, context: JobContext): Promise<void>
}

// biome-ignore lint/suspicious/noExplicitAny: a registry necessarily erases the per-job payload type
export type AnyJobHandler = JobHandler<any>

/** Index handlers by job name so the processor can dispatch in constant time. */
export function createHandlerRegistry(
  handlers: readonly AnyJobHandler[],
): Map<string, AnyJobHandler> {
  const registry = new Map<string, AnyJobHandler>()

  for (const handler of handlers) {
    if (registry.has(handler.definition.name)) {
      throw new Error(`Duplicate job handler registered for "${handler.definition.name}"`)
    }
    registry.set(handler.definition.name, handler)
  }

  return registry
}
