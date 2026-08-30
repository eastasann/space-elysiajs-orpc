import { describe, expect, it } from 'bun:test'
import { createLocalAuthProvider, issueLocalToken } from '@newsdeck/auth'
import { REQUEST_ID_HEADER } from '@newsdeck/logger'
import { buildServer } from '../src/server.ts'
import { fakeServices, fakeStatus, fakeSystemService, silentLogger } from './support/fakes.ts'

const authOptions = {
  signingKey: 'local-development-signing-key',
  issuer: 'newsdeck-local',
  audience: 'newsdeck',
}

function serverWith(
  system = fakeSystemService({}),
  overrides: { corsOrigins?: readonly string[] } = {},
) {
  return buildServer({
    logger: silentLogger(),
    instanceId: 'api-test',
    services: fakeServices(system),
    authProvider: createLocalAuthProvider(authOptions),
    corsOrigins: overrides.corsOrigins ?? [],
    startedAt: Date.now() - 12_000,
  })
}

function rpcRequest(procedure: string, init: RequestInit = {}) {
  return new Request(`http://api.test/rpc/${procedure}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: '{}',
    ...init,
  })
}

describe('GET /health', () => {
  it('answers without touching any dependency', async () => {
    // A service whose probes always throw: liveness must not consult them.
    const system = fakeSystemService({ failWith: new Error('database is down') })
    const response = await serverWith(system).handle(new Request('http://api.test/health'))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ok',
      service: 'api',
      instanceId: 'api-test',
    })
  })

  it('identifies the replica that answered', async () => {
    const response = await serverWith().handle(new Request('http://api.test/health'))

    const body = (await response.json()) as { instanceId: string }
    expect(body.instanceId).toBe('api-test')
  })
})

describe('GET /ready', () => {
  it('returns 200 when dependencies answer', async () => {
    const response = await serverWith(fakeSystemService({ ready: true })).handle(
      new Request('http://api.test/ready'),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ready' })
  })

  it('returns 503 when a dependency is unavailable', async () => {
    const response = await serverWith(fakeSystemService({ ready: false })).handle(
      new Request('http://api.test/ready'),
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'unready' })
  })
})

describe('request correlation', () => {
  it('echoes a well-formed inbound request id', async () => {
    const response = await serverWith().handle(
      new Request('http://api.test/health', {
        headers: { [REQUEST_ID_HEADER]: 'req-abcdef123456' },
      }),
    )

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('req-abcdef123456')
  })

  it('generates an id when none is supplied', async () => {
    const response = await serverWith().handle(new Request('http://api.test/health'))

    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('passes the request id through to the service layer', async () => {
    const system = fakeSystemService({})
    await serverWith(system).handle(
      rpcRequest('system/status', { headers: { [REQUEST_ID_HEADER]: 'req-traced-0001' } }),
    )

    expect(system.seenRequestIds).toEqual(['req-traced-0001'])
  })
})

describe('oRPC surface', () => {
  it('serves system.status', async () => {
    const status = fakeStatus({ instanceId: 'api-2' })
    const response = await serverWith(fakeSystemService({ status })).handle(
      rpcRequest('system/status'),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { json: Record<string, unknown> }
    expect(body.json).toMatchObject({ service: 'api', instanceId: 'api-2' })
  })

  it('returns 404 for an unknown procedure', async () => {
    const response = await serverWith().handle(rpcRequest('system/doesNotExist'))

    expect(response.status).toBe(404)
  })

  it('does not leak internal error detail when a procedure throws', async () => {
    const system = fakeSystemService({ failWith: new Error('connection to 10.0.0.5 refused') })
    const response = await serverWith(system).handle(rpcRequest('system/status'))

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(await response.text()).not.toContain('10.0.0.5')
  })
})

describe('authentication at the transport edge', () => {
  it('accepts an unauthenticated request', async () => {
    const response = await serverWith().handle(rpcRequest('system/status'))

    expect(response.status).toBe(200)
  })

  it('accepts a request carrying a valid bearer token', async () => {
    const token = await issueLocalToken(authOptions, { subject: 'local|reader' })
    const response = await serverWith().handle(
      rpcRequest('system/status', { headers: { authorization: `Bearer ${token}` } }),
    )

    expect(response.status).toBe(200)
  })

  it('does not reject a request carrying an invalid token, since no procedure requires one yet', async () => {
    const response = await serverWith().handle(
      rpcRequest('system/status', { headers: { authorization: 'Bearer nonsense' } }),
    )

    expect(response.status).toBe(200)
  })
})

describe('unknown routes', () => {
  it('returns a sanitised 404', async () => {
    const response = await serverWith().handle(new Request('http://api.test/nope'))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
  })
})
