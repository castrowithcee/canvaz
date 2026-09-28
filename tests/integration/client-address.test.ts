/**
 * Systemadministration: Adresse und Klasse der aktuellen Anfrage.
 *
 * Die Ermittlung und Klassifizierung selbst sind unit-getestet (`tests/unit/client-address.test.ts`); hier
 * geht es um den echten Endpunkt: Zugriffsbeschraenkung und dass Verbindungsadresse bzw. `x-forwarded-for`
 * tatsaechlich ankommen.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { ADMIN_CLIENT_ADDRESS_PATH, AUTH_METHODS_PATH, HEALTH_PATH } from '../../src/contracts/api.js'
import type { ClientAddressResponse } from '../../src/contracts/api.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { hashPassword } from '../../src/server/password.js'
import { createJar } from '../support/browser-client.js'
import { TEST_PASSWORD, localLogin, profileOf, signedInAsSystemAdmin } from '../support/local-accounts.js'
import type { Account } from '../support/local-accounts.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

let pool: Pool
let app: TestApp

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  await migrate(pool)
  app = await startTestApp({ pool, databaseUrl: DATABASE_URL })
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces, login_throttle cascade')
  app.clearLogs()
})

/** Ein gewoehnliches, angemeldetes Konto - ohne Umweg ueber die Systemadministration. */
async function memberAccount(instanz: TestApp, email: string): Promise<Account> {
  const user = await instanz.store.users.create({ displayName: email, email }, { isSystemAdmin: false })
  await instanz.store.localCredentials.set(user.id, await hashPassword(TEST_PASSWORD), { mustChangePassword: false })
  const jar = createJar()
  expect((await localLogin(instanz, jar, email, TEST_PASSWORD)).status).toBe(200)
  return { jar, profile: await profileOf(instanz, jar) }
}

describe('Client-Adresse der aktuellen Anfrage', () => {
  it('zeigt Verbindungsadresse und Klasse ohne konfigurierten Proxy', async () => {
    const admin = await signedInAsSystemAdmin(app)

    const response = await admin.jar.fetch(`${app.baseUrl}${ADMIN_CLIENT_ADDRESS_PATH}`)
    const body = (await response.json()) as ClientAddressResponse

    expect(response.status).toBe(200)
    // Der Testserver horcht ausdruecklich auf 127.0.0.1 (siehe `startTestApp`).
    expect(body.address).toBe('127.0.0.1')
    expect(body.addressClass).toBe('loopback')
    expect(body.trustedProxy).toBe(false)
  })

  it('erkennt Proxyadresse und weitergereichte Client-Adresse hinter CANVAZ_TRUSTED_PROXY', async () => {
    const eng = await startTestApp({ pool, databaseUrl: DATABASE_URL, env: { CANVAZ_TRUSTED_PROXY: 'true' } })
    try {
      const admin = await signedInAsSystemAdmin(eng)

      // Ohne x-forwarded-for ist die Verbindungsadresse die des Proxys selbst - nicht der Client.
      const ohneWeiterleitung = await admin.jar.fetch(`${eng.baseUrl}${ADMIN_CLIENT_ADDRESS_PATH}`)
      expect(((await ohneWeiterleitung.json()) as ClientAddressResponse).addressClass).toBe('proxy')

      const mitWeiterleitung = await admin.jar.fetch(`${eng.baseUrl}${ADMIN_CLIENT_ADDRESS_PATH}`, {
        headers: { 'x-forwarded-for': '203.0.113.7' },
      })
      const body = (await mitWeiterleitung.json()) as ClientAddressResponse
      expect(body.address).toBe('203.0.113.7')
      expect(body.addressClass).toBe('public')
      expect(body.trustedProxy).toBe(true)
    } finally {
      await eng.close()
    }
  })

  it('zaehlt Betriebsendpunkte nicht in den Plausibilitaetshinweis', async () => {
    const eng = await startTestApp({ pool, databaseUrl: DATABASE_URL, env: { CANVAZ_TRUSTED_PROXY: 'true' } })
    try {
      const admin = await signedInAsSystemAdmin(eng)

      // Viele Betriebsproben - wie Docker- und Proxy-Healthcheck sie in einem realen Deployment erzeugen -
      // ohne dass ein echter Client dahintersteht.
      for (let i = 0; i < 150; i += 1) {
        expect((await fetch(`${eng.baseUrl}${HEALTH_PATH}`)).status).toBe(200)
      }
      // Eine Handvoll echter, oeffentlicher Anfragen - genug fuer die Mindeststichprobe des Monitors. Waeren
      // die Betriebsproben mitgezaehlt, wuerden sie diese wenigen oeffentlichen Anfragen weit ueberwiegen.
      for (let i = 0; i < 60; i += 1) {
        await fetch(`${eng.baseUrl}${AUTH_METHODS_PATH}`, { headers: { 'x-forwarded-for': '203.0.113.9' } })
      }

      expect(eng.logs.filter((entry) => entry.event === 'client-address.mostly-internal')).toHaveLength(0)

      const response = await admin.jar.fetch(`${eng.baseUrl}${ADMIN_CLIENT_ADDRESS_PATH}`)
      const body = (await response.json()) as ClientAddressResponse
      expect(body.plausibility).not.toBe('implausible')
    } finally {
      await eng.close()
    }
  })

  it('ist ausschliesslich dem Systemadmin zugaenglich', async () => {
    const anonym = await fetch(`${app.baseUrl}${ADMIN_CLIENT_ADDRESS_PATH}`)
    expect(anonym.status).toBe(401)

    const nutzer = await memberAccount(app, 'ada@example.com')
    const response = await nutzer.jar.fetch(`${app.baseUrl}${ADMIN_CLIENT_ADDRESS_PATH}`)
    expect(response.status).toBe(403)
  })
})
