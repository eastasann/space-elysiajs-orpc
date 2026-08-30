import { expect, test } from '@playwright/test'
import { urls } from '../playwright.config.ts'

test.describe('user web application', () => {
  test('renders platform status fetched from the API during SSR', async ({ page }) => {
    const response = await page.goto('/')

    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Newsdeck', level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Platform status' })).toBeVisible()
  })

  test('reports both infrastructure dependencies as healthy', async ({ page }) => {
    await page.goto('/')

    const database = page.locator('.nd-kv__row', { hasText: 'PostgreSQL' }).locator('.nd-badge')
    const redis = page.locator('.nd-kv__row', { hasText: 'Redis' }).locator('.nd-badge')

    await expect(database).toHaveAttribute('data-tone', 'ok')
    await expect(redis).toHaveAttribute('data-tone', 'ok')
  })

  test('names the API instance that served the page', async ({ page }) => {
    await page.goto('/')

    const instance = page.locator('.nd-kv__row', { hasText: 'API instance' }).locator('dd')

    await expect(instance).toHaveText(/^api-\d+$/)
  })

  test('shows a live worker heartbeat', async ({ page }) => {
    await page.goto('/')

    const worker = page.locator('.nd-kv__row', { hasText: 'Worker' }).locator('.nd-badge')

    await expect(worker).toHaveAttribute('data-tone', 'ok')
    await expect(worker).toContainText(/worker-\S+ · \d+s ago/)
  })

  test('the server-rendered document already contains the data', async ({ request }) => {
    // Fetched without JavaScript: proves the loader ran during SSR rather than
    // the page hydrating and fetching afterwards.
    const response = await request.get(urls.web)
    const html = await response.text()

    expect(response.status()).toBe(200)
    expect(html).toContain('Platform status')
    expect(html).toMatch(/api-\d+/)
  })

  test('propagates a caller-supplied correlation id through to the API', async ({ request }) => {
    const response = await request.get(urls.web, {
      headers: { 'x-request-id': 'req-e2e-correlation-01' },
    })
    const html = await response.text()

    expect(html).toContain('req-e2e-correlation-01')
  })

  test('renders a not-found page for an unknown route', async ({ page }) => {
    await page.goto('/no-such-page')

    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  })
})
