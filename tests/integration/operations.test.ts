/**
 * Betriebsendpunkte einer laufenden Instanz: Bereitschaft, Metriken und Ratengrenze.
 *
 * Die Bereitschaft ist die Stelle, an der ein Reverse Proxy entscheidet, ob diese Instanz Verkehr bekommt.
 * Sie wird deshalb nicht gegen Attrappen geprueft, sondern gegen echte Fehlerlagen: eine Datenbank, die
 * nicht antwortet, und ein Assetspeicher, den es nicht gibt.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import type { ReadyResponse } from '../../src/contracts/api.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

/** Ein Port, auf dem nichts lauscht. Die Verbindung scheitert, statt zu haengen. */
const TOTE_DATENBANK = 'postgres://canvaz:canvaz@127.0.0.1:1/canvaz'

let pool: Pool
let provider: TestProvider
let app: TestApp

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  try {
    await pool.query('select 1')
  } catch (error) {
    throw new Error(`Keine Testdatenbank unter ${DATABASE_URL}. Zuerst "npm run db:up" ausfuehren.`, { cause: error })
  }
  await migrate(pool)
  provider = await startTestProvider()
  app = await startTestApp({ provider, pool, databaseUrl: DATABASE_URL })
})

afterAll(async () => {
  await app.close()
  await provider.close()
  await pool.end()
})

describe('Bereitschaft', () => {
  it('meldet mit erreichbarer Datenbank und erreichbarem Speicher 200', async () => {
    const response = await fetch(`${app.baseUrl}/api/ready`)

    expect(response.status).toBe(200)
    expect((await response.json()) as ReadyResponse).toEqual({ status: 'ready', database: 'ok', storage: 'ok' })
  })

  it('haelt Verkehr zurueck, solange die Datenbank nicht antwortet', async () => {
    const tot = createPool(TOTE_DATENBANK)
    const instanz = await startTestApp({ provider, pool: tot, databaseUrl: TOTE_DATENBANK })
    try {
      const response = await fetch(`${instanz.baseUrl}/api/ready`)

      expect(response.status).toBe(503)
      expect((await response.json()) as ReadyResponse).toEqual({
        status: 'unready',
        database: 'error',
        storage: 'ok',
      })
      // Der Grund steht im Log, nicht in der oeffentlich erreichbaren Antwort.
      expect(instanz.logs.some((entry) => entry.event === 'ready.failed')).toBe(true)
    } finally {
      await instanz.close()
      await tot.end()
    }
  })

  it('haelt Verkehr zurueck, solange der Assetspeicher fehlt', async () => {
    // Eine Datei statt eines Verzeichnisses: genau die Lage, in der das Volume nicht eingehaengt ist.
    const verzeichnis = await mkdtemp(join(tmpdir(), 'canvaz-ready-'))
    const keinVolume = join(verzeichnis, 'keine-wurzel')
    await writeFile(keinVolume, '')
    const instanz = await startTestApp({
      provider,
      pool,
      databaseUrl: DATABASE_URL,
      storage: { CANVAZ_STORAGE_ADAPTER: 'filesystem', CANVAZ_STORAGE_FILESYSTEM_ROOT: keinVolume },
    })
    try {
      const response = await fetch(`${instanz.baseUrl}/api/ready`)

      expect(response.status).toBe(503)
      expect((await response.json()) as ReadyResponse).toEqual({
        status: 'unready',
        database: 'ok',
        storage: 'error',
      })
    } finally {
      await instanz.close()
    }
  })
})

describe('Datenbankverbindung', () => {
  it('ueberlebt den Abbruch einer leerlaufenden Verbindung, statt den Prozess zu beenden', async () => {
    // Ein `error`-Ereignis am Pool ohne Zuhoerer ist in Node eine unbehandelte Ausnahme - ein
    // Datenbankneustart wuerde den Anwendungsprozess mitnehmen, bevor offene Boardraeume ihren Stand
    // schreiben. Der Abbruch wird hier echt herbeigefuehrt, nicht nachgestellt.
    const kennung = `canvaz_pool_test_${String(process.pid)}`
    const fehler: unknown[] = []
    const eigener = createPool(`${DATABASE_URL}?application_name=${kennung}`, (error) => fehler.push(error))
    try {
      await eigener.query('select 1')

      await pool.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1', [kennung])
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(fehler.length).toBeGreaterThan(0)
      // Und der Pool baut die Verbindung beim naechsten Bedarf neu auf.
      expect((await eigener.query<{ eins: number }>('select 1 as eins')).rows[0]?.eins).toBe(1)
    } finally {
      await eigener.end()
    }
  })
})

describe('Metriken', () => {
  it('liefert die Kernwerte im Prometheus-Textformat', async () => {
    await fetch(`${app.baseUrl}/api/health`)

    const response = await fetch(`${app.baseUrl}/api/metrics`)
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    for (const name of [
      'canvaz_uptime_seconds',
      'canvaz_http_responses_total{status="2xx"}',
      'canvaz_http_rate_limited_total',
      'canvaz_realtime_connections',
      'canvaz_board_rooms',
      'canvaz_db_pool_connections{state="total"}',
    ]) {
      expect(text).toContain(name)
    }
    // Die beantworteten Anfragen dieses Falls sind gezaehlt.
    expect(Number(/canvaz_http_responses_total\{status="2xx"\} (\d+)/.exec(text)?.[1] ?? '0')).toBeGreaterThan(0)
  })
})

describe('Ratengrenze der API', () => {
  it('lehnt oberhalb der Grenze mit 429 ab und zaehlt die Ablehnung', async () => {
    const instanz = await startTestApp({
      provider,
      pool,
      databaseUrl: DATABASE_URL,
      env: { CANVAZ_RATE_LIMIT_PER_MINUTE: '60' },
    })
    try {
      const antworten: number[] = []
      for (let i = 0; i < 70; i += 1) {
        antworten.push((await fetch(`${instanz.baseUrl}/api/health`)).status)
      }
      const abgelehnt = antworten.filter((status) => status === 429).length

      expect(abgelehnt).toBeGreaterThan(0)
      expect(antworten.at(-1)).toBe(429)
      // Die Metriken liegen selbst hinter der Grenze; eine Sekunde fuellt genau eine Marke nach.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const text = await (await fetch(`${instanz.baseUrl}/api/metrics`)).text()
      expect(text).toContain(`canvaz_http_rate_limited_total ${String(abgelehnt)}`)
    } finally {
      await instanz.close()
    }
  })
})
