/**
 * Messung gegen die Zielwerte des Produktvertrags: fuenf gleichzeitige Bearbeiter auf einem Board und zehn
 * gleichzeitige Verbindungen als Reserve.
 *
 * Gemessen wird an der echten Anwendung mit echten WebSocket-Verbindungen und echter Datenbank, und zwar
 * mit den **Standardwerten** der Takte - eine Messung gegen verkuerzte Testtakte belegte nichts ueber den
 * Betrieb. Deshalb dauert der zweite Fall bewusst rund fuenfzehn Sekunden: die Obergrenze des
 * Checkpoint-Takts liegt bei zehn Sekunden und laesst sich nicht schneller nachweisen.
 *
 * Die Schwellen sind Obergrenzen mit Reserve, keine Bestwerte. Ein Test, der die gemessene Zeit knapp
 * einfaengt, meldet auf einer belasteten Maschine einen Fehler, den es nicht gibt.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import type { ServerMessage } from '../../src/contracts/realtime.js'
import type { SyncElement } from '../../src/contracts/scene.js'
import { SCENE_VERSION_RETENTION } from '../../src/domain/board/model.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import {
  addMember,
  createBoard,
  createWorkspace,
  signedInAs,
  storedScene,
  storedVersions,
  warteAufVersion,
} from '../support/board-fixture.js'
import type { Account } from '../support/board-fixture.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { change, element, openRealtime, ruhe } from '../support/realtime-socket.js'
import type { RealtimeTestClient } from '../support/realtime-socket.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

/** Lastziel aus dem Produktvertrag. */
const EDITOREN = 5
const VERBINDUNGEN_JE_KONTO = 2

/**
 * Obergrenzen der Zustellzeit einer Aenderung an **alle** anderen Teilnehmer.
 *
 * Der Bezugspunkt ist die Wahrnehmung: eine gemeinsame Zeichenflaeche fuehlt sich gleichzeitig an, solange
 * eine fremde Aenderung innerhalb von etwa hundert Millisekunden erscheint. Der Browserclient buendelt
 * bereits 50 ms davon, der Raum gibt eine angenommene Aenderung sofort weiter. 150 ms fuer das 95. Perzentil
 * lassen also rund den dreifachen Weg des Servers als Reserve, und 500 ms als Spitzenwert fangen einen
 * einzelnen Ausreisser durch Datenbank oder Ablaufplanung ab, ohne einen echten Einbruch durchzulassen.
 */
const P95_MS = 150
const MAX_MS = 500

/**
 * Der Checkpoint-Takt: zwei Sekunden Ruhe, spaetestens zehn Sekunden. Gemessen wird mit Zuschlag, weil die
 * Zeitgeber von Node keine Echtzeitgarantie geben.
 */
const RUHE_TAKT_MS = 2_000
const OBERGRENZE_TAKT_MS = 10_000
const ZUSCHLAG_MS = 1_500

let pool: Pool
let provider: TestProvider
let app: TestApp
const clients: RealtimeTestClient[] = []

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  try {
    await pool.query('select 1')
  } catch (error) {
    throw new Error(`Keine Testdatenbank unter ${DATABASE_URL}. Zuerst "npm run db:up" ausfuehren.`, { cause: error })
  }
  await migrate(pool)
  provider = await startTestProvider()
  // Bewusst ohne verkuerzte Takte: gemessen wird das, was im Betrieb gilt.
  app = await startTestApp({ provider, pool, databaseUrl: DATABASE_URL })
})

afterAll(async () => {
  await app.close()
  await provider.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
  app.clearLogs()
})

async function schliesseAlle(): Promise<void> {
  for (const client of clients.splice(0)) {
    client.close()
    await client.closeCode
  }
  for (let versuch = 0; versuch < 200 && app.rooms.roomCount > 0; versuch += 1) {
    await ruhe(10)
  }
}

/** Ein Arbeitsbereich mit `EDITOREN` schreibberechtigten Konten und einem Board. */
async function team() {
  const besitzer = await signedInAs(app, 'last-0')
  const workspace = await createWorkspace(app, besitzer, 'Lastprobe')
  const konten: Account[] = [besitzer]
  for (let index = 1; index < EDITOREN; index += 1) {
    const konto = await signedInAs(app, `last-${String(index)}`)
    await addMember(app, besitzer, workspace.id, konto)
    konten.push(konto)
  }
  const board = await createBoard(app, besitzer, workspace.id, 'Lastboard')
  return { konten, board }
}

async function verbinde(konten: readonly Account[], jeKonto: number): Promise<RealtimeTestClient[]> {
  const offen: RealtimeTestClient[] = []
  for (const konto of konten) {
    for (let index = 0; index < jeKonto; index += 1) {
      const client = await openRealtime(app.baseUrl, konto.jar.cookieHeader())
      clients.push(client)
      offen.push(client)
    }
  }
  return offen
}

function perzentil(werte: readonly number[], anteil: number): number {
  const sortiert = [...werte].sort((links, rechts) => links - rechts)
  const index = Math.min(sortiert.length - 1, Math.floor(sortiert.length * anteil))
  return sortiert[index] ?? 0
}

describe('Lastziel: fuenf Bearbeiter, zehn Verbindungen', () => {
  it('stellt jede Aenderung allen anderen Verbindungen innerhalb der Zielzeit zu', async () => {
    const { konten, board } = await team()
    const offen = await verbinde(konten, VERBINDUNGEN_JE_KONTO)
    expect(offen).toHaveLength(EDITOREN * VERBINDUNGEN_JE_KONTO)
    for (const client of offen) {
      await client.join(board.id)
    }

    /** Zeitpunkt des Absendens je Elementstand; der Schluessel ist eindeutig ueber alle Runden. */
    const gesendet = new Map<string, number>()
    /** Zustellzeiten je Elementstand, ein Eintrag je empfangender Verbindung. */
    const zugestellt = new Map<string, number[]>()
    for (const client of offen) {
      client.socket.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString('utf8')) as ServerMessage
        if (message.type !== 'scene-change') {
          return
        }
        for (const geaendert of message.elements) {
          const schluessel = `${geaendert.id}#${String(geaendert.version)}`
          const start = gesendet.get(schluessel)
          if (start !== undefined) {
            zugestellt.get(schluessel)?.push(performance.now() - start)
          }
        }
      })
    }

    // Fuenf Bearbeiter zeichnen abwechselnd, im Takt der Buendelung des Browserclients.
    const runden = 20
    const schreiber = offen.slice(0, EDITOREN)
    for (let runde = 1; runde <= runden; runde += 1) {
      for (const [index, client] of schreiber.entries()) {
        const geaendert: SyncElement = element(`editor-${String(index)}`, runde, runde * 10 + index)
        const schluessel = `editor-${String(index)}#${String(runde)}`
        zugestellt.set(schluessel, [])
        gesendet.set(schluessel, performance.now())
        client.send(change(board.id, [geaendert]))
      }
      await ruhe(50)
    }
    await ruhe(500)

    // Jede Aenderung muss bei allen **anderen** Verbindungen angekommen sein - der Absender bekommt sie nie.
    const empfaenger = offen.length - 1
    const schlechteste: number[] = []
    for (const [schluessel, zeiten] of zugestellt) {
      expect(zeiten, `Aenderung ${schluessel} kam nicht ueberall an`).toHaveLength(empfaenger)
      schlechteste.push(Math.max(...zeiten))
    }
    expect(schlechteste).toHaveLength(runden * EDITOREN)

    const p95 = perzentil(schlechteste, 0.95)
    const spitze = Math.max(...schlechteste)
    console.log(
      `Zustellzeit an alle ${String(empfaenger)} Gegenstellen: p50 ${perzentil(schlechteste, 0.5).toFixed(1)} ms, ` +
        `p95 ${p95.toFixed(1)} ms, Spitze ${spitze.toFixed(1)} ms`,
    )
    expect(p95).toBeLessThan(P95_MS)
    expect(spitze).toBeLessThan(MAX_MS)

    // Ressourcen: der Raum haelt die Zeichnung, nicht die Nachrichten. Fuenf Bearbeiter mit je zwanzig
    // Aenderungen ergeben genau fuenf Elemente.
    await schliesseAlle()
    expect(app.rooms.roomCount).toBe(0)
    // Der letzte Abgang schreibt noch, was offen ist - genau darauf wartet die Messung.
    await warteAufVersion(pool, board.id, 1)
    const gespeichert = await storedScene(pool, board.id)
    expect(gespeichert.scene.elements).toHaveLength(EDITOREN)
    expect(await storedVersions(pool, board.id)).toBeLessThanOrEqual(SCENE_VERSION_RETENTION)
  })

  it('haelt den Checkpoint-Takt unter Dauerlast ein', async () => {
    const { konten, board } = await team()
    const offen = await verbinde(konten, 1)
    for (const client of offen) {
      await client.join(board.id)
    }

    // Durchgehendes Zeichnen ueber die Obergrenze des Takts hinaus: waehrend dieser Zeit darf es genau
    // einen Checkpoint geben - den der Obergrenze -, nicht einen je Aenderung.
    const start = performance.now()
    const dauer = OBERGRENZE_TAKT_MS + 1_500
    let runde = 0
    while (performance.now() - start < dauer) {
      runde += 1
      for (const [index, client] of offen.entries()) {
        client.send(change(board.id, [element(`editor-${String(index)}`, runde, runde * 10 + index)]))
      }
      await ruhe(100)
    }
    const aenderungen = runde * EDITOREN
    const waehrendDerLast = await storedVersions(pool, board.id)
    const beiObergrenze = performance.now() - start

    // Danach Ruhe: der Ruhetakt schreibt den letzten Stand.
    await ruhe(RUHE_TAKT_MS + ZUSCHLAG_MS)
    const nachRuhe = await storedVersions(pool, board.id)

    console.log(
      `${String(aenderungen)} Aenderungen in ${(beiObergrenze / 1000).toFixed(1)} s ergaben ` +
        `${String(waehrendDerLast)} Checkpoints, nach der Ruhezeit ${String(nachRuhe)}`,
    )
    // Die Obergrenze hat gegriffen: mindestens ein Stand ist waehrend der Dauerlast sicher ...
    expect(waehrendDerLast).toBeGreaterThanOrEqual(1)
    // ... und der Takt hat gebuendelt statt je Aenderung zu schreiben.
    expect(waehrendDerLast).toBeLessThanOrEqual(Math.ceil(dauer / OBERGRENZE_TAKT_MS) + 1)
    expect(waehrendDerLast * 10).toBeLessThan(aenderungen)
    // Der Ruhetakt hat den Abschluss geschrieben.
    expect(nachRuhe).toBeGreaterThan(waehrendDerLast)
    const gespeichert = await storedScene(pool, board.id)
    expect(gespeichert.scene.elements).toHaveLength(EDITOREN)
    expect(gespeichert.scene.elements.every((entry) => entry['version'] === runde)).toBe(true)

    await schliesseAlle()
  }, 30_000)
})
