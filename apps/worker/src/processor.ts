import type { QueuedJob } from '@newsdeck/jobs'
import type { Logger } from '@newsdeck/logger'
import type { AnyJobHandler } from './handlers/registry.ts'

export class UnknownJobError extends Error {
  constructor(name: string) {
    super(`No handler registered for job "${name}"`)
    this.name = 'UnknownJobError'
  }
}

export class InvalidJobPayloadError extends Error {
  constructor(name: string, issues: string) {
    super(`Invalid payload for job "${name}": ${issues}`)
    this.name = 'InvalidJobPayloadError'
  }
}

export interface ProcessorOptions {
  registry: Map<string, AnyJobHandler>
  logger: Logger
  instanceId: string
}

/**
 * Build the BullMQ processor.
 *
 * Extracted from the `Worker` construction so the dispatch, validation and
 * logging rules can be tested without a Redis connection.
 */
export function createProcessor(options: ProcessorOptions) {
  return async function process(job: QueuedJob): Promise<void> {
    const handler = options.registry.get(job.name)
    if (handler === undefined) {
      // Throwing routes the job to the failed set, where it stays visible for
      // inspection rather than being silently dropped.
      throw new UnknownJobError(job.name)
    }

    const parsed = handler.definition.payloadSchema.safeParse(job.data)
    if (!parsed.success) {
      throw new InvalidJobPayloadError(
        job.name,
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      )
    }

    // A job carries the correlation id of whatever enqueued it, so a single
    // request can be followed from the browser through to background work.
    const payload = parsed.data as { requestId?: string }
    const logger = options.logger.child({
      jobId: job.id,
      jobName: job.name,
      ...(payload.requestId === undefined ? {} : { requestId: payload.requestId }),
    })

    const startedAt = performance.now()
    await handler.process(parsed.data, { logger, instanceId: options.instanceId })
    logger.info({ durationMs: Math.round(performance.now() - startedAt) }, 'job completed')
  }
}
