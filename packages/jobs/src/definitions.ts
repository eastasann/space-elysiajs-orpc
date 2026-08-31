import type { JobsOptions } from 'bullmq'
import { z } from 'zod'

/**
 * The single background queue that exists today.
 *
 * News ingestion (fetch -> parse -> normalise -> deduplicate -> persist) will
 * add its own queues through the Milestone 1 issues. Keeping the name in one
 * place means a producer and a consumer can never drift apart.
 */
export const SYSTEM_QUEUE_NAME = 'system'

/**
 * Describes one kind of background job.
 *
 * The payload schema is the contract between the producer (usually the API)
 * and the consumer (the worker). Payloads are validated on the consuming side
 * because a queue outlives any single deploy: a worker can receive a job that
 * an older or newer producer enqueued.
 */
export interface JobDefinition<TPayload> {
  readonly name: string
  readonly payloadSchema: z.ZodType<TPayload>
}

const HeartbeatPayloadSchema = z.object({
  /** Correlation id of whatever caused the job, when there is one. */
  requestId: z.string().optional(),
})
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>

/**
 * Proves the queue round trip end to end: the worker consumes it on a repeating
 * schedule and publishes a heartbeat the API reports through `system.status`.
 */
export const heartbeatJob: JobDefinition<HeartbeatPayload> = {
  name: 'system.heartbeat',
  payloadSchema: HeartbeatPayloadSchema,
}

const SourcesFetchPayloadSchema = z.object({
  /** The source to fetch. */
  sourceId: z.string().min(1),
  /** Correlation id of whatever caused the job, when there is one. */
  requestId: z.string().optional(),
})
export type SourcesFetchPayload = z.infer<typeof SourcesFetchPayloadSchema>

/**
 * Fetches one source's feed document.
 *
 * The first stage of the ingestion pipeline described in
 * `docs/architecture.md#background-worker`. A transient failure (timeout,
 * 5xx, connection reset) should exhaust these attempts before the job moves to
 * the failed set; a permanent one (404, 410, an invalid or refused URL) is
 * raised as `UnrecoverableError` by the handler and skips the remaining
 * attempts regardless of this setting.
 */
export const SOURCES_FETCH_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
}

export const sourcesFetchJob: JobDefinition<SourcesFetchPayload> = {
  name: 'sources.fetch',
  payloadSchema: SourcesFetchPayloadSchema,
}
