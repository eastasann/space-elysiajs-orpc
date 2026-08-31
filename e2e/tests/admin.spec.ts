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

test.describe('source management', () => {
  test('creates a source, shows it in the list, then deactivates it', async ({ page }) => {
    const unique = Date.now()
    const name = `E2E Source ${unique}`
    const feedUrl = `https://example.test/e2e-${unique}/feed.xml`

    await page.goto('/sources')

    await page.getByLabel('Name').fill(name)
    await page.getByLabel('Feed URL').fill(feedUrl)
    await page.getByRole('button', { name: 'Add source' }).click()

    const row = page.getByRole('row', { name: new RegExp(name) })
    await expect(row).toBeVisible()
    await expect(row.locator('.nd-badge')).toHaveText('active')

    // The form clears without a navigation: proves the create happened over
    // the mutation, not a full page reload.
    await expect(page.getByLabel('Name')).toHaveValue('')

    await row.getByRole('button', { name: 'Deactivate' }).click()

    await expect(row.locator('.nd-badge')).toHaveText('inactive')
    await expect(row.getByRole('button', { name: 'Deactivate' })).toHaveCount(0)
  })

  test('shows a clear message for a duplicate feed url instead of a generic failure', async ({
    page,
  }) => {
    const unique = Date.now()
    const name = `E2E Duplicate ${unique}`
    const feedUrl = `https://example.test/e2e-dup-${unique}/feed.xml`

    await page.goto('/sources')

    await page.getByLabel('Name').fill(name)
    await page.getByLabel('Feed URL').fill(feedUrl)
    await page.getByRole('button', { name: 'Add source' }).click()
    await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible()

    await page.getByLabel('Name').fill(`${name} again`)
    await page.getByLabel('Feed URL').fill(feedUrl)
    await page.getByRole('button', { name: 'Add source' }).click()

    await expect(page.getByText('A source with this feed URL already exists.')).toBeVisible()
    await expect(page.getByRole('row', { name: new RegExp(`${name} again`) })).toHaveCount(0)
  })
})
