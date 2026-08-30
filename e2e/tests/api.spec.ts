import { expect, test } from '@playwright/test'
import { urls } from '../playwright.config.ts'

test.describe('API through the reverse proxy', () => {
  test('answers the liveness probe', async ({ request }) => {
    const response = await request.get(`${urls.web}/api/health`)

    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'api' })
  })

  test('answers the readiness probe once dependencies are reachable', async ({ request }) => {
    const response = await request.get(`${urls.web}/api/ready`)

    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ready' })
  })

  test('serves system.status over oRPC', async ({ request }) => {
    const response = await request.post(`${urls.web}/api/rpc/system/status`, {
      headers: { 'content-type': 'application/json' },
      data: {},
    })

    expect(response.status()).toBe(200)
    const body = (await response.json()) as { json: Record<string, unknown> }
    expect(body.json).toMatchObject({ service: 'api' })
    expect(body.json.instanceId).toMatch(/^api-\d+$/)
  })

  test('echoes the correlation id it was given', async ({ request }) => {
    const response = await request.post(`${urls.web}/api/rpc/system/status`, {
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-e2e-api-echo-01' },
      data: {},
    })

    const body = (await response.json()) as { json: { requestId: string } }
    expect(body.json.requestId).toBe('req-e2e-api-echo-01')
    expect(response.headers()['x-request-id']).toBe('req-e2e-api-echo-01')
  })

  test('distributes requests across API instances', async ({ request }) => {
    const seen = new Set<string>()

    // Sequential on purpose: concurrent requests can share a connection and
    // would understate the spread.
    for (let index = 0; index < 12; index += 1) {
      const response = await request.get(`${urls.web}/api/health`, {
        headers: { 'cache-control': 'no-cache' },
      })
      const body = (await response.json()) as { instanceId: string }
      seen.add(body.instanceId)
    }

    expect(seen.size).toBeGreaterThan(1)
  })

  test('rejects an unknown procedure with 404', async ({ request }) => {
    const response = await request.post(`${urls.web}/api/rpc/system/nope`, {
      headers: { 'content-type': 'application/json' },
      data: {},
    })

    expect(response.status()).toBe(404)
  })
})
