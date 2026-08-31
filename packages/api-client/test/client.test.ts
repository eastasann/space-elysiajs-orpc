import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { REQUEST_ID_HEADER as LOGGER_HEADER } from '@newsdeck/logger'
import {
  createApiClient,
  isDefinedError,
  newRequestId,
  ORPCError,
  REQUEST_ID_HEADER,
} from '../src/index.ts'

describe('createApiClient', () => {
  it('exposes both a direct client and TanStack Query bindings', () => {
    const { client, orpc } = createApiClient({ baseUrl: 'http://api.test/rpc' })

    expect(typeof client.system.status).toBe('function')
    expect(typeof orpc.system.status.queryOptions).toBe('function')
  })

  it('produces a query key scoped to the procedure', () => {
    const { orpc } = createApiClient({ baseUrl: 'http://api.test/rpc' })

    expect(JSON.stringify(orpc.system.status.queryOptions().queryKey)).toContain('system')
  })
})

describe('isDefinedError', () => {
  it('does not narrow a plain error', () => {
    expect(isDefinedError(new Error('boom'))).toBe(false)
  })

  it('narrows a defined ORPCError, e.g. the CONFLICT shape sourcesContract declares', () => {
    const error = new ORPCError('CONFLICT', {
      message: 'a source with this feed url already exists',
      data: { feedUrl: 'https://example.test/feed.xml' },
      defined: true,
    })

    expect(isDefinedError(error)).toBe(true)
  })

  it('does not narrow an ORPCError that was not declared by the contract', () => {
    const error = new ORPCError('INTERNAL_SERVER_ERROR', { defined: false })

    expect(isDefinedError(error)).toBe(false)
  })
})

describe('correlation id', () => {
  it('matches the header name the server reads', () => {
    expect(REQUEST_ID_HEADER).toBe(LOGGER_HEADER)
  })

  it('generates distinct ids', () => {
    expect(newRequestId()).not.toBe(newRequestId())
  })
})

describe('client-safety boundary', () => {
  it('declares only client-safe dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf8'),
    ) as { dependencies?: Record<string, string> }

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@newsdeck/api-contract',
      '@orpc/client',
      '@orpc/tanstack-query',
    ])
  })
})

describe('base URL validation', () => {
  it.each([['/api/rpc'], ['api/rpc'], ['']])(
    'rejects the relative base URL %p at construction',
    (baseUrl) => {
      expect(() => createApiClient({ baseUrl })).toThrow(/must be absolute/)
    },
  )

  it.each([['http://localhost:8080/api/rpc'], ['https://api.example.test/rpc']])(
    'accepts the absolute base URL %p',
    (baseUrl) => {
      expect(() => createApiClient({ baseUrl })).not.toThrow()
    },
  )
})
