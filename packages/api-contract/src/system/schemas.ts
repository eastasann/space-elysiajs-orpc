import { z } from 'zod'

/** Result of probing one infrastructure dependency of the API process. */
const DependencyCheckSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
  /** Failure detail. Absent when `ok` is true. Never contains credentials. */
  detail: z.string().optional(),
})
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>

/** Job counts for the background queue, used by the admin collector view. */
const QueueDepthSchema = z.object({
  name: z.string(),
  waiting: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  delayed: z.number().int().nonnegative(),
})
export type QueueDepth = z.infer<typeof QueueDepthSchema>

/** Most recent heartbeat published by a worker process, if any. */
const WorkerHeartbeatSchema = z.object({
  instanceId: z.string(),
  observedAt: z.iso.datetime(),
  ageSeconds: z.number().nonnegative(),
})
export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>

/**
 * Platform status.
 *
 * `instanceId` identifies the API replica that served the call. It is the
 * mechanism used to demonstrate that the reverse proxy really is distributing
 * requests across API instances.
 */
export const SystemStatusSchema = z.object({
  service: z.literal('api'),
  instanceId: z.string(),
  /** Correlation id for this call, echoed so clients can quote it in bug reports. */
  requestId: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.object({
    database: DependencyCheckSchema,
    redis: DependencyCheckSchema,
  }),
  queue: QueueDepthSchema,
  worker: WorkerHeartbeatSchema.nullable(),
})
export type SystemStatus = z.infer<typeof SystemStatusSchema>
