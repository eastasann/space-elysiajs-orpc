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
