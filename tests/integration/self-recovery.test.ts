/**
 * Selbstwiederherstellung per Mail gegen die echte Anwendung und eine echte Datenbank.
 *
 * Die Instanz hat einen Postausgang; die Nachrichten landen am Port (`app.mails`). Die Anfrage eines
 * Ruecksetzungslinks antwortet vor der kontoabhaengigen Arbeit - die Faelle warten deshalb auf deren
 * Protokollzeile, bevor sie Mails zaehlen.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'

import {
  ADMIN_USER_CREATE_PATH,
  ADMIN_USER_SELF_RECOVERY_PATH,
  ADMIN_USER_STATUS_PATH,
  ADMIN_USERS_PATH,
  AUTH_METHODS_PATH,
  AUTH_PASSWORD_RESET_REDEEM_PATH,
  AUTH_PASSWORD_RESET_REQUEST_PATH,
  AUTH_RECOVERY_EMAIL_CONFIRM_PATH,
  ME_RECOVERY_EMAIL_PATH,
  PASSWORD_RESET_APP_PATH,
  RECOVERY_EMAIL_CONFIRM_APP_PATH,
} from '../../src/contracts/api.js'
import type { AdminUsersResponse, AuthMethodsResponse, CreateUserResponse, SelfRecoveryView } from '../../src/contracts/api.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import type { Mail } from '../../src/server/mailer.js'
import { createJar } from '../support/browser-client.js'
import {
  TEST_PASSWORD,
  changePassword,
  localLogin,
  post,
  postWithCsrf,
  profileOf,
  signedInAsSystemAdmin,
} from '../support/local-accounts.js'
import type { Account } from '../support/local-accounts.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

const MAIL_ENV = { CANVAZ_SMTP_HOST: 'postausgang.invalid', CANVAZ_MAIL_FROM: 'canvaz@example.com' }
const EIGENES_PASSWORT = 'eigenes-passwort-4711-lang'
const NEUES_PASSWORT = 'zurueckgesetzt-0815-lang-genug'

let pool: Pool
let app: TestApp
let admin: Account

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  try {
    await pool.query('select 1')
  } catch (error) {
    throw new Error(`Keine Testdatenbank unter ${DATABASE_URL}. Zuerst "npm run db:up" ausfuehren.`, { cause: error })
  }
  await migrate(pool)
  app = await startTestApp({ pool, databaseUrl: DATABASE_URL, env: MAIL_ENV })
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces, login_throttle cascade')
  app.setNow(null)
  admin = await signedInAsSystemAdmin(app)
  app.clearMails()
  app.clearLogs()
})

/** Legt ein Konto mit Initialpasswort an und meldet es ueber den erzwungenen Wechsel an. */
async function member(email: string): Promise<Account & { readonly id: string }> {
  const created = (await (
    await postWithCsrf(app, admin.jar, ADMIN_USER_CREATE_PATH, {
      displayName: 'Ada Lovelace',
      email,
      initialPassword: TEST_PASSWORD,
    })
  ).json()) as CreateUserResponse
  const jar = createJar()
  expect((await changePassword(app, jar, { email, currentPassword: TEST_PASSWORD, newPassword: EIGENES_PASSWORT })).status).toBe(200)
  return { jar, profile: await profileOf(app, jar), id: created.user.id }
}

function allow(userId: string, allowed = true): Promise<Response> {
  return postWithCsrf(app, admin.jar, ADMIN_USER_SELF_RECOVERY_PATH, { userId, allowed })
}

/** Der Wert steht im Fragment des Links in der Nachricht. */
function tokenIn(mail: Mail | undefined, path: string): string {
  const match = new RegExp(`${path}#([A-Za-z0-9_-]+)`).exec(mail?.text ?? '')
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

async function setAddress(account: Account, email: string, currentPassword = EIGENES_PASSWORT): Promise<Response> {
  return postWithCsrf(app, account.jar, ME_RECOVERY_EMAIL_PATH, { email, currentPassword })
}

/** Adresse setzen und bestaetigen; liefert den Wert des Bestaetigungslinks. */
async function verifiedAddress(account: Account, email: string): Promise<string> {
  app.clearMails()
  expect((await setAddress(account, email)).status).toBe(200)
  const token = tokenIn(app.mails.at(-1), RECOVERY_EMAIL_CONFIRM_APP_PATH)
  expect((await post(app, createJar(), AUTH_RECOVERY_EMAIL_CONFIRM_PATH, { token })).status).toBe(200)
  app.clearMails()
  return token
}

function requestReset(email: string): Promise<Response> {
  return post(app, createJar(), AUTH_PASSWORD_RESET_REQUEST_PATH, { email })
}

function redeem(token: string, password: string): Promise<Response> {
  return post(app, createJar(), AUTH_PASSWORD_RESET_REDEEM_PATH, { token, password })
}

function logCount(event: string): number {
  return app.logs.filter((entry) => entry.event === event).length
}

describe('Freischaltung durch den Systemadmin', () => {
  it('schaltet ein Konto frei und ab, nie den Systemadmin; das Abschalten widerruft offene Links', async () => {
    const ada = await member('ada@example.com')
    // Ohne Freischaltung gibt es keine Adresse.
    expect((await setAddress(ada, 'privat@example.org')).status).toBe(403)
    expect((await profileOf(app, ada.jar)).selfRecovery).toBeNull()

    expect((await allow(ada.id)).status).toBe(200)
    expect((await allow(admin.profile.user.id)).status).toBe(400)
    const users = ((await (await admin.jar.fetch(`${app.baseUrl}${ADMIN_USERS_PATH}`)).json()) as AdminUsersResponse).users
    expect(users.find((user) => user.id === ada.id)).toMatchObject({ selfRecoveryAllowed: true, recoveryEmailVerified: false })
    expect(users.find((user) => user.id === admin.profile.user.id)?.selfRecoveryAllowed).toBe(false)

    expect((await setAddress(ada, 'privat@example.org')).status).toBe(200)
    const token = tokenIn(app.mails.at(-1), RECOVERY_EMAIL_CONFIRM_APP_PATH)
    expect((await allow(ada.id, false)).status).toBe(200)
    expect((await post(app, createJar(), AUTH_RECOVERY_EMAIL_CONFIRM_PATH, { token })).status).toBe(400)
    expect((await profileOf(app, ada.jar)).selfRecovery).toBeNull()
  })
})

describe('Wiederherstellungsadresse', () => {
  it('gilt erst nach dem Bestaetigungslink; eine Aenderung verlangt das Passwort und eine neue Bestaetigung', async () => {
    const ada = await member('ada@example.com')
    await allow(ada.id)

    expect((await setAddress(ada, 'privat@example.org')).status).toBe(200)
    expect(app.mails).toHaveLength(1)
    expect(app.mails[0]?.to).toBe('privat@example.org')
    expect((await profileOf(app, ada.jar)).selfRecovery).toEqual({ email: null, pendingEmail: 'privat@example.org' })
    const token = tokenIn(app.mails[0], RECOVERY_EMAIL_CONFIRM_APP_PATH)
    expect((await post(app, createJar(), AUTH_RECOVERY_EMAIL_CONFIRM_PATH, { token })).status).toBe(200)
    expect((await profileOf(app, ada.jar)).selfRecovery).toEqual({ email: 'privat@example.org', pendingEmail: null })
    // Genau einmal einloesbar.
    expect((await post(app, createJar(), AUTH_RECOVERY_EMAIL_CONFIRM_PATH, { token })).status).toBe(400)

    // Aenderung: ohne das richtige Passwort nichts, mit ihm eine offene Bestaetigung neben der alten Adresse.
    app.clearMails()
    expect((await setAddress(ada, 'neu@example.org', 'falsches-passwort-lang')).status).toBe(403)
    expect(app.mails).toHaveLength(0)
    const geaendert = await setAddress(ada, 'neu@example.org')
    expect((await geaendert.json()) as SelfRecoveryView).toEqual({ email: 'privat@example.org', pendingEmail: 'neu@example.org' })
    const neu = tokenIn(app.mails.at(-1), RECOVERY_EMAIL_CONFIRM_APP_PATH)
    expect((await post(app, createJar(), AUTH_RECOVERY_EMAIL_CONFIRM_PATH, { token: neu })).status).toBe(200)
    expect((await profileOf(app, ada.jar)).selfRecovery).toEqual({ email: 'neu@example.org', pendingEmail: null })
  })
})

describe('Anfrage eines Ruecksetzungslinks', () => {
  it('gibt es ohne Postausgang nicht', async () => {
    const methods = (await (await fetch(`${app.baseUrl}${AUTH_METHODS_PATH}`)).json()) as AuthMethodsResponse
    expect(methods.passwordReset).toBe(true)

    const ohne = await startTestApp({ pool, databaseUrl: DATABASE_URL })
    try {
      const ohneMethods = (await (await fetch(`${ohne.baseUrl}${AUTH_METHODS_PATH}`)).json()) as AuthMethodsResponse
      expect(ohneMethods).toEqual({ local: true, oidc: false, passwordReset: false })
      const anfrage = await post(ohne, createJar(), AUTH_PASSWORD_RESET_REQUEST_PATH, { email: 'ada@example.com' })
      expect(anfrage.status).toBe(404)
    } finally {
      await ohne.close()
    }
  })

  it('schickt einem zulaessigen Konto genau eine Mail und antwortet allen anderen gleich ohne Versand', async () => {
    const ada = await member('ada@example.com')
    await allow(ada.id)
    await verifiedAddress(ada, 'privat@example.org')

    // Die nicht zulaessigen Faelle: unbekannt, Systemadmin, nicht freigeschaltet, nicht bestaetigt,
    // deaktiviert und ohne lokales Passwort.
    await member('nicht-frei@example.com')
    const unbestaetigt = await member('unbestaetigt@example.com')
    await allow(unbestaetigt.id)
    const deaktiviert = await member('deaktiviert@example.com')
    await allow(deaktiviert.id)
    await verifiedAddress(deaktiviert, 'deaktiviert@example.org')
    await postWithCsrf(app, admin.jar, ADMIN_USER_STATUS_PATH, { userId: deaktiviert.id, status: 'deactivated' })
    await postWithCsrf(app, admin.jar, ADMIN_USER_CREATE_PATH, { displayName: 'Ohne Passwort', email: 'einladung@example.com' })
    app.clearMails()
    app.clearLogs()

    const abgelehnt = [
      'niemand@example.com',
      'root@example.com',
      'nicht-frei@example.com',
      'unbestaetigt@example.com',
      'deaktiviert@example.com',
      'einladung@example.com',
    ]
    const antworten = await Promise.all(
      abgelehnt.map(async (email) => {
        const response = await requestReset(email)
        return { status: response.status, body: await response.text() }
      }),
    )
    await vi.waitFor(() => {
      expect(logCount('auth.password-reset.skipped')).toBe(abgelehnt.length)
    })
    expect(app.mails).toHaveLength(0)

    const zulaessig = await requestReset('ada@example.com')
    expect({ status: zulaessig.status, body: await zulaessig.text() }).toEqual(antworten[0])
    for (const antwort of antworten) {
      expect(antwort).toEqual({ status: 202, body: JSON.stringify({ status: 'accepted' }) })
    }
    await vi.waitFor(() => {
      expect(app.mails).toHaveLength(1)
    })
    expect(app.mails[0]?.to).toBe('privat@example.org')
    tokenIn(app.mails[0], PASSWORD_RESET_APP_PATH)
    // Die Anfrage aendert nichts am Konto: die Sitzung lebt, das Passwort gilt.
    expect((await profileOf(app, ada.jar)).user.id).toBe(ada.id)

    // Solange ein Link offen ist, geht keine weitere Mail.
    await requestReset('ada@example.com')
    await vi.waitFor(() => {
      expect(app.logs.some((entry) => entry.fields['reason'] === 'link-open')).toBe(true)
    })
    expect(app.mails).toHaveLength(1)
  })

  it('drosselt je Adresse mit eigenem Budget, ohne die Anmeldung zu sperren', async () => {
    const eng = await startTestApp({
      pool,
      databaseUrl: DATABASE_URL,
      env: { ...MAIL_ENV, CANVAZ_AUTH_RATE_LIMIT_PER_ACCOUNT: '3' },
    })
    try {
      await member('ada@example.com')
      for (let i = 0; i < 4; i += 1) {
        expect((await post(eng, createJar(), AUTH_PASSWORD_RESET_REQUEST_PATH, { email: 'ada@example.com' })).status).toBe(202)
      }
      await vi.waitFor(() => {
        expect(eng.logs.filter((entry) => entry.event === 'auth.password-reset.throttled')).toHaveLength(1)
      })
      expect((await localLogin(eng, createJar(), 'ada@example.com', EIGENES_PASSWORT)).status).toBe(200)
    } finally {
      await eng.close()
    }
  })
})

describe('Einloesen eines Ruecksetzungslinks', () => {
  async function resetLink(): Promise<string> {
    app.clearMails()
    await requestReset('ada@example.com')
    await vi.waitFor(() => {
      expect(app.mails).toHaveLength(1)
    })
    const token = tokenIn(app.mails[0], PASSWORD_RESET_APP_PATH)
    app.clearMails()
    return token
  }

  it('setzt das Passwort genau einmal, widerruft Sitzungen und Links und meldet nicht an', async () => {
    const ada = await member('ada@example.com')
    await allow(ada.id)
    const bestaetigung = await verifiedAddress(ada, 'privat@example.org')
    const vorher = await app.store.users.findById(ada.id)
    const token = await resetLink()
    // Ein offener Bestaetigungslink, der mit der Ruecksetzung verfallen muss.
    await setAddress(ada, 'spaeter@example.org')
    const offeneBestaetigung = tokenIn(app.mails.at(-1), RECOVERY_EMAIL_CONFIRM_APP_PATH)
    app.clearMails()

    expect((await redeem('unbekannter-wert', NEUES_PASSWORT)).status).toBe(400)
    // Die Passwortregel greift, und ein abgelehntes Passwort verbraucht den Link nicht.
    expect((await redeem(token, 'Ada Lovelace')).status).toBe(400)
    expect((await redeem(token, 'ada@example.com')).status).toBe(400)

    // Gleichzeitig eingeloest gewinnt genau einer.
    const beide = await Promise.all([redeem(token, NEUES_PASSWORT), redeem(token, NEUES_PASSWORT)])
    expect(beide.map((response) => response.status).sort()).toEqual([200, 400])
    const erfolg = beide.find((response) => response.status === 200)
    expect(erfolg?.headers.getSetCookie()).toEqual([])
    expect((await redeem(token, NEUES_PASSWORT)).status).toBe(400)

    // Alte Sitzung beendet, keine neue; offene Links verfallen; Mitteilung an die bestaetigte Adresse.
    expect((await ada.jar.fetch(`${app.baseUrl}/api/me`)).status).toBe(401)
    expect((await post(app, createJar(), AUTH_RECOVERY_EMAIL_CONFIRM_PATH, { token: offeneBestaetigung })).status).toBe(400)
    expect(app.mails.map((mail) => mail.to)).toEqual(['privat@example.org'])
    expect(app.mails[0]?.text).not.toContain(NEUES_PASSWORT)
    expect((await localLogin(app, createJar(), 'ada@example.com', EIGENES_PASSWORT)).status).toBe(401)
    expect((await localLogin(app, createJar(), 'ada@example.com', NEUES_PASSWORT)).status).toBe(200)

    // Identitaet, Status und Rolle unveraendert; kein zweiter Faktor entstanden.
    const nachher = await app.store.users.findById(ada.id)
    expect({ ...nachher, updatedAt: null }).toEqual({ ...vorher, updatedAt: null })
    expect(await app.store.secondFactors.findTotp(ada.id)).toBeNull()

    // Kein Wert im Klartext in Datenbank oder Protokoll.
    const dump = JSON.stringify(
      (
        await pool.query(
          `select t.*, s.* from recovery_email_tokens t full join user_self_recovery s on s.user_id = t.user_id`,
        )
      ).rows,
    )
    for (const geheimnis of [token, bestaetigung, offeneBestaetigung, NEUES_PASSWORT]) {
      expect(dump).not.toContain(geheimnis)
      expect(JSON.stringify(app.logs)).not.toContain(geheimnis)
    }
  })

  it('verfaellt nach 15 Minuten', async () => {
    const ada = await member('ada@example.com')
    await allow(ada.id)
    await verifiedAddress(ada, 'privat@example.org')
    const token = await resetLink()

    app.setNow(new Date(Date.now() + 16 * 60_000))
    expect((await redeem(token, NEUES_PASSWORT)).status).toBe(400)
  })
})
