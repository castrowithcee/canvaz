/**
 * Absenderabwehr gegen gehaeufte Fehlanmeldungen (#35, Meilenstein 1).
 *
 * `machePlausibel`/`machePlausibelUnwahrscheinlich` tragen den Plausibilitaetshinweis direkt in den Monitor
 * ein, statt fuenfzig echte Anfragen zu schicken (`MIN_SAMPLE` in `client-address.ts`) - der Monitor selbst
 * ist bereits unit- und integrationsgetestet (`tests/unit/client-address.test.ts`,
 * `tests/integration/client-address.test.ts`); hier geht es um die Sperre, die daran haengt.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { AUTH_LOCAL_LOGIN_PATH, AUTH_SECOND_FACTOR_VERIFY_PATH, CSRF_HEADER } from '../../src/contracts/api.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { createJar } from '../support/browser-client.js'
import { TEST_PASSWORD, localLogin, profileOf, signedInAsSystemAdmin } from '../support/local-accounts.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

let pool: Pool

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  await migrate(pool)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  // Jeder Fall beginnt mit einer leeren Instanz - der Bootstrap-Systemadmin des letzten Falls darf keinen
  // "already-administered"-Fehlschlag im naechsten ausloesen.
  await pool.query(
    'truncate users, workspaces, login_throttle, sender_failure_counter, sender_block, sender_block_proposal cascade',
  )
})

/** Eng genug, um die Schwelle in wenigen Versuchen zu erreichen. */
const SCHWELLE = 3

/** Eigene Instanz mit enger Schwelle und aktivem Proxy: `x-forwarded-for` steht fuer den Absender. */
function engeInstanz(env: Readonly<Record<string, string>> = {}): Promise<TestApp> {
  return startTestApp({
    pool,
    databaseUrl: DATABASE_URL,
    env: { CANVAZ_LOGIN_BLOCK_THRESHOLD: String(SCHWELLE), CANVAZ_TRUSTED_PROXY: 'true', ...env },
  })
}

/** Ein fehlgeschlagener Anmeldeversuch von `absender` - ohne Konto, damit keine Kontodrosselung dazwischenfunkt. */
function versuch(app: TestApp, absender?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (absender !== undefined) {
    headers['x-forwarded-for'] = absender
  }
  return fetch(`${app.baseUrl}${AUTH_LOCAL_LOGIN_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: 'niemand@example.com', password: 'falsches-passwort-x' }),
  })
}

/** Erzwingt "plausible", ohne fuenfzig echte Anfragen zu brauchen. */
function machePlausibel(app: TestApp): void {
  for (let i = 0; i < 50; i += 1) {
    app.context.addressMonitor.record({ address: '203.0.113.200', class: 'public' })
  }
}

function machePlausibelUnwahrscheinlich(app: TestApp): void {
  for (let i = 0; i < 50; i += 1) {
    app.context.addressMonitor.record({ address: '10.0.0.5', class: 'private' })
  }
}

let app: TestApp | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('Absenderabwehr (#35)', () => {
  it('sperrt nach der Schwelle vor der Pruefung, laesst andere Adressen unberuehrt und speichert die Zaehlung nicht im Klartext', async () => {
    app = await engeInstanz()
    machePlausibel(app)
    const absender = '198.51.100.11'
    for (let i = 0; i < SCHWELLE; i += 1) {
      expect((await versuch(app, absender)).status).toBe(401)
    }
    const gesperrt = await versuch(app, absender)
    expect(gesperrt.status).toBe(429)
    // Kontoneutral: die Antwort nennt kein Konto.
    expect(await gesperrt.text()).not.toMatch(/konto|account/i)

    // Eine andere Adresse teilt das Budget nicht.
    expect((await versuch(app, '198.51.100.12')).status).toBe(401)

    // Die Zaehlung selbst steht nie im Klartext in der Datenbank.
    const zeilen = await pool.query("select 1 from sender_failure_counter where key_hash::text like '%198.51.100%'")
    expect(zeilen.rowCount).toBe(0)

    // Die ausgeloeste Sperre dagegen ist absichtlich nachvollziehbar.
    const sperre = await pool.query('select reason, failure_count from sender_block where address = $1', [absender])
    expect(sperre.rowCount).toBe(1)
    expect(sperre.rows[0].failure_count).toBeGreaterThanOrEqual(SCHWELLE)
  })

  it('zaehlt eine IPv6-Adresse im selben /64-Praefix gemeinsam', async () => {
    app = await engeInstanz()
    machePlausibel(app)
    for (const absender of ['2001:db8:abcd:1::1', '2001:db8:abcd:1::2', '2001:db8:abcd:1::3']) {
      expect((await versuch(app, absender)).status).toBe(401)
    }
    expect((await versuch(app, '2001:db8:abcd:1::4')).status).toBe(429)
    // Ein anderes /64-Praefix bleibt unberuehrt.
    expect((await versuch(app, '2001:db8:abcd:2::1')).status).toBe(401)
  })

  it('behandelt IPv4-gemappte Adressen wie ihre IPv4-Form: getrennte Zaehlung, nie gesperrt aus einer IPv4-Allowlist', async () => {
    app = await engeInstanz({ CANVAZ_LOGIN_BLOCK_ALLOWLIST: '203.0.113.0/24' })
    machePlausibel(app)
    const a = '::ffff:198.51.100.41'
    const b = '::ffff:198.51.100.42'
    for (let i = 0; i < SCHWELLE; i += 1) {
      expect((await versuch(app, a)).status).toBe(401)
    }
    expect((await versuch(app, a)).status).toBe(429)
    // Eine andere gemappte Adresse teilt den Zaehler nicht - trotz gemeinsamer IPv6-Rohform ohne Normalisierung.
    expect((await versuch(app, b)).status).toBe(401)

    // Eine gemappte Adresse aus einer IPv4-Allowlist wird nie gesperrt.
    const erlaubt = '::ffff:203.0.113.9'
    for (let i = 0; i < SCHWELLE + 2; i += 1) {
      expect((await versuch(app, erlaubt)).status).toBe(401)
    }
  })

  it('sperrt Allowlist-, private und Proxyadressen nie', async () => {
    app = await engeInstanz({ CANVAZ_LOGIN_BLOCK_ALLOWLIST: '203.0.113.0/24' })
    machePlausibel(app)
    for (let i = 0; i < SCHWELLE + 2; i += 1) {
      expect((await versuch(app, '203.0.113.5')).status).toBe(401)
    }
    for (let i = 0; i < SCHWELLE + 2; i += 1) {
      expect((await versuch(app, '10.1.2.3')).status).toBe(401)
    }
    // Ohne `x-forwarded-for` gilt bei aktivem Proxy die Verbindungsadresse als `proxy`, nie als Client.
    for (let i = 0; i < SCHWELLE + 2; i += 1) {
      expect((await versuch(app, undefined)).status).toBe(401)
    }
  })

  it('legt ohne plausible Client-Adressen keine Sperre an', async () => {
    app = await engeInstanz()
    machePlausibelUnwahrscheinlich(app)
    const absender = '198.51.100.13'
    for (let i = 0; i < SCHWELLE + 2; i += 1) {
      expect((await versuch(app, absender)).status).toBe(401)
    }
    const sperre = await pool.query('select 1 from sender_block where address = $1', [absender])
    expect(sperre.rowCount).toBe(0)
  })

  it('hebt die Sperre nach 24 Stunden von selbst auf', async () => {
    app = await engeInstanz()
    machePlausibel(app)
    const jetzt = new Date()
    app.setNow(jetzt)
    const absender = '198.51.100.14'
    for (let i = 0; i < SCHWELLE; i += 1) {
      await versuch(app, absender)
    }
    expect((await versuch(app, absender)).status).toBe(429)

    app.setNow(new Date(jetzt.getTime() + 24 * 3600_000 + 60_000))
    expect((await versuch(app, absender)).status).toBe(401)
  })

  it('erzeugt bei einer zweiten Sperre binnen 30 Tagen einen Vorschlag fuer eine dauerhafte Sperre', async () => {
    app = await engeInstanz()
    machePlausibel(app)
    const jetzt = new Date()
    app.setNow(jetzt)
    const absender = '198.51.100.15'
    for (let i = 0; i < SCHWELLE; i += 1) {
      await versuch(app, absender)
    }
    expect((await versuch(app, absender)).status).toBe(429)

    // Die erste Sperre ist abgelaufen, die zweite folgt noch innerhalb von 30 Tagen.
    app.setNow(new Date(jetzt.getTime() + 25 * 3600_000))
    for (let i = 0; i < SCHWELLE; i += 1) {
      await versuch(app, absender)
    }
    expect((await versuch(app, absender)).status).toBe(429)

    const vorschlaege = await pool.query(
      'select status, decided_at from sender_block_proposal where address = $1',
      [absender],
    )
    expect(vorschlaege.rowCount).toBe(1)
    expect(vorschlaege.rows[0].status).toBe('pending')
    expect(vorschlaege.rows[0].decided_at).toBeNull()
  })

  it('raeumt eine abgelaufene Sperre nach ihrer Aufbewahrungsfrist weg', async () => {
    app = await engeInstanz({ CANVAZ_LOGIN_BLOCK_RETENTION_DAYS: '1' })
    machePlausibel(app)
    const jetzt = new Date()
    app.setNow(jetzt)
    const absender = '198.51.100.16'
    for (let i = 0; i < SCHWELLE; i += 1) {
      await versuch(app, absender)
    }
    expect((await versuch(app, absender)).status).toBe(429)

    // Weit hinter Ablauf (24h) und Aufbewahrungsfrist (1 Tag): eine unbeteiligte Anfrage raeumt opportunistisch auf.
    app.setNow(new Date(jetzt.getTime() + 3 * 24 * 3600_000))
    await versuch(app, '203.0.113.201')

    const sperre = await pool.query('select 1 from sender_block where address = $1', [absender])
    expect(sperre.rowCount).toBe(0)
  })

  it('raeumt einen alten Zaehlwert aus dem eigenstaendigen Aufraeumlauf weg', async () => {
    app = await engeInstanz()
    const jetzt = new Date()
    app.setNow(jetzt)
    const alterSchluessel = 'a'.repeat(64)
    await pool.query(
      `insert into sender_failure_counter (key_hash, attempts, window_started_at) values ($1, 1, $2)`,
      [alterSchluessel, new Date(jetzt.getTime() - 25 * 3600_000)],
    )

    await app.context.identity.senderDefense.purgeExpired({
      counterWindowStart: new Date(jetzt.getTime() - 24 * 3600_000),
      blockRetentionCutoff: jetzt,
      proposalRetentionCutoff: jetzt,
    })

    const zeilen = await pool.query('select 1 from sender_failure_counter where key_hash = $1', [alterSchluessel])
    expect(zeilen.rowCount).toBe(0)
  })

  it('sperrt auch die Bestaetigung des zweiten Faktors einer Anmeldung nach der Schwelle', async () => {
    const instanz = await engeInstanz()
    app = instanz
    machePlausibel(instanz)
    const admin = await signedInAsSystemAdmin(instanz, { email: 'root@example.com' })
    expect(admin.profile.user.email).toBe('root@example.com')

    const jar = createJar()
    expect((await localLogin(instanz, jar, 'root@example.com', TEST_PASSWORD)).status).toBe(200)

    async function falscherZweiterFaktor(absender: string): Promise<Response> {
      const { csrfToken } = await profileOf(instanz, jar)
      return jar.fetch(`${instanz.baseUrl}${AUTH_SECOND_FACTOR_VERIFY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: csrfToken, 'x-forwarded-for': absender },
        body: JSON.stringify({ code: '000000' }),
      })
    }

    const absender = '198.51.100.17'
    for (let i = 0; i < SCHWELLE; i += 1) {
      expect((await falscherZweiterFaktor(absender)).status).toBe(400)
    }
    expect((await falscherZweiterFaktor(absender)).status).toBe(429)
  })
})
