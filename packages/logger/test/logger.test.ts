import { describe, expect, it } from 'bun:test'
import { createLogger, newRequestId, REQUEST_ID_HEADER, readRequestId } from '../src/index.ts'

/** Collect the JSON records a logger writes, using the public destination option. */
function recordSink(): { records: Array<Record<string, unknown>>; write(chunk: string): void } {
  const records: Array<Record<string, unknown>> = []
  return {
    records,
    write(chunk: string) {
      for (const line of chunk.split('\n')) {
        if (line.trim().length > 0) records.push(JSON.parse(line) as Record<string, unknown>)
      }
    },
  }
}

describe('createLogger', () => {
  it('stamps service and instance id on every record', () => {
    const sink = recordSink()
    const logger = createLogger({
      service: 'api',
      instanceId: 'api-1',
      level: 'info',
      destination: sink,
    })

    logger.info('started')

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({ service: 'api', instanceId: 'api-1', msg: 'started' })
  })

  it('honours the configured level', () => {
    const sink = recordSink()
    const logger = createLogger({
      service: 'api',
      instanceId: 'api-1',
      level: 'warn',
      destination: sink,
    })

    logger.debug('invisible')
    logger.warn('visible')

    expect(sink.records.map((record) => record.msg)).toEqual(['visible'])
  })

  it('redacts credential-bearing fields', () => {
    const sink = recordSink()
    const logger = createLogger({ service: 'api', instanceId: 'api-1', destination: sink })

    logger.info({ headers: { authorization: 'Bearer super-secret' } }, 'inbound')

    const serialised = JSON.stringify(sink.records[0])
    expect(serialised).not.toContain('super-secret')
    expect(serialised).toContain('[redacted]')
  })

  it('carries a request id through a child logger', () => {
    const sink = recordSink()
    const logger = createLogger({ service: 'api', instanceId: 'api-1', destination: sink })

    logger.child({ requestId: 'req-abcdef123456' }).info('handled')

    expect(sink.records[0]).toMatchObject({ requestId: 'req-abcdef123456', service: 'api' })
  })
})

describe('readRequestId', () => {
  it('reuses a well-formed inbound id', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'req-abcdef123456' })
    expect(readRequestId(headers)).toBe('req-abcdef123456')
  })

  it('replaces a malformed inbound id rather than echoing it', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'bad id with spaces' })
    const id = readRequestId(headers)

    expect(id).not.toBe('bad id with spaces')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('replaces an over-long inbound id', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'a'.repeat(500) })
    expect(readRequestId(headers).length).toBe(36)
  })

  it('generates an id when the header is absent', () => {
    expect(readRequestId(new Headers()).length).toBe(36)
  })
})

describe('newRequestId', () => {
  it('produces distinct ids', () => {
    expect(newRequestId()).not.toBe(newRequestId())
  })
})
