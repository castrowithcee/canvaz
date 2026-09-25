/**
 * Lokale Benutzerverwaltung gegen die echte Anwendung und eine echte Datenbank - **ohne jede
 * OIDC-Konfiguration**.
 *
 * Die Instanz dieses Tests startet so, wie eine Installation ohne Identity Provider laeuft: der externe Weg
 * existiert nicht, und alles - Bootstrap, Anlage, Uebergabe, Anmeldung, Wechsel, Ruecksetzung,
 * Deaktivierung - laeuft ueber die echten Endpunkte mit echtem Cookie und echtem CSRF-Token. Es gibt keinen
 * verkuerzten Aufbau an den Guards vorbei.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  ADMIN_USER_CREATE_PATH,
  ADMIN_USER_INVITATION_PATH,
  ADMIN_USER_INVITATION_REVOKE_PATH,
  ADMIN_USER_PASSWORD_PATH,
  ADMIN_USER_STATUS_PATH,
  ADMIN_USERS_PATH,
  AUTH_LOCAL_LOGIN_PATH,
  AUTH_LOGIN_PATH,
  AUTH_METHODS_PATH,
  CSRF_HEADER,
  DEFAULT_APPEARANCE,
  ME_APPEARANCE_PATH,
  ME_PATH,
} from '../../src/contracts/api.js'
import type {
  AdminUsersResponse,
  AppearanceView,
  AuthMethodsResponse,
  CreateInvitationResponse,
  CreateUserResponse,
  LocalLoginResponse,
} from '../../src/contracts/api.js'
import { INVITATION_TTL_HOURS, isInvitationRedeemable } from '../../src/domain/identity/local-auth.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { bootstrapSystemAdmin } from '../../src/server/bootstrap-admin.js'
import { hashInvitationToken } from '../../src/server/invitations.js'
import { hashPassword } from '../../src/server/password.js'
import { SESSION_COOKIE } from '../../src/server/session.js'
import { createJar } from '../support/browser-client.js'
import type { Jar } from '../support/browser-client.js'
import {
  TEST_PASSWORD,
  changePassword,
  localLogin,
  post,
  profileOf,
  redeemInvitation,
  signedInAsSystemAdmin,
  tokenOfInvitationUrl,
} from '../support/local-accounts.js'
import type { Account } from '../support/local-accounts.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

const NEUES_PASSWORT = 'neues-passwort-4711'

let pool: Pool
let app: TestApp

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  try {
    await pool.query('select 1')
  } catch (error) {
    throw new Error(`Keine Testdatenbank unter ${DATABASE_URL}. Zuerst "npm run db:up" ausfuehren.`, { cause: error })
  }
  await migrate(pool)
  // Ausdruecklich ohne Provider: diese Instanz kennt ausschliesslich die lokale Anmeldung.
  app = await startTestApp({ pool, databaseUrl: DATABASE_URL })
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces, login_throttle cascade')
  app.clearLogs()
  app.setNow(null)
})

/* ---------------------------------------------------------------------------------------------------- */
/* Testhilfen                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

function adminPost(account: Account, path: string, body: unknown, options: { csrf?: boolean } = {}) {
  return account.jar.fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.csrf === false ? {} : { [CSRF_HEADER]: account.profile.csrfToken }),
    },
    body: JSON.stringify(body),
  })
}

async function createAccount(
  admin: Account,
  body: { readonly displayName: string; readonly email: string; readonly initialPassword?: string },
): Promise<CreateUserResponse> {
  const response = await adminPost(admin, ADMIN_USER_CREATE_PATH, body)
  expect(response.status).toBe(201)
  return (await response.json()) as CreateUserResponse
}

async function invite(admin: Account, userId: string): Promise<string> {
  const response = await adminPost(admin, ADMIN_USER_INVITATION_PATH, { userId })
  expect(response.status).toBe(201)
  return ((await response.json()) as CreateInvitationResponse).invitationUrl
}

function me(jar: Jar): Promise<Response> {
  return jar.fetch(`${app.baseUrl}${ME_PATH}`)
}

/** Ein angemeldetes, gewoehnliches Konto: angelegt mit Initialpasswort, Wechsel bereits vollzogen. */
async function memberAccount(admin: Account, email: string, password = NEUES_PASSWORT): Promise<Account> {
  await createAccount(admin, { displayName: email.split('@')[0] ?? email, email, initialPassword: TEST_PASSWORD })
  const jar = createJar()
  expect((await localLogin(app, jar, email, TEST_PASSWORD)).status).toBe(200)
  expect((await changePassword(app, jar, { email, currentPassword: TEST_PASSWORD, newPassword: password })).status)
    .toBe(200)
  return { jar, profile: await profileOf(app, jar) }
}

/* ---------------------------------------------------------------------------------------------------- */
/* Instanz ohne Identity Provider                                                                        */
/* ---------------------------------------------------------------------------------------------------- */

describe('Instanz ohne OIDC', () => {
  it('startet, meldet nur den lokalen Weg und kennt die OIDC-Route nicht', async () => {
    const methods = (await (await fetch(`${app.baseUrl}${AUTH_METHODS_PATH}`)).json()) as AuthMethodsResponse

    expect(methods).toEqual({ local: true, oidc: false })
    // Die Route entsteht gar nicht erst: der Aufruf faellt auf die SPA zurueck, statt einen Fluss zu
    // beginnen - es gibt keine Weiterleitung zu einem Provider.
    const einstieg = await fetch(`${app.baseUrl}${AUTH_LOGIN_PATH}`, { redirect: 'manual' })
    expect(einstieg.status).not.toBe(302)
    expect(einstieg.headers.get('location')).toBeNull()
  })
})

describe('Bootstrap des ersten Systemadmins', () => {
  it('macht den eingeloesten Bootstrap-Admin zum Systemadmin', async () => {
    const admin = await signedInAsSystemAdmin(app)

    expect(admin.profile.user.isSystemAdmin).toBe(true)
    expect(await app.store.users.count()).toBe(1)
  })

  it('legt genau einen an und verweigert danach jeden weiteren', async () => {
    await signedInAsSystemAdmin(app)

    const zweiter = await bootstrapSystemAdmin(app.store, {
      displayName: 'Zweiter',
      email: 'zweiter@example.com',
      now: new Date(),
    })

    expect(zweiter.kind).toBe('already-administered')
    expect(await app.store.users.count()).toBe(1)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Kontoanlage und Uebergabe                                                                             */
/* ---------------------------------------------------------------------------------------------------- */

describe('Kontoanlage mit Initialpasswort', () => {
  it('erzwingt den Wechsel bei der ersten Anmeldung und meldet erst danach an', async () => {
    const admin = await signedInAsSystemAdmin(app)
    await createAccount(admin, { displayName: 'Ada', email: 'ada@example.com', initialPassword: TEST_PASSWORD })
    const jar = createJar()

    const erste = await localLogin(app, jar, 'ada@example.com', TEST_PASSWORD)

    expect(erste.status).toBe(200)
    expect(((await erste.json()) as LocalLoginResponse).status).toBe('password-change-required')
    // Ausdruecklich ohne Sitzung: der Wechsel ist eine Grenze, keine Anzeige.
    expect(jar.cookies.get(SESSION_COOKIE)).toBeUndefined()
    expect((await me(jar)).status).toBe(401)

    const gewechselt = await changePassword(app, jar, {
      email: 'ada@example.com',
      currentPassword: TEST_PASSWORD,
      newPassword: NEUES_PASSWORT,
    })

    expect(gewechselt.status).toBe(200)
    expect((await me(jar)).status).toBe(200)
    // Und ab jetzt meldet das neue Passwort ohne Zwischenschritt an.
    const zweite = await localLogin(app, createJar(), 'ada@example.com', NEUES_PASSWORT)
    expect(((await zweite.json()) as LocalLoginResponse).status).toBe('ok')
  })

  it('nimmt ein zu kurzes Initialpasswort nicht an', async () => {
    const admin = await signedInAsSystemAdmin(app)

    const response = await adminPost(admin, ADMIN_USER_CREATE_PATH, {
      displayName: 'Ada',
      email: 'ada@example.com',
      initialPassword: 'kurz',
    })

    expect(response.status).toBe(400)
    expect(await app.store.users.count()).toBe(1)
  })

  it('legt kein zweites Konto zu derselben Adresse an', async () => {
    const admin = await signedInAsSystemAdmin(app)
    await createAccount(admin, { displayName: 'Ada', email: 'ada@example.com', initialPassword: TEST_PASSWORD })

    const zweites = await adminPost(admin, ADMIN_USER_CREATE_PATH, {
      displayName: 'Ada Zwei',
      // Dieselbe Adresse in anderer Schreibweise: die Normalisierung faengt sie ab.
      email: 'Ada@Example.com',
      initialPassword: TEST_PASSWORD,
    })

    expect(zweites.status).toBe(409)
    expect(await app.store.users.count()).toBe(2)
  })
})

describe('Kontoanlage mit Einladungslink', () => {
  it('gilt genau einmal', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const created = await createAccount(admin, { displayName: 'Ada', email: 'ada@example.com' })
    const token = tokenOfInvitationUrl(created.invitationUrl ?? '')

    const jar = createJar()
    const erste = await redeemInvitation(app, jar, token, NEUES_PASSWORT)
    const zweite = await redeemInvitation(app, createJar(), token, 'noch-ein-passwort-1')

    expect(erste.status).toBe(200)
    expect((await profileOf(app, jar)).user.id).toBe(created.user.id)
    expect(zweite.status).toBe(400)
  })

  it('gilt auch bei gleichzeitigem Zugriff genau einmal', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const created = await createAccount(admin, { displayName: 'Ada', email: 'ada@example.com' })
    const tokenHash = hashInvitationToken(tokenOfInvitationUrl(created.invitationUrl ?? ''))
    const jetzt = new Date()

    // Zwei Einloesungen desselben Werts, deren Transaktionen sich ueberlappen - hier ausdruecklich gesteuert
    // statt ueber zwanzig gleichzeitige Anfragen: die Hashberechnung vor der Transaktion zieht echte
    // Anfragen zeitlich so weit auseinander, dass sich der Fall nicht zuverlaessig herstellen laesst.
    // Geprueft wird derselbe Ablauf, den der Endpunkt fuehrt: aufloesen, Regel anwenden, einloesen.
    async function einloesen(store: typeof app.store): Promise<boolean> {
      const invitation = await store.invitations.findByTokenHash(tokenHash)
      if (invitation === null || !isInvitationRedeemable(invitation, jetzt)) {
        return false
      }
      return store.invitations.markRedeemed(invitation.id, jetzt)
    }

    let eingeloest!: () => void
    let freigeben!: () => void
    const hatEingeloest = new Promise<void>((resolve) => {
      eingeloest = resolve
    })
    const darfCommitten = new Promise<void>((resolve) => {
      freigeben = resolve
    })

    const erste = app.store.transaction(async (tx) => {
      const ok = await einloesen(tx)
      eingeloest()
      await darfCommitten
      return ok
    })
    await hatEingeloest

    // Die zweite beginnt, waehrend die erste noch offen ist. Ohne Zeilensperre und ohne den Guard beim
    // Einloesen wuerde sie dieselbe Zeile ein zweites Mal einloesen - und aus einem Link zwei Zugaenge machen.
    const zweite = app.store.transaction((tx) => einloesen(tx))
    await new Promise((resolve) => setTimeout(resolve, 250))
    freigeben()

    expect(await erste).toBe(true)
    expect(await zweite).toBe(false)
  })

  it('laeuft ab', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const created = await createAccount(admin, { displayName: 'Ada', email: 'ada@example.com' })
    const token = tokenOfInvitationUrl(created.invitationUrl ?? '')

    app.setNow(new Date(Date.now() + (INVITATION_TTL_HOURS + 1) * 3600 * 1000))

    expect((await redeemInvitation(app, createJar(), token, NEUES_PASSWORT)).status).toBe(400)
  })

  it('laesst sich widerrufen', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const created = await createAccount(admin, { displayName: 'Ada', email: 'ada@example.com' })
    const token = tokenOfInvitationUrl(created.invitationUrl ?? '')

    expect((await adminPost(admin, ADMIN_USER_INVITATION_REVOKE_PATH, { userId: created.user.id })).status).toBe(200)

    expect((await redeemInvitation(app, createJar(), token, NEUES_PASSWORT)).status).toBe(400)
  })

  it('ersetzt eine offene Einladung durch die neue', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const created = await createAccount(admin, { displayName: 'Ada', email: 'ada@example.com' })
    const alt = tokenOfInvitationUrl(created.invitationUrl ?? '')

    const neu = tokenOfInvitationUrl(await invite(admin, created.user.id))

    expect((await redeemInvitation(app, createJar(), alt, NEUES_PASSWORT)).status).toBe(400)
    expect((await redeemInvitation(app, createJar(), neu, NEUES_PASSWORT)).status).toBe(200)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Anmeldung, Wechsel und Ruecksetzung                                                                   */
/* ---------------------------------------------------------------------------------------------------- */

describe('Lokale Anmeldung', () => {
  it('lehnt falsches Passwort und unbekannte Adresse mit derselben Antwort ab', async () => {
    const admin = await signedInAsSystemAdmin(app)
    await memberAccount(admin, 'ada@example.com')

    const falsch = await localLogin(app, createJar(), 'ada@example.com', 'ganz-falsches-passwort')
    const unbekannt = await localLogin(app, createJar(), 'niemand@example.com', 'ganz-falsches-passwort')

    expect(falsch.status).toBe(401)
    expect(unbekannt.status).toBe(401)
    expect(await falsch.text()).toBe(await unbekannt.text())
  })

  it('weist eine fremde Herkunft ab', async () => {
    const response = await fetch(`${app.baseUrl}${AUTH_LOCAL_LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://boese.example.com' },
      body: JSON.stringify({ email: 'ada@example.com', password: TEST_PASSWORD }),
    })

    expect(response.status).toBe(403)
  })

  it('begrenzt die Zahl der Versuche je Client', async () => {
    // Eigene Instanz mit der engen Grenze des Betriebs; die uebrigen Faelle laufen ohne sie.
    const eng = await startTestApp({ pool, databaseUrl: DATABASE_URL, env: { CANVAZ_AUTH_RATE_LIMIT_PER_MINUTE: '5' } })
    try {
      const stati: number[] = []
      for (let versuch = 0; versuch < 6; versuch += 1) {
        stati.push((await localLogin(eng, createJar(), 'ada@example.com', 'falsches-passwort-x')).status)
      }

      expect(stati.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
      expect(stati[5]).toBe(429)
    } finally {
      await eng.close()
    }
  })
})

describe('Drosselung je Zielkonto', () => {
  const GRENZE = 3

  /** Eigene Instanz mit enger Kontogrenze hinter einem Proxy: `x-forwarded-for` steht fuer die Absenderadresse. */
  function engeInstanz(): Promise<TestApp> {
    return startTestApp({
      pool,
      databaseUrl: DATABASE_URL,
      env: { CANVAZ_AUTH_RATE_LIMIT_PER_ACCOUNT: String(GRENZE), CANVAZ_TRUSTED_PROXY: 'true' },
    })
  }

  function anmelden(instanz: TestApp, email: string, password: string, absender = '198.51.100.1') {
    return fetch(`${instanz.baseUrl}${AUTH_LOCAL_LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': absender },
      body: JSON.stringify({ email, password }),
    })
  }

  /** Ein Konto mit gesetztem Passwort, ohne Umweg ueber die Systemadministration. */
  async function konto(instanz: TestApp, email: string, password = NEUES_PASSWORT): Promise<string> {
    const user = await instanz.store.users.create({ displayName: email, email }, { isSystemAdmin: false })
    await instanz.store.localCredentials.set(user.id, await hashPassword(password), { mustChangePassword: false })
    return user.id
  }

  it('teilt das Budget ueber Absender, laesst andere Konten unberuehrt und behandelt unbekannte gleich', async () => {
    const eng = await engeInstanz()
    try {
      await konto(eng, 'ada@example.com')
      await konto(eng, 'bob@example.com')

      for (let versuch = 0; versuch < GRENZE; versuch += 1) {
        const absender = `198.51.100.${String(versuch + 10)}`
        expect((await anmelden(eng, 'ada@example.com', 'falsches-passwort-x', absender)).status).toBe(401)
        expect((await anmelden(eng, 'niemand@example.com', 'falsches-passwort-x', absender)).status).toBe(401)
      }

      // Gedrosselt hilft auch das richtige Passwort von einem neuen Absender nicht - und die Antwort gleicht
      // der auf eine unbekannte Adresse aufs Wort.
      const gedrosselt = await anmelden(eng, 'ada@example.com', NEUES_PASSWORT, '203.0.113.99')
      const unbekannt = await anmelden(eng, 'niemand@example.com', NEUES_PASSWORT, '203.0.113.99')
      expect(gedrosselt.status).toBe(401)
      expect(unbekannt.status).toBe(401)
      expect(await gedrosselt.text()).toBe(await unbekannt.text())
      expect((await anmelden(eng, 'bob@example.com', NEUES_PASSWORT)).status).toBe(200)
      // Die Tabelle kennt die Adresse nicht im Klartext.
      const zeilen = await pool.query("select 1 from login_throttle t where t::text like '%example.com%'")
      expect(zeilen.rowCount).toBe(0)
    } finally {
      await eng.close()
    }
  })

  it('uebersteht einen Neustart, laeuft von selbst ab und endet mit einer richtigen Anmeldung', async () => {
    const vorher = await engeInstanz()
    try {
      await konto(vorher, 'ada@example.com')
      for (let versuch = 0; versuch < GRENZE; versuch += 1) {
        await anmelden(vorher, 'ada@example.com', 'falsches-passwort-x')
      }
    } finally {
      await vorher.close()
    }

    const nachher = await engeInstanz()
    try {
      expect((await anmelden(nachher, 'ada@example.com', NEUES_PASSWORT)).status).toBe(401)

      // Kein Dauerlock: nach dem Fenster (Standard 15 Minuten) geht es von selbst weiter.
      nachher.setNow(new Date(Date.now() + 16 * 60_000))
      expect((await anmelden(nachher, 'ada@example.com', NEUES_PASSWORT)).status).toBe(200)

      // Die richtige Anmeldung setzt zurueck: ohne das waeren es hier fuenf Versuche bei einer Grenze von drei.
      await anmelden(nachher, 'ada@example.com', 'falsches-passwort-x')
      await anmelden(nachher, 'ada@example.com', 'falsches-passwort-x')
      expect((await anmelden(nachher, 'ada@example.com', NEUES_PASSWORT)).status).toBe(200)
    } finally {
      await nachher.close()
    }
  })

  it('erzwingt fuer ein Bestandspasswort unter der heutigen Regel den Wechsel', async () => {
    const altesPasswort = 'zwoelf-zeich'
    const userId = await konto(app, 'ada@example.com', altesPasswort)
    const jar = createJar()

    const anmeldung = await localLogin(app, jar, 'ada@example.com', altesPasswort)

    expect(((await anmeldung.json()) as LocalLoginResponse).status).toBe('password-change-required')
    expect(jar.cookies.get(SESSION_COOKIE)).toBeUndefined()
    expect((await app.store.localCredentials.findByUserId(userId))?.mustChangePassword).toBe(true)
    const gewechselt = await changePassword(app, jar, {
      email: 'ada@example.com',
      currentPassword: altesPasswort,
      newPassword: NEUES_PASSWORT,
    })
    expect(gewechselt.status).toBe(200)
    expect((await me(jar)).status).toBe(200)
  })
})

describe('Passwortregel an jedem Weg, der ein Passwort setzt', () => {
  it('weist gesperrte und persoenliche Passwoerter bei Wechsel, Einladung und Ruecksetzung ab', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const ada = await memberAccount(admin, 'ada@example.com')
    const created = await createAccount(admin, { displayName: 'Bob Beispielmann', email: 'bob@example.com' })
    const token = tokenOfInvitationUrl(created.invitationUrl ?? '')

    const wechsel = await changePassword(app, createJar(), {
      email: 'ada@example.com',
      currentPassword: NEUES_PASSWORT,
      newPassword: 'PasswordPassword',
    })
    const einladung = await redeemInvitation(app, createJar(), token, 'Bob Beispielmann 2026!')
    const ruecksetzung = await adminPost(admin, ADMIN_USER_PASSWORD_PATH, {
      userId: ada.profile.user.id,
      password: 'Canvaz-Passwort-2026',
    })

    expect([wechsel.status, einladung.status, ruecksetzung.status]).toEqual([400, 400, 400])
    // Ein abgewiesenes Passwort verbraucht den Link nicht.
    expect((await redeemInvitation(app, createJar(), token, NEUES_PASSWORT)).status).toBe(200)
  })
})

describe('Passwortwechsel', () => {
  it('beendet dabei jede andere Sitzung desselben Kontos', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const ada = await memberAccount(admin, 'ada@example.com')
    const zweitesGeraet = createJar()
    expect((await localLogin(app, zweitesGeraet, 'ada@example.com', NEUES_PASSWORT)).status).toBe(200)

    const gewechselt = await changePassword(app, zweitesGeraet, {
      email: 'ada@example.com',
      currentPassword: NEUES_PASSWORT,
      newPassword: 'wieder-ein-anderes-1',
    })

    expect(gewechselt.status).toBe(200)
    expect((await me(ada.jar)).status).toBe(401)
    expect((await me(zweitesGeraet)).status).toBe(200)
    expect((await localLogin(app, createJar(), 'ada@example.com', NEUES_PASSWORT)).status).toBe(401)
  })

  it('verlangt das bisherige Passwort und ein anderes neues', async () => {
    const admin = await signedInAsSystemAdmin(app)
    await memberAccount(admin, 'ada@example.com')

    const falsch = await changePassword(app, createJar(), {
      email: 'ada@example.com',
      currentPassword: 'ganz-falsches-passwort',
      newPassword: 'wieder-ein-anderes-1',
    })
    const gleich = await changePassword(app, createJar(), {
      email: 'ada@example.com',
      currentPassword: NEUES_PASSWORT,
      newPassword: NEUES_PASSWORT,
    })

    expect(falsch.status).toBe(401)
    expect(gleich.status).toBe(400)
  })
})

describe('Administrative Ruecksetzung', () => {
  it('beendet die Sitzung und erzwingt den Wechsel beim naechsten Anmelden', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const ada = await memberAccount(admin, 'ada@example.com')

    const zurueckgesetzt = await adminPost(admin, ADMIN_USER_PASSWORD_PATH, {
      userId: ada.profile.user.id,
      password: 'zurueckgesetztes-1234',
    })

    expect(zurueckgesetzt.status).toBe(200)
    expect((await me(ada.jar)).status).toBe(401)
    const erneut = await localLogin(app, createJar(), 'ada@example.com', 'zurueckgesetztes-1234')
    expect(((await erneut.json()) as LocalLoginResponse).status).toBe('password-change-required')
    expect((await localLogin(app, createJar(), 'ada@example.com', NEUES_PASSWORT)).status).toBe(401)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Grenzen                                                                                               */
/* ---------------------------------------------------------------------------------------------------- */

describe('Kontenverwaltung ist Systemadmins vorbehalten', () => {
  it('weist jede Verwaltung durch einen gewoehnlichen Nutzer ab', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const ada = await memberAccount(admin, 'ada@example.com')
    const bob = await memberAccount(admin, 'bob@example.com')

    for (const [path, body] of [
      [ADMIN_USER_CREATE_PATH, { displayName: 'Fremd', email: 'fremd@example.com' }],
      [ADMIN_USER_PASSWORD_PATH, { userId: bob.profile.user.id, password: 'uebernommen-1234' }],
      [ADMIN_USER_INVITATION_PATH, { userId: bob.profile.user.id }],
      [ADMIN_USER_INVITATION_REVOKE_PATH, { userId: bob.profile.user.id }],
    ] as const) {
      expect((await adminPost(ada, path, body)).status, path).toBe(403)
    }
    expect((await ada.jar.fetch(`${app.baseUrl}${ADMIN_USERS_PATH}`)).status).toBe(403)
    // Und nichts davon hat gewirkt: Bobs bisheriges Passwort gilt weiter.
    expect((await localLogin(app, createJar(), 'bob@example.com', NEUES_PASSWORT)).status).toBe(200)
  })

  it('verlangt fuer jede Aenderung das CSRF-Token', async () => {
    const admin = await signedInAsSystemAdmin(app)

    const response = await adminPost(
      admin,
      ADMIN_USER_CREATE_PATH,
      { displayName: 'Ada', email: 'ada@example.com' },
      { csrf: false },
    )

    expect(response.status).toBe(403)
    expect(await app.store.users.count()).toBe(1)
  })
})

describe('Deaktivierung', () => {
  it('sperrt den lokalen Weg sofort und entwertet eine offene Einladung', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const ada = await memberAccount(admin, 'ada@example.com')
    const token = tokenOfInvitationUrl(await invite(admin, ada.profile.user.id))

    const deaktiviert = await adminPost(admin, ADMIN_USER_STATUS_PATH, {
      userId: ada.profile.user.id,
      status: 'deactivated',
    })

    expect(deaktiviert.status).toBe(200)
    expect((await me(ada.jar)).status).toBe(401)
    expect((await localLogin(app, createJar(), 'ada@example.com', NEUES_PASSWORT)).status).toBe(403)
    expect((await redeemInvitation(app, createJar(), token, 'ganz-neues-passwort-1')).status).toBe(400)
  })
})

describe('Systemadministration sieht den Zugang, nie ein Geheimnis', () => {
  it('zeigt lokales Passwort und offene Einladung je Konto', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const mitPasswort = await createAccount(admin, {
      displayName: 'Ada',
      email: 'ada@example.com',
      initialPassword: TEST_PASSWORD,
    })
    const mitEinladung = await createAccount(admin, { displayName: 'Bob', email: 'bob@example.com' })

    const response = await admin.jar.fetch(`${app.baseUrl}${ADMIN_USERS_PATH}`)
    const koerper = await response.text()
    const users = (JSON.parse(koerper) as AdminUsersResponse).users

    expect(users.find((user) => user.id === mitPasswort.user.id)).toMatchObject({
      hasPassword: true,
      invitationExpiresAt: null,
    })
    expect(users.find((user) => user.id === mitEinladung.user.id)?.invitationExpiresAt).not.toBeNull()
    // Weder Hash noch Einladungswert stehen in der Liste.
    expect(koerper).not.toContain('scrypt$')
    expect(koerper).not.toContain(tokenOfInvitationUrl(mitEinladung.invitationUrl ?? ''))
  })
})

describe('Kein Klartext verlaesst den Fluss', () => {
  async function allStoredValues(): Promise<readonly string[]> {
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name <> 'schema_migrations'`,
    )
    const values: string[] = []
    for (const column of columns.rows) {
      const result = await pool.query<{ value: string | null }>(
        `select "${column.column_name}"::text as value from "${column.table_name}"`,
      )
      for (const row of result.rows) {
        if (row.value !== null) {
          values.push(row.value)
        }
      }
    }
    return values
  }

  it('schreibt weder Passwort noch Einladungswert in Antwort, Log oder Datenbank', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const created = await createAccount(admin, {
      displayName: 'Ada',
      email: 'ada@example.com',
      initialPassword: TEST_PASSWORD,
    })
    const token = tokenOfInvitationUrl(await invite(admin, created.user.id))
    const jar = createJar()
    await redeemInvitation(app, jar, token, NEUES_PASSWORT)
    await localLogin(app, createJar(), 'ada@example.com', NEUES_PASSWORT)

    const gespeichert = await allStoredValues()
    const logzeilen = JSON.stringify(app.logs)

    for (const geheimnis of [TEST_PASSWORD, NEUES_PASSWORT, token]) {
      expect(gespeichert.some((value) => value.includes(geheimnis))).toBe(false)
      expect(logzeilen).not.toContain(geheimnis)
    }
    // Gespeichert ist nur der Hash - und der sieht auch so aus.
    expect(gespeichert.some((value) => value.startsWith('scrypt$'))).toBe(true)
  })
})

describe('Erscheinungsbild', () => {
  it('gehoert allein dem eigenen Konto, gilt in jeder Sitzung und nimmt nur bekannte Werte an', async () => {
    const root = await signedInAsSystemAdmin(app)
    const ada = await memberAccount(root, 'ada@example.com')
    expect(root.profile.appearance).toEqual(DEFAULT_APPEARANCE)

    const gewaehlt: AppearanceView = { colorScheme: 'dark', accent: 'petrol' }
    const gespeichert = await adminPost(root, ME_APPEARANCE_PATH, gewaehlt)
    expect(gespeichert.status).toBe(200)
    expect(await gespeichert.json()).toEqual(gewaehlt)

    // Ein zweites Geraet desselben Kontos bekommt die Wahl mit dem Profil; ein anderes Konto nicht.
    const zweitesGeraet = createJar()
    expect((await localLogin(app, zweitesGeraet, 'root@example.com', TEST_PASSWORD)).status).toBe(200)
    expect((await profileOf(app, zweitesGeraet)).appearance).toEqual(gewaehlt)
    expect((await profileOf(app, ada.jar)).appearance).toEqual(DEFAULT_APPEARANCE)

    // Unbekannte Werte, fehlendes CSRF-Token und fehlende Sitzung aendern nichts.
    expect((await adminPost(root, ME_APPEARANCE_PATH, { colorScheme: 'dark', accent: '#ff0000' })).status).toBe(400)
    expect((await adminPost(root, ME_APPEARANCE_PATH, { colorScheme: 'sepia', accent: 'blau' })).status).toBe(400)
    expect((await adminPost(root, ME_APPEARANCE_PATH, DEFAULT_APPEARANCE, { csrf: false })).status).toBe(403)
    const anonym = await post(app, createJar(), ME_APPEARANCE_PATH, DEFAULT_APPEARANCE)
    expect(anonym.status).toBe(401)
    expect((await profileOf(app, root.jar)).appearance).toEqual(gewaehlt)
  })
})
