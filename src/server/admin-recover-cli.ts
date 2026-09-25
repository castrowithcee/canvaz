/**
 * `npm run admin:recover` - im Container: `node dist/server/admin-recover-cli.js`
 *
 * Stellt den Zugang des einzigen Systemadmins wieder her (siehe `admin-recovery.ts`) und gibt einen
 * einmaligen, kurz gueltigen Link aus. Der Befehl nimmt **keine Argumente**: das Konto ermittelt er selbst,
 * und ein Geheimnis gehoert nicht in eine Kommandozeile, die in Shellverlauf und Prozessliste landet.
 *
 * Der Link erscheint **auf der Standardausgabe und nirgends sonst**. Er wird nur als Hash gespeichert und
 * laesst sich danach nicht wieder abrufen; ein verlorener Link wird durch einen erneuten Aufruf ersetzt.
 *
 * Die Konfiguration wird vollstaendig geladen, damit es keinen zweiten, laxeren Konfigurationspfad gibt.
 */

import { createIdentityStore } from '../persistence/identity-store.js'
import { createPool } from '../persistence/pool.js'
import { recoverSystemAdmin } from './admin-recovery.js'
import { loadConfig } from './config.js'
import { recoveryUrl } from './invitations.js'
import { consoleLogger } from './log.js'

if (process.argv.length > 2) {
  console.error('Aufruf ohne Argumente: npm run admin:recover (im Container: node dist/server/admin-recover-cli.js)')
  process.exit(2)
}

const config = loadConfig()
const pool = createPool(config.databaseUrl)
try {
  const result = await recoverSystemAdmin(createIdentityStore(pool), {
    now: new Date(),
    sessionSecret: config.sessionSecret,
  })
  if (result.kind === 'no-admin') {
    console.error('Diese Instanz hat keinen Systemadmin. Der erste entsteht mit admin:bootstrap.')
    process.exitCode = 1
  } else if (result.kind === 'ambiguous') {
    console.error(`Diese Instanz hat ${String(result.count)} Systemadmins; welches Konto gemeint ist, bleibt offen. Nichts geaendert.`)
    process.exitCode = 1
  } else if (result.kind === 'deactivated') {
    console.error('Der Systemadmin ist deaktiviert; ein Link darauf liesse sich nicht einloesen. Nichts geaendert.')
    process.exitCode = 1
  } else {
    // Nachweis ohne Geheimnis: Konto und Frist, nie der Wert.
    consoleLogger('info', 'admin.recovery.issued', {
      userId: result.user.id,
      expiresAt: result.expiresAt.toISOString(),
    })
    console.log(`Zugang wiederhergestellt fuer: ${result.user.displayName} <${result.user.email ?? ''}>`)
    console.log('Alle Sitzungen und offenen Einladungen dieses Kontos sind widerrufen, eine Anmeldedrosselung ist aufgehoben.')
    console.log('Wiederherstellungslink (gilt genau einmal, ausserhalb der Anwendung uebergeben):')
    console.log(recoveryUrl(config.baseUrl, result.token))
    console.log(`Gueltig bis: ${result.expiresAt.toISOString()}`)
  }
} finally {
  await pool.end()
}
