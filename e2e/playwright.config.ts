import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests run against the running Docker stack, entering through the
 * reverse proxy exactly as a browser does:
 *
 *   browser -> proxy:8080 -> web  (SSR) -> proxy:8080 -> API -> PostgreSQL
 *   browser -> proxy:8081 -> admin
 *
 * Start the stack first:
 *
 *   docker compose up -d --build
 *   bun run test:e2e
 *
 * Nothing is started for you: these tests assert on real container behaviour,
 * including which API replica answered, so an in-process server would defeat
 * their purpose.
 */
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:8080'
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:8081'

export const urls = { web: WEB_URL, admin: ADMIN_URL }

/**
 * CI images frequently pre-provision browsers rather than downloading them per
 * run. Point this at the binary when yours does; otherwise Playwright uses the
 * browsers it manages itself (`bunx playwright install chromium`).
 */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    // The stack is served over plain HTTP on loopback in development.
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumExecutable === undefined
          ? {}
          : { launchOptions: { executablePath: chromiumExecutable } }),
      },
    },
  ],
})
