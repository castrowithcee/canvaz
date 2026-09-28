/**
 * Zweiter Faktor des Systemadmins - gegen die echte Anwendung, eine echte Datenbank und einen echten
 * OIDC-Provider.
 *
 * Bewusst flach: je Zusage ein Fall. Die Codes erzeugt der Test mit derselben Bibliothek, die eine
 * Authenticator-App nachbildet; die Uhr der Anwendung wird dafuer angehalten.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { WebSocket } from 'ws'

import {
  ADMIN_USERS_PATH,
  AUTH_SECOND_FACTOR_BACKUP_CODES_PATH,
  AUTH_SECOND_FACTOR_ENROLL_PATH,
  ME_PATH,
  REALTIME_PATH,
  WORKSPACES_PATH,
} from '../../src/contracts/api.js'
import type { SecondFactorBackupCodesResponse } from '../../src/contracts/api.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { recoverSystemAdmin } from '../../src/server/admin-recovery.js'
import { bootstrapSystemAdmin } from '../../src/server/bootstrap-admin.js'
import { createInvitationToken, hashInvitationToken } from '../../src/server/invitations.js'
import { createJar } from '../support/browser-client.js'
import type { Jar } from '../support/browser-client.js'
import {
  TEST_PASSWORD,
  completeSecondFactorSetup,
  localLogin,
  postWithCsrf,
  profileOf,
  redeemInvitation,
  signedInAsSystemAdmin,
  totpCode,
  verifySecondFactor,
} from '../support/local-accounts.js'
import { login } from '../support/login-flow.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

const SCHRITT_MS = 30_000

let pool: Pool
let provider: TestProvider
let app: TestApp

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  await migrate(pool)
  provider = await startTestProvider()
  app = await startTestApp({
    provider,
    pool,
    databaseUrl: DATABASE_URL,
    env: { CANVAZ_SMTP_HOST: 'postausgang.invalid', CANVAZ_MAIL_FROM: 'canvaz@example.com' },
  })
})

afterAll(async () => {
  await app.close()
  await provider.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces, login_throttle cascade')
  app.clearLogs()
  app.clearMails()
  app.setNow(null)
})

function get(jar: Jar, path: string): Promise<Response> {
  return jar.fetch(`${app.baseUrl}${path}`)
}

/** Status des WebSocket-Upgrades: 101 bei Erfolg, sonst die Ablehnung. */
function upgradeStatus(baseUrl: string, jar: Jar): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}${REALTIME_PATH}`, {
      headers: { cookie: jar.cookieHeader(), origin: baseUrl },
    })
    socket.once('open', () => {
      socket.close()
      resolve(101)
    })
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0)
    })
    socket.once('error', reject)
  })
}

/** Systemadmin direkt nach dem Einloesen: noch ohne Faktor, die Sitzung ist eingeschraenkt. */
async function adminOhneFaktor(): Promise<Jar> {
  const result = await bootstrapSystemAdmin(app.store, { displayName: 'Root', email: 'root@example.com', now: app.context.now() })
  const jar = createJar()
  expect((await redeemInvitation(app, jar, result.kind === 'created' ? result.token : '', TEST_PASSWORD)).status).toBe(200)
  return jar
}

/** Eine neue lokale Anmeldung des Systemadmins - eingeschraenkt bis zur Abfrage. */
async function neueAdminSitzung(target: TestApp = app): Promise<Jar> {
  const jar = createJar()
  expect((await localLogin(target, jar, 'root@example.com', TEST_PASSWORD)).status).toBe(200)
  return jar
}

describe('Sitzung ohne Nachweis', () => {
  it('bekommt lokal nur Profil und Einrichtung, keine Endpunkte und keinen WebSocket', async () => {
    const jar = await adminOhneFaktor()

    expect((await profileOf(app, jar)).secondFactor).toEqual({ state: 'setup-required' })
    expect((await get(jar, ADMIN_USERS_PATH)).status).toBe(403)
    expect((await get(jar, WORKSPACES_PATH)).status).toBe(403)
    expect(await upgradeStatus(app.baseUrl, jar)).toBe(403)

    await completeSecondFactorSetup(app, jar)
    expect((await profileOf(app, jar)).secondFactor).toEqual({ state: 'verified', backupCodesRemaining: 10 })
    expect((await get(jar, ADMIN_USERS_PATH)).status).toBe(200)
    expect(await upgradeStatus(app.baseUrl, jar)).toBe(101)

    // Jede weitere Anmeldung beginnt wieder eingeschraenkt.
    const spaeter = await neueAdminSitzung()
    expect((await profileOf(app, spaeter)).secondFactor).toEqual({ state: 'verification-required' })
    expect((await get(spaeter, ADMIN_USERS_PATH)).status).toBe(403)
  })

  it('gilt ebenso fuer die Anmeldung ueber OIDC', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const jar = createJar()

    expect((await login(app, jar, { subject: 'root-extern', email: 'root@example.com' })).error).toBeNull()
    expect((await profileOf(app, jar)).secondFactor).toEqual({ state: 'verification-required' })
    expect((await get(jar, ADMIN_USERS_PATH)).status).toBe(403)

    const naechsterSchritt = new Date(app.context.now().getTime() + SCHRITT_MS)
    app.setNow(naechsterSchritt)
    expect((await verifySecondFactor(app, jar, totpCode(admin.totpSecret, naechsterSchritt))).status).toBe(200)
    expect((await get(jar, ADMIN_USERS_PATH)).status).toBe(200)
  })

  it('laesst einen normalen Nutzer unveraendert', async () => {
    await signedInAsSystemAdmin(app)
    const ada = await app.store.users.create({ displayName: 'Ada', email: 'ada@example.com' }, { isSystemAdmin: false })
    const token = createInvitationToken()
    await app.store.invitations.create({
      userId: ada.id,
      tokenHash: hashInvitationToken(token),
      createdByUserId: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    const jar = createJar()
    expect((await redeemInvitation(app, jar, token, TEST_PASSWORD)).status).toBe(200)

    expect((await profileOf(app, jar)).secondFactor).toEqual({ state: 'not-required' })
    expect((await get(jar, WORKSPACES_PATH)).status).toBe(200)
    expect((await postWithCsrf(app, jar, AUTH_SECOND_FACTOR_ENROLL_PATH, {})).status).toBe(403)
  })
})

describe('Codes', () => {
  it('lehnt falsche und wiederholte Codes ab und toleriert einen Schritt Abweichung', async () => {
    const start = new Date()
    app.setNow(start)
    const admin = await signedInAsSystemAdmin(app)
    const at = (schritte: number) => new Date(start.getTime() + schritte * SCHRITT_MS)

    const erste = await neueAdminSitzung()
    // Weit ausserhalb des Fensters und damit falsch; der Code der Einrichtung ist bereits verbraucht.
    expect((await verifySecondFactor(app, erste, totpCode(admin.totpSecret, at(10)))).status).toBe(400)
    expect((await verifySecondFactor(app, erste, totpCode(admin.totpSecret, start))).status).toBe(400)

    app.setNow(at(2))
    // Ein Schritt nachgehend: angenommen.
    expect((await verifySecondFactor(app, erste, totpCode(admin.totpSecret, at(1)))).status).toBe(200)

    const zweite = await neueAdminSitzung()
    // Derselbe Code in einer anderen Sitzung: Wiederholung. Zwei Schritte voraus: ausserhalb des Fensters.
    expect((await verifySecondFactor(app, zweite, totpCode(admin.totpSecret, at(1)))).status).toBe(400)
    expect((await verifySecondFactor(app, zweite, totpCode(admin.totpSecret, at(4)))).status).toBe(400)
    // Ein Schritt vorgehend: angenommen.
    expect((await verifySecondFactor(app, zweite, totpCode(admin.totpSecret, at(3)))).status).toBe(200)
  })

  it('nimmt einen Ersatzcode genau einmal an, auch gleichzeitig', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const [code = ''] = admin.backupCodes
    const [eins, zwei] = await Promise.all([neueAdminSitzung(), neueAdminSitzung()])

    const ergebnisse = await Promise.all([verifySecondFactor(app, eins, code), verifySecondFactor(app, zwei, code)])

    expect(ergebnisse.map((antwort) => antwort.status).sort()).toEqual([200, 400])
    expect((await verifySecondFactor(app, await neueAdminSitzung(), code.toLowerCase())).status).toBe(400)
    const verbraucht = ergebnisse[0]?.status === 200 ? eins : zwei
    expect((await profileOf(app, verbraucht)).secondFactor).toEqual({ state: 'verified', backupCodesRemaining: 9 })
  })

  it('drosselt die zweite Stufe je Konto, auch ueber eine neue App-Instanz hinweg', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const eng = { env: { CANVAZ_AUTH_RATE_LIMIT_PER_ACCOUNT: '3' }, pool, databaseUrl: DATABASE_URL }
    const erste = await startTestApp(eng)
    try {
      const jar = await neueAdminSitzung(erste)
      for (let versuch = 0; versuch < 3; versuch += 1) {
        expect((await verifySecondFactor(erste, jar, '000000')).status).toBe(400)
      }
      const naechsterSchritt = new Date(Date.now() + SCHRITT_MS)
      erste.setNow(naechsterSchritt)
      expect((await verifySecondFactor(erste, jar, totpCode(admin.totpSecret, naechsterSchritt))).status).toBe(429)
    } finally {
      await erste.close()
    }

    const zweite = await startTestApp(eng)
    try {
      expect((await verifySecondFactor(zweite, await neueAdminSitzung(zweite), admin.backupCodes[0] ?? '')).status).toBe(429)
    } finally {
      await zweite.close()
    }
  })
})

describe('Faktoraenderung und Wiederherstellung', () => {
  it('verlangt eine frische Bestaetigung und widerruft alle anderen Sitzungen', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const andere = await neueAdminSitzung()
    expect((await verifySecondFactor(app, andere, admin.backupCodes[0] ?? '')).status).toBe(200)
    app.clearMails()

    expect((await postWithCsrf(app, admin.jar, AUTH_SECOND_FACTOR_BACKUP_CODES_PATH, {})).status).toBe(400)
    expect((await postWithCsrf(app, admin.jar, AUTH_SECOND_FACTOR_ENROLL_PATH, {})).status).toBe(400)
    const neu = await postWithCsrf(app, admin.jar, AUTH_SECOND_FACTOR_BACKUP_CODES_PATH, { code: admin.backupCodes[1] })

    expect(neu.status).toBe(200)
    const { backupCodes } = (await neu.json()) as SecondFactorBackupCodesResponse
    expect(backupCodes).toHaveLength(10)
    expect((await get(andere, ME_PATH)).status).toBe(401)
    expect((await profileOf(app, admin.jar)).secondFactor).toEqual({ state: 'verified', backupCodesRemaining: 10 })
    expect(app.mails).toHaveLength(1)
    expect(app.mails[0]?.to).toBe('root@example.com')
  })

  it('entfernt den Faktor mit der Einloesung einer Betreiber-Wiederherstellung', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const result = await recoverSystemAdmin(app.store, { now: new Date(), sessionSecret: app.context.config.sessionSecret })
    app.clearMails()
    const jar = createJar()

    expect((await redeemInvitation(app, jar, result.kind === 'issued' ? result.token : '', 'wiederhergestellt-4711')).status).toBe(200)

    expect((await profileOf(app, jar)).secondFactor).toEqual({ state: 'setup-required' })
    expect((await verifySecondFactor(app, jar, admin.backupCodes[0] ?? '')).status).toBe(409)
    const reste = await pool.query(
      'select (select count(*)::int from user_totp_factors) as faktoren, (select count(*)::int from user_backup_codes) as codes',
    )
    expect(reste.rows[0]).toEqual({ faktoren: 0, codes: 0 })
    expect(app.mails.map((mail) => mail.subject)).toEqual(['Ihr zweiter Faktor fuer Canvaz wurde geaendert'])
    await completeSecondFactorSetup(app, jar)
    expect((await get(jar, ADMIN_USERS_PATH)).status).toBe(200)
  })

  it('haelt Geheimnis und Ersatzcodes aus Datenbank, Protokoll und Mail heraus', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const geheim = [admin.totpSecret, ...admin.backupCodes, ...admin.backupCodes.map((code) => code.replace('-', ''))]

    const zeilen = await pool.query(
      `select (select coalesce(string_agg(t::text, ' '), '') from user_totp_factors t) ||
              (select coalesce(string_agg(b::text, ' '), '') from user_backup_codes b) as inhalt`,
    )
    const inhalt = (zeilen.rows[0] as { inhalt: string }).inhalt
    const spuren = JSON.stringify(app.logs) + JSON.stringify(app.mails)
    for (const wert of geheim) {
      expect(inhalt).not.toContain(wert)
      expect(spuren).not.toContain(wert)
    }
    expect(inhalt).toMatch(/v1\./)
  })
})
