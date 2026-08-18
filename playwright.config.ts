import { defineConfig, devices } from '@playwright/test'

const PROVIDER_PORT = 4471
const APP_PORT = 4472

export const E2E_DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'
export const E2E_PROVIDER_URL = `http://127.0.0.1:${String(PROVIDER_PORT)}`
export const E2E_APP_URL = `http://127.0.0.1:${String(APP_PORT)}`

const OIDC_CLIENT_ID = 'canvaz-e2e'
const OIDC_CLIENT_SECRET = 'canvaz-e2e-secret'

/**
 * Die Browsertests laufen gegen den echten Anwendungsserver und einen standardkonformen Test-Provider mit
 * echtem JWKS. Es gibt keinen Testmodus im Produktionscode: der Server bekommt nur eine andere
 * Laufzeitkonfiguration, so wie jede andere Instanz auch.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: E2E_APP_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx tests/support/run-oidc-provider.ts',
      url: `${E2E_PROVIDER_URL}/.well-known/openid-configuration`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        CANVAZ_TEST_OIDC_PORT: String(PROVIDER_PORT),
        CANVAZ_OIDC_CLIENT_ID: OIDC_CLIENT_ID,
        CANVAZ_OIDC_CLIENT_SECRET: OIDC_CLIENT_SECRET,
      },
    },
    {
      // Der Anwendungsserver liefert die gebaute SPA aus; ohne Build liefe der Test gegen einen alten Stand.
      command: 'npm run build && npx tsx src/server/main.ts',
      url: `${E2E_APP_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        CANVAZ_PORT: String(APP_PORT),
        CANVAZ_BASE_URL: E2E_APP_URL,
        CANVAZ_WEB_ROOT: 'dist/web',
        DATABASE_URL: E2E_DATABASE_URL,
        CANVAZ_SESSION_SECRET: 'e2e-session-geheimnis-mit-mehr-als-32-zeichen',
        CANVAZ_OIDC_ISSUER: E2E_PROVIDER_URL,
        CANVAZ_OIDC_CLIENT_ID: OIDC_CLIENT_ID,
        CANVAZ_OIDC_CLIENT_SECRET: OIDC_CLIENT_SECRET,
        CANVAZ_OIDC_REDIRECT_URI: `${E2E_APP_URL}/api/auth/callback`,
      },
    },
  ],
})
