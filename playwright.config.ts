import { rmSync } from 'node:fs'

import { defineConfig, devices } from '@playwright/test'

const CLIENT_PORT = 4173
const SERVER_PORT = 3101
const DATA_DIR = '.playwright-boards'

// Jeder Lauf startet mit leeren Boards; sonst zaehlt der naechste Lauf die Elemente des vorherigen mit.
rmSync(DATA_DIR, { recursive: true, force: true })

export default defineConfig({
  testDir: './spike/e2e',
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
      command: 'npm run start:server',
      url: `http://127.0.0.1:${String(SERVER_PORT)}/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(SERVER_PORT),
        CANVAZ_SPIKE_DATA_DIR: DATA_DIR,
      },
    },
    {
      // Preview serviert nur `dist`; ohne vorherigen Build laeuft der Test gegen einen alten Stand.
      command: `npm run build && npm run preview -- --port ${String(CLIENT_PORT)} --strictPort`,
      url: `http://127.0.0.1:${String(CLIENT_PORT)}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
