/**
 * `npm run sender-block -- <list|unblock|decide> ...`
 * Im Container: `node dist/server/sender-block-cli.js <list|unblock|decide> ...`
 *
 * Betreiberwerkzeug der Absenderabwehr (#35, Meilenstein 2). Ausfuehren darf ihn nur, wer Shellzugang zum
 * Host hat - es gibt dafuer keinen HTTP-Endpunkt.
 *
 * - `list` zeigt aktive vorlaeufige Sperren und offene Vorschlaege fuer eine dauerhafte Sperre. Ein
 *   IPv6-Praefix erscheint als CIDR in kanonischer Form (`2001:db8:0:1::/64`), eine IPv4-Adresse
 *   unveraendert - beides direkt uebernehmbar in eine Firewallregel der eigenen Umgebung.
 * - `unblock <adresse>` hebt eine aktive vorlaeufige Sperre vorzeitig auf. Die Adresse wird wie beim
 *   Zaehlen selbst gebildet (IPv4-gemappt -> IPv4, IPv6 -> /64-Praefix): eine beliebige Adresse aus dem
 *   gesperrten /64-Netz findet dieselbe Sperre.
 * - `decide <id> accepted|rejected` markiert einen Vorschlag als entschieden. Diese Anwendung sperrt dadurch
 *   **nichts** dauerhaft und fasst nie eine Firewall an - eine angenommene Entscheidung ist eine Erinnerung
 *   an den Betreiber, die dauerhafte Sperre selbst mit den Mitteln seiner Umgebung einzurichten (README,
 *   Abschnitt "Absenderabwehr"). Der Befehl gibt dafuer eine Zeile mit Datum, Adresse und Grund aus, die sich
 *   unveraendert in einen eigenen Vermerk uebernehmen laesst. Ein entschiedener Vorschlag verschwindet
 *   spaetestens beim naechsten stuendlichen Aufraeumlauf.
 *
 * **Nichts von alldem wird geloggt** - die Ausgabe hier ist bewusst die einzige Stelle, an der eine Adresse
 * aus diesem Modul erscheint, exakt wie bei einer ausgeloesten Sperre selbst.
 *
 * Die Konfiguration wird vollstaendig geladen, damit es keinen zweiten, laxeren Konfigurationspfad gibt.
 */

import type { SenderBlockProposalRecord, SenderBlockRecord } from '../domain/identity/repositories.js'
import { createIdentityStore } from '../persistence/identity-store.js'
import { createPool } from '../persistence/pool.js'
import { loadConfig } from './config.js'
import { resolveSenderAddress, senderAddressAsCidr } from './sender-defense.js'

const USAGE =
  'Aufruf: npm run sender-block -- list | unblock <adresse> | decide <id> accepted|rejected\n' +
  'Im Container: node dist/server/sender-block-cli.js list | unblock <adresse> | decide <id> accepted|rejected'

function formatBlock(record: SenderBlockRecord): string {
  return (
    `  ${senderAddressAsCidr(record)}  Grund: ${record.reason}  Zaehler: ${String(record.failureCount)}  ` +
    `seit ${record.createdAt.toISOString()}  bis ${record.expiresAt.toISOString()}`
  )
}

function formatProposal(record: SenderBlockProposalRecord): string {
  return (
    `  ${record.id}  ${senderAddressAsCidr(record)}  Grund: ${record.reason}  ` +
    `erste Sperre ${record.firstBlockedAt.toISOString()}  zweite Sperre ${record.secondBlockedAt.toISOString()}`
  )
}

/** Die Zeile fuer den eigenen Vermerk des Betreibers: Datum, Adresse, Grund - sonst nichts. */
function operatorNoteLine(record: SenderBlockProposalRecord, decidedAt: Date): string {
  return `${decidedAt.toISOString().slice(0, 10)}  ${senderAddressAsCidr(record)}  Grund: ${record.reason}`
}

const config = loadConfig()
const pool = createPool(config.databaseUrl)
const identity = createIdentityStore(pool)

try {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'list') {
    const now = new Date()
    const [blocks, proposals] = await Promise.all([
      identity.senderDefense.blocks.listActive(now),
      identity.senderDefense.proposals.listPending(),
    ])
    console.log(`Aktive Sperren (${String(blocks.length)}):`)
    if (blocks.length === 0) {
      console.log('  keine')
    } else {
      blocks.forEach((block) => {
        console.log(formatBlock(block))
      })
    }
    console.log(`Offene Vorschlaege fuer eine dauerhafte Sperre (${String(proposals.length)}):`)
    if (proposals.length === 0) {
      console.log('  keine')
    } else {
      proposals.forEach((proposal) => {
        console.log(formatProposal(proposal))
      })
    }
  } else if (command === 'unblock') {
    const [rawAddress] = rest
    if (rawAddress === undefined) {
      console.error(USAGE)
      process.exit(2)
    }
    const resolved = resolveSenderAddress(rawAddress)
    if (resolved === null) {
      console.error(`"${rawAddress}" ist keine gueltige IPv4- oder IPv6-Adresse.`)
      process.exit(2)
    }
    const lifted = await identity.senderDefense.blocks.liftActive(resolved.address, new Date())
    if (!lifted) {
      console.error(`Keine aktive Sperre fuer ${senderAddressAsCidr(resolved)}.`)
      process.exitCode = 1
    } else {
      console.log(`Sperre aufgehoben: ${senderAddressAsCidr(resolved)}`)
    }
  } else if (command === 'decide') {
    const [id, status] = rest
    if (id === undefined || (status !== 'accepted' && status !== 'rejected')) {
      console.error(USAGE)
      process.exit(2)
    }
    const now = new Date()
    const record = await identity.senderDefense.proposals.decide(id, status, now)
    if (record === null) {
      console.error(`Kein offener Vorschlag mit der Kennung ${id}.`)
      process.exitCode = 1
    } else {
      console.log(`Vorschlag ${status === 'accepted' ? 'uebernommen' : 'verworfen'}: ${senderAddressAsCidr(record)}`)
      console.log('Entfernt spaetestens beim naechsten stuendlichen Aufraeumlauf.')
      if (status === 'accepted') {
        console.log(
          'Diese Anwendung sperrt dadurch nichts dauerhaft. Fuer den eigenen Vermerk (Datum, Adresse, Grund):',
        )
        console.log(operatorNoteLine(record, now))
      }
    }
  } else {
    console.error(USAGE)
    process.exit(2)
  }
} finally {
  await pool.end()
}
