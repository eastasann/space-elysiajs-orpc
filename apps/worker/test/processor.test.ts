import { describe, expect, it } from 'bun:test'
import { heartbeatJob, type JobDefinition } from '@newsdeck/jobs'
import { createLogger } from '@newsdeck/logger'
import type { Job } from 'bullmq'
import { z } from 'zod'
import { type AnyJobHandler, createHandlerRegistry } from '../src/handlers/registry.ts'
import { createProcessor, InvalidJobPayloadError, UnknownJobError } from '../src/processor.ts'

function collectingLogger() {
  const records: Array<Record<string, unknown>> = []
  const logger = createLogger({
    service: 'worker-test',
    instanceId: 'worker-test',
    level: 'debug',
    destination: {
      write(chunk: string) {
        for (const line of chunk.split('\n')) {
          if (line.trim().length > 0) records.push(JSON.parse(line) as Record<string, unknown>)
        }
      },
    },
  })
  return { logger, records }
}

function fakeJob(name: string, data: unknown): Job {
  return { id: 'job-1', name, data } as Job
}

function recordingHandler(definition: JobDefinition<{ requestId?: string }>) {
  const calls: Array<{ payload: unknown; instanceId: string }> = []
  const handler: AnyJobHandler = {
    definition,
    async process(payload, context) {
      calls.push({ payload, instanceId: context.instanceId })
    },
  }
  return { handler, calls }
}

describe('createHandlerRegistry', () => {
  it('indexes handlers by job name', () => {
    const { handler } = recordingHandler(heartbeatJob)
    const registry = createHandlerRegistry([handler])

    expect(registry.get(heartbeatJob.name)).toBe(handler)
  })

  it('rejects two handlers claiming the same job name', () => {
    const a = recordingHandler(heartbeatJob).handler
    const b = recordingHandler(heartbeatJob).handler

    expect(() => createHandlerRegistry([a, b])).toThrow(/Duplicate job handler/)
  })
})

describe('createProcessor', () => {
  it('dispatches a valid job to its handler', async () => {
    const { handler, calls } = recordingHandler(heartbeatJob)
    const { logger } = collectingLogger()
    const process = createProcessor({
      registry: createHandlerRegistry([handler]),
      logger,
      instanceId: 'worker-7',
    })

    await process(fakeJob(heartbeatJob.name, { requestId: 'req-abc123456' }))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload).toEqual({ requestId: 'req-abc123456' })
    expect(calls[0]?.instanceId).toBe('worker-7')
  })

  it('fails a job with no registered handler rather than dropping it', async () => {
    const { logger } = collectingLogger()
    const process = createProcessor({ registry: new Map(), logger, instanceId: 'worker-7' })

    expect(process(fakeJob('news.fetch', {}))).rejects.toBeInstanceOf(UnknownJobError)
  })

  it('fails a job whose payload does not match its definition', async () => {
    const { handler } = recordingHandler(heartbeatJob)
    const { logger } = collectingLogger()
    const process = createProcessor({
      registry: createHandlerRegistry([handler]),
      logger,
      instanceId: 'worker-7',
    })

    expect(process(fakeJob(heartbeatJob.name, { requestId: 42 }))).rejects.toBeInstanceOf(
      InvalidJobPayloadError,
    )
  })

  it('does not invoke the handler when validation fails', async () => {
    const { handler, calls } = recordingHandler(heartbeatJob)
    const { logger } = collectingLogger()
    const process = createProcessor({
      registry: createHandlerRegistry([handler]),
      logger,
      instanceId: 'worker-7',
    })

    await process(fakeJob(heartbeatJob.name, { requestId: 42 })).catch(() => {})

    expect(calls).toHaveLength(0)
  })

  it('carries the enqueuing request id into the job log context', async () => {
    const { handler } = recordingHandler(heartbeatJob)
    const { logger, records } = collectingLogger()
    const process = createProcessor({
      registry: createHandlerRegistry([handler]),
      logger,
      instanceId: 'worker-7',
    })

    await process(fakeJob(heartbeatJob.name, { requestId: 'req-traced-9999' }))

    const completed = records.find((record) => record.msg === 'job completed')
    expect(completed).toMatchObject({
      requestId: 'req-traced-9999',
      jobName: heartbeatJob.name,
      jobId: 'job-1',
    })
  })

  it('validates against the definition, not the handler', async () => {
    const strict: JobDefinition<{ requestId?: string }> = {
      name: 'test.strict',
      payloadSchema: z.object({ requestId: z.string().min(5) }),
    }
    const { handler } = recordingHandler(strict)
    const { logger } = collectingLogger()
    const process = createProcessor({
      registry: createHandlerRegistry([handler]),
      logger,
      instanceId: 'worker-7',
    })

    expect(process(fakeJob('test.strict', { requestId: 'ab' }))).rejects.toBeInstanceOf(
      InvalidJobPayloadError,
    )
  })
})
