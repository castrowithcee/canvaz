/**
 * `npm run admin:bootstrap -- --name "Ada Lovelace" --email ada@example.com`
 *
 * Legt genau einen Systemadmin an und gibt seinen Einladungslink aus. Der Vorgang laeuft auf dem Host und
 * nicht im Produkt: bis er einmal gelaufen ist, hat die Instanz niemanden, der ein Konto anlegen duerfte.
 *
 * Der Link erscheint **auf der Standardausgabe und nirgends sonst**. Er wird nur als Hash gespeichert, ist
 * befristet, genau einmal einloesbar und laesst sich danach nicht wieder abrufen - ein verlorener Link wird
 * in der Systemadministration widerrufen und neu erzeugt.
 *
 * Die Konfiguration wird vollstaendig geladen, damit es keinen zweiten, laxeren Konfigurationspfad gibt.
 */

import { normalizeDisplayName, normalizeEmail } from '../domain/identity/local-auth.js'
import { createIdentityStore } from '../persistence/identity-store.js'
import { createPool } from '../persistence/pool.js'
import { bootstrapSystemAdmin } from './bootstrap-admin.js'
import { loadConfig } from './config.js'
import { invitationUrl } from './invitations.js'

function readOption(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : argv[index + 1]
  return value === undefined ? null : value
}

const argv = process.argv.slice(2)
const displayName = normalizeDisplayName(readOption(argv, 'name'))
const email = normalizeEmail(readOption(argv, 'email'))
if (displayName === null || email === null) {
  console.error('Aufruf: npm run admin:bootstrap -- --name "Vorname Nachname" --email adresse@example.com')
  process.exit(2)
}

const config = loadConfig()
const pool = createPool(config.databaseUrl)
try {
  const result = await bootstrapSystemAdmin(createIdentityStore(pool), {
    displayName,
    email,
    now: new Date(),
  })
  if (result.kind === 'already-administered') {
    console.error('Diese Instanz hat bereits einen Systemadmin. Weitere Konten entstehen in der Systemadministration.')
    process.exit(1)
  }
  if (result.kind === 'email-taken') {
    console.error('Diese Adresse gehoert bereits zu einem Konto. Bitte eine andere waehlen.')
    process.exit(1)
  }
  console.log(`Systemadmin angelegt: ${result.user.displayName} <${result.user.email ?? ''}>`)
  console.log('Einladungslink (gilt genau einmal, ausserhalb der Anwendung uebergeben):')
  console.log(invitationUrl(config.baseUrl, result.token))
  console.log(`Gueltig bis: ${result.expiresAt.toISOString()}`)
} finally {
  await pool.end()
}
