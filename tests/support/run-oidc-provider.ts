/**
 * Startet den Test-Provider als eigenen Prozess fuer die Browsertests.
 */

import { startTestProvider } from './oidc-provider.js'

const port = Number(process.env['CANVAZ_TEST_OIDC_PORT'] ?? '4471')

const provider = await startTestProvider({
  port,
  clientId: process.env['CANVAZ_OIDC_CLIENT_ID'] ?? 'canvaz-test',
  clientSecret: process.env['CANVAZ_OIDC_CLIENT_SECRET'] ?? 'canvaz-test-secret',
})

console.log(`Test-OIDC-Provider laeuft auf ${provider.issuer}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void provider.close().then(() => {
      process.exit(0)
    })
  })
}
