import { expect, test } from '@playwright/test'
import { urls } from '../playwright.config.ts'

test.use({ baseURL: urls.admin })

test.describe('admin application', () => {
  test('renders the dashboard on its own proxy port', async ({ page }) => {
    const response = await page.goto('/')

    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Newsdeck Admin', level: 1 })).toBeVisible()
  })

  test('reports queue depth and the worker heartbeat', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'Background worker' })).toBeVisible()
    const worker = page.locator('.nd-kv__row', { hasText: 'Worker' }).locator('.nd-badge')
    await expect(worker).toHaveAttribute('data-tone', 'ok')
  })

  test('samples the API and reports the instances that answered', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: /Sample \d+ requests/ }).click()

    const table = page.locator('.nd-table')
    await expect(table).toBeVisible({ timeout: 20_000 })

    // Every sampled call must have been answered by a named API replica.
    const rows = table.locator('tbody tr')
    await expect(rows.first().locator('td').first()).toHaveText(/^api-\d+$/)

    await expect(page.locator('.nd-kv__row', { hasText: 'Failed calls' }).locator('dd')).toHaveText(
      '0',
    )
  })
})
