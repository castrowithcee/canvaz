import { defineConfig, devices } from '@playwright/test'

const CLIENT_PORT = 4173

// Der Rauchtest prueft nur die ausgelieferte SPA-Huelle. Anmeldung und Board bekommen eigene Spezifikationen,
// sobald ihre Strecken existieren; dann kommt auch der Anwendungsserver als zweiter webServer dazu.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${String(CLIENT_PORT)}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Preview serviert nur den Build; ohne vorherigen Build laeuft der Test gegen einen alten Stand.
      command: `npm run build && npm run preview -- --port ${String(CLIENT_PORT)} --strictPort`,
      url: `http://127.0.0.1:${String(CLIENT_PORT)}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
