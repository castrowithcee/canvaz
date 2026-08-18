/**
 * Anmeldung von Ende zu Ende gegen einen echten OIDC-Provider und eine echte Datenbank.
 *
 * Der Test-Provider signiert mit RSA und veroeffentlicht ein echtes JWKS; die Anwendung durchlaeuft
 * Discovery, PKCE, State-, Nonce- und Signaturpruefung ohne jede Abkuerzung. Alle Ablehnungen entstehen
 * dadurch, dass der Provider sich falsch verhaelt - nicht dadurch, dass Produktionscode umgangen wird.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { WebSocket } from 'ws'

import {
  ADMIN_USER_STATUS_PATH,
  ADMIN_USERS_PATH,
  AUTH_LOGOUT_PATH,
  CSRF_HEADER,
  ME_PATH,
  REALTIME_PATH,
} from '../../src/contracts/api.js'
import type { AdminUsersResponse, LogoutResponse, MeResponse } from '../../src/contracts/api.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { SESSION_COOKIE } from '../../src/server/session.js'
import { FLOW_COOKIE } from '../../src/server/flow-state.js'
import { SESSION_REVOKED_CLOSE_CODE } from '../../src/server/realtime.js'
import { createJar } from '../support/browser-client.js'
import type { Jar } from '../support/browser-client.js'
import { decideAtProvider, finishLogin, login, startLogin } from '../support/login-flow.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

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

beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
  provider.resetBehaviour()
  app.clearLogs()
  app.setNow(null)
})

async function me(jar: Jar): Promise<Response> {
  return jar.fetch(`${app.baseUrl}${ME_PATH}`)
}

async function signedInAs(subject: string, options: { name?: string; email?: string } = {}) {
  const jar = createJar()
  const result = await login(app, jar, { subject, ...options })
  expect(result.error).toBeNull()
  const response = await me(jar)
  expect(response.status).toBe(200)
  return { jar, profile: (await response.json()) as MeResponse }
}

function realtimeUrl(): string {
  return `${app.baseUrl.replace('http:', 'ws:')}${REALTIME_PATH}`
}

type RealtimeConnection = {
  readonly socket: WebSocket
  /** Nachrichten werden ab dem Verbindungsaufbau gesammelt, damit keine verloren geht. */
  next(): Promise<string>
}

function connectRealtime(jar: Jar, headers: Readonly<Record<string, string>> = {}): Promise<RealtimeConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(realtimeUrl(), { headers: { cookie: jar.cookieHeader(), ...headers } })
    const received: string[] = []
    let waiting: ((message: string) => void) | null = null
    socket.on('message', (data: Buffer) => {
      const message = data.toString('utf8')
      if (waiting === null) {
        received.push(message)
        return
      }
      const resolveWaiting = waiting
      waiting = null
      resolveWaiting(message)
    })
    socket.once('open', () => {
      resolve({
        socket,
        next: () =>
          new Promise<string>((resolveNext) => {
            const buffered = received.shift()
            if (buffered !== undefined) {
              resolveNext(buffered)
              return
            }
            waiting = resolveNext
          }),
      })
    })
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`upgrade-abgelehnt:${String(response.statusCode)}`))
    })
    socket.once('error', reject)
  })
}

describe('Anmeldung', () => {
  it('meldet den ersten Nutzer an, provisioniert ihn und macht ihn zum Systemadmin', async () => {
    const jar = createJar()

    const result = await login(app, jar, { subject: 'ada', email: 'ada@example.com', name: 'Ada L.' })

    expect(result.error).toBeNull()
    expect(jar.cookies.get(SESSION_COOKIE)).toBeTruthy()
    const profile = (await (await me(jar)).json()) as MeResponse
    expect(profile.user.displayName).toBe('Ada L.')
    expect(profile.user.email).toBe('ada@example.com')
    expect(profile.user.isSystemAdmin).toBe(true)
    expect(profile.csrfToken).toBeTruthy()
    expect(await app.store.users.count()).toBe(1)
  })

  it('setzt das Session-Cookie als HttpOnly mit SameSite=Lax und ohne Secure ohne TLS', async () => {
    const jar = createJar()
    const authorizationUrl = await startLogin(app, jar)
    const callbackUrl = await decideAtProvider(jar, authorizationUrl, { subject: 'ada' })

    const response = await jar.fetch(callbackUrl)

    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).toMatch(/Path=\//)
    expect(cookie).not.toMatch(/Secure/)
  })

  it('legt beim zweiten Besuch derselben Identitaet kein zweites Profil an und frischt das Profil auf', async () => {
    await signedInAs('ada', { name: 'Ada' })

    const zweite = await signedInAs('ada', { name: 'Ada Lovelace' })

    expect(await app.store.users.count()).toBe(1)
    expect(zweite.profile.user.displayName).toBe('Ada Lovelace')
  })

  it('macht nur den ersten Nutzer zum Systemadmin', async () => {
    await signedInAs('ada')

    const bob = await signedInAs('bob')

    expect(bob.profile.user.isSystemAdmin).toBe(false)
    expect(await app.store.users.count()).toBe(2)
  })

  it('macht bei gleichzeitigen Erstanmeldungen genau einen Systemadmin', async () => {
    const subjekte = ['a', 'b', 'c', 'd', 'e']

    const ergebnisse = await Promise.all(subjekte.map((subject) => login(app, createJar(), { subject })))

    for (const ergebnis of ergebnisse) {
      expect(ergebnis.error).toBeNull()
    }
    const users = await app.store.users.list()
    expect(users).toHaveLength(subjekte.length)
    expect(users.filter((user) => user.isSystemAdmin)).toHaveLength(1)
  })

  it('loest gleichzeitige Erstanmeldungen desselben Subjects als Konflikt auf, nicht als Fehler', async () => {
    const versuche = [1, 2, 3].map(() => login(app, createJar(), { subject: 'ada', email: 'ada@example.com' }))

    const ergebnisse = await Promise.all(versuche)

    for (const ergebnis of ergebnisse) {
      expect(ergebnis.error).toBeNull()
    }
    expect(await app.store.users.count()).toBe(1)
    expect(app.logs.filter((entry) => entry.level === 'error')).toEqual([])
  })

  it('verwirft den Flow-Zustand nach einmaliger Verwendung', async () => {
    const jar = createJar()
    const authorizationUrl = await startLogin(app, jar)
    expect(jar.cookies.get(FLOW_COOKIE)).toBeTruthy()
    const callbackUrl = await decideAtProvider(jar, authorizationUrl, { subject: 'ada' })

    await finishLogin(jar, callbackUrl)

    expect(jar.cookies.get(FLOW_COOKIE)).toBeUndefined()
  })
})

describe('Abgelehnte Anmeldungen', () => {
  async function expectRejected(expected: string, prepare?: () => void, decision: 'approve' | 'deny' = 'approve') {
    prepare?.()
    const jar = createJar()
    const result = await login(app, jar, { subject: 'ada' }, decision)
    expect(result.error).toBe(expected)
    expect(jar.cookies.get(SESSION_COOKIE)).toBeUndefined()
    expect(await app.store.users.count()).toBe(0)
    return jar
  }

  it('meldet einen Abbruch beim Provider', async () => {
    await expectRejected('abgebrochen', undefined, 'deny')
  })

  it('weist ein ID-Token mit falschem Issuer zurueck', async () => {
    await expectRejected('ungueltige-antwort', () => {
      provider.setBehaviour({ issuerOverride: 'https://boeser-issuer.example.com' })
    })
  })

  it('weist ein ID-Token mit falscher Audience zurueck', async () => {
    await expectRejected('ungueltige-antwort', () => {
      provider.setBehaviour({ audienceOverride: 'fremder-client' })
    })
  })

  it('weist ein abgelaufenes ID-Token zurueck', async () => {
    await expectRejected('ungueltige-antwort', () => {
      provider.setBehaviour({ expiredIdToken: true })
    })
  })

  it('weist ein ID-Token mit falscher Nonce zurueck', async () => {
    await expectRejected('ungueltige-antwort', () => {
      provider.setBehaviour({ nonceOverride: 'fremde-nonce' })
    })
  })

  it('meldet einen abgelaufenen oder verbrauchten Autorisierungscode', async () => {
    await expectRejected('code-ungueltig', () => {
      provider.setBehaviour({ tokenEndpointInvalidGrant: true })
    })
  })

  it('meldet einen nicht erreichbaren Provider', async () => {
    await expectRejected('provider-fehler', () => {
      provider.setBehaviour({ tokenEndpointOffline: true })
    })
  })

  it('lehnt einen Callback ohne Flow-Zustand ab', async () => {
    const jar = createJar()
    const authorizationUrl = await startLogin(app, jar)
    const callbackUrl = await decideAtProvider(jar, authorizationUrl, { subject: 'ada' })
    jar.cookies.delete(FLOW_COOKIE)

    const target = await finishLogin(jar, callbackUrl)

    expect(target.searchParams.get('login_error')).toBe('flow-abgelaufen')
    expect(await app.store.users.count()).toBe(0)
  })

  it('behandelt ein fehlerhaft prozentkodiertes Flow-Cookie wie ein fehlendes', async () => {
    const jar = createJar()
    const authorizationUrl = await startLogin(app, jar)
    const callbackUrl = await decideAtProvider(jar, authorizationUrl, { subject: 'ada' })

    const response = await fetch(callbackUrl, {
      headers: { cookie: `${FLOW_COOKIE}=%` },
      redirect: 'manual',
    })

    expect(response.status).toBe(302)
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('login_error')).toBe('flow-abgelaufen')
    expect(await app.store.users.count()).toBe(0)
  })

  it('lehnt einen fremden State ab, auch mit gueltigem Flow-Zustand', async () => {
    const opfer = createJar()
    await startLogin(app, opfer)
    const flowCookie = opfer.cookies.get(FLOW_COOKIE)
    const angreifer = createJar()
    const authorizationUrl = await startLogin(app, angreifer)
    const callbackUrl = await decideAtProvider(angreifer, authorizationUrl, { subject: 'mallory' })

    // Der Callback des zweiten Flusses wird mit dem Flow-Zustand des ersten vorgelegt.
    const jar = createJar()
    jar.set(FLOW_COOKIE, flowCookie ?? '')
    const target = await finishLogin(jar, callbackUrl)

    expect(target.searchParams.get('login_error')).toBe('ungueltige-antwort')
    expect(await app.store.users.count()).toBe(0)
  })

  it('lehnt einen zweimal eingeloesten Autorisierungscode ab', async () => {
    const jar = createJar()
    const authorizationUrl = await startLogin(app, jar)
    const callbackUrl = await decideAtProvider(jar, authorizationUrl, { subject: 'ada' })
    await finishLogin(jar, callbackUrl)

    // Ein zweiter Anlauf mit demselben Code und frischem Flow-Zustand scheitert am Provider.
    const zweiter = createJar()
    await startLogin(app, zweiter)
    const target = await finishLogin(zweiter, callbackUrl)

    expect(target.searchParams.get('login_error')).toBe('ungueltige-antwort')
    expect(await app.store.users.count()).toBe(1)
  })
})

describe('Guard und Session', () => {
  it('verweigert /api/me ohne Cookie', async () => {
    expect((await me(createJar())).status).toBe(401)
  })

  it('verweigert ein erfundenes Session-Cookie', async () => {
    const jar = createJar()
    jar.set(SESSION_COOKIE, 'frei-erfunden-aber-lang-genug-aussehend')

    expect((await me(jar)).status).toBe(401)
  })

  it('behandelt ein fehlerhaft prozentkodiertes Session-Cookie wie ein fehlendes', async () => {
    const kaputt = { cookie: `${SESSION_COOKIE}=%` }

    const profil = await fetch(`${app.baseUrl}${ME_PATH}`, { headers: kaputt })
    const abmeldung = await fetch(`${app.baseUrl}${AUTH_LOGOUT_PATH}`, { method: 'POST', headers: kaputt })
    const verwaltung = await fetch(`${app.baseUrl}${ADMIN_USERS_PATH}`, { headers: kaputt })

    expect(profil.status).toBe(401)
    expect(abmeldung.status).toBe(401)
    expect(verwaltung.status).toBe(401)
  })

  it('verweigert ein manipuliertes Session-Cookie', async () => {
    const { jar } = await signedInAs('ada')
    const token = jar.cookies.get(SESSION_COOKIE) ?? ''
    jar.set(SESSION_COOKIE, `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)

    expect((await me(jar)).status).toBe(401)
  })

  it('verweigert eine abgelaufene Session', async () => {
    const { jar } = await signedInAs('ada')

    app.setNow(new Date(Date.now() + 13 * 3600 * 1000))

    expect((await me(jar)).status).toBe(401)
  })

  it('beendet die Sitzung beim Logout und loescht das Cookie', async () => {
    const { jar, profile } = await signedInAs('ada')

    const response = await jar.fetch(`${app.baseUrl}${AUTH_LOGOUT_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: profile.csrfToken },
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as LogoutResponse).endSessionUrl).toContain('/logout')
    expect(jar.cookies.get(SESSION_COOKIE)).toBeUndefined()
  })

  it('haelt eine widerrufene Sitzung auch mit wiederhergestelltem Cookie ungueltig', async () => {
    const { jar, profile } = await signedInAs('ada')
    const token = jar.cookies.get(SESSION_COOKIE) ?? ''
    await jar.fetch(`${app.baseUrl}${AUTH_LOGOUT_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: profile.csrfToken },
    })

    jar.set(SESSION_COOKIE, token)

    expect((await me(jar)).status).toBe(401)
  })

  it('lehnt zustandsaendernde Anfragen ohne CSRF-Token ab und laesst die Sitzung bestehen', async () => {
    const { jar } = await signedInAs('ada')

    const ohneToken = await jar.fetch(`${app.baseUrl}${AUTH_LOGOUT_PATH}`, { method: 'POST' })
    const mitFalschemToken = await jar.fetch(`${app.baseUrl}${AUTH_LOGOUT_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: 'falsch' },
    })

    expect(ohneToken.status).toBe(403)
    expect(mitFalschemToken.status).toBe(403)
    expect((await me(jar)).status).toBe(200)
  })

  it('bindet das CSRF-Token an die Sitzung', async () => {
    const admin = await signedInAs('ada')
    const bob = await signedInAs('bob')

    const response = await bob.jar.fetch(`${app.baseUrl}${AUTH_LOGOUT_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: admin.profile.csrfToken },
    })

    expect(response.status).toBe(403)
  })
})

describe('Systemadministration', () => {
  it('listet Nutzer nur fuer Systemadmins', async () => {
    const admin = await signedInAs('ada')
    const bob = await signedInAs('bob')

    const alsAdmin = await admin.jar.fetch(`${app.baseUrl}${ADMIN_USERS_PATH}`)
    const alsNutzer = await bob.jar.fetch(`${app.baseUrl}${ADMIN_USERS_PATH}`)

    expect(alsAdmin.status).toBe(200)
    expect(((await alsAdmin.json()) as AdminUsersResponse).users).toHaveLength(2)
    expect(alsNutzer.status).toBe(403)
  })

  it('verweigert die Statusaenderung ohne Systemadminrolle', async () => {
    const admin = await signedInAs('ada')
    const bob = await signedInAs('bob')

    const response = await bob.jar.fetch(`${app.baseUrl}${ADMIN_USER_STATUS_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: bob.profile.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: admin.profile.user.id, status: 'deactivated' }),
    })

    expect(response.status).toBe(403)
    expect((await admin.jar.fetch(`${app.baseUrl}${ME_PATH}`)).status).toBe(200)
  })

  it('verweigert die Statusaenderung ohne CSRF-Token', async () => {
    const admin = await signedInAs('ada')
    const bob = await signedInAs('bob')

    const response = await admin.jar.fetch(`${app.baseUrl}${ADMIN_USER_STATUS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: bob.profile.user.id, status: 'deactivated' }),
    })

    expect(response.status).toBe(403)
  })

  it('laesst einen Systemadmin sich nicht selbst deaktivieren', async () => {
    const admin = await signedInAs('ada')

    const response = await admin.jar.fetch(`${app.baseUrl}${ADMIN_USER_STATUS_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: admin.profile.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: admin.profile.user.id, status: 'deactivated' }),
    })

    expect(response.status).toBe(400)
    expect((await admin.jar.fetch(`${app.baseUrl}${ME_PATH}`)).status).toBe(200)
  })

  it('beendet mit der Deaktivierung sofort alle Sitzungen und verhindert eine neue Anmeldung', async () => {
    const admin = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const zweitesGeraet = await signedInAs('bob')

    const response = await admin.jar.fetch(`${app.baseUrl}${ADMIN_USER_STATUS_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: admin.profile.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: bob.profile.user.id, status: 'deactivated' }),
    })

    expect(response.status).toBe(200)
    expect((await me(bob.jar)).status).toBe(401)
    expect((await me(zweitesGeraet.jar)).status).toBe(401)
    const erneut = await login(app, createJar(), { subject: 'bob' })
    expect(erneut.error).toBe('nutzer-deaktiviert')
  })

  it('laesst einen deaktivierten Nutzer nach der Reaktivierung wieder anmelden', async () => {
    const admin = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const change = (status: string) =>
      admin.jar.fetch(`${app.baseUrl}${ADMIN_USER_STATUS_PATH}`, {
        method: 'POST',
        headers: { [CSRF_HEADER]: admin.profile.csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ userId: bob.profile.user.id, status }),
      })

    await change('deactivated')
    await change('active')

    const erneut = await login(app, createJar(), { subject: 'bob' })
    expect(erneut.error).toBeNull()
  })
})

describe('WebSocket-Einstieg', () => {
  it('nimmt einen authentifizierten Upgrade an', async () => {
    const { jar, profile } = await signedInAs('ada')

    const connection = await connectRealtime(jar)
    const message = await connection.next()

    expect(JSON.parse(message)).toEqual({ type: 'ready', userId: profile.user.id })
    connection.socket.close()
  })

  it('weist einen Upgrade ohne Sitzung ab', async () => {
    await expect(connectRealtime(createJar())).rejects.toThrow('upgrade-abgelehnt:401')
  })

  it('weist einen Upgrade mit fehlerhaft prozentkodiertem Cookie ab', async () => {
    await expect(connectRealtime(createJar(), { cookie: `${SESSION_COOKIE}=%` })).rejects.toThrow(
      'upgrade-abgelehnt:401',
    )
  })

  it('weist einen Upgrade mit fremder Herkunft ab', async () => {
    const { jar } = await signedInAs('ada')

    await expect(connectRealtime(jar, { origin: 'http://boese.example.com' })).rejects.toThrow('upgrade-abgelehnt:403')
  })

  it('nimmt einen Upgrade mit der eigenen Herkunft an', async () => {
    const { jar, profile } = await signedInAs('ada')

    const connection = await connectRealtime(jar, { origin: app.baseUrl })

    expect(JSON.parse(await connection.next())).toEqual({ type: 'ready', userId: profile.user.id })
    connection.socket.close()
  })

  it('schliesst eine offene Verbindung, sobald die Sitzung ablaeuft', async () => {
    const { jar } = await signedInAs('ada')
    const connection = await connectRealtime(jar)
    await connection.next()
    const closed = new Promise<number>((resolve) => connection.socket.once('close', resolve))

    app.setNow(new Date(Date.now() + 13 * 3600 * 1000))

    expect(await closed).toBe(SESSION_REVOKED_CLOSE_CODE)
  })

  it('weist einen Upgrade nach dem Logout ab', async () => {
    const { jar, profile } = await signedInAs('ada')
    const token = jar.cookies.get(SESSION_COOKIE) ?? ''
    await jar.fetch(`${app.baseUrl}${AUTH_LOGOUT_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: profile.csrfToken },
    })
    jar.set(SESSION_COOKIE, token)

    await expect(connectRealtime(jar)).rejects.toThrow('upgrade-abgelehnt:401')
  })

  it('schliesst offene Verbindungen beim Logout', async () => {
    const { jar, profile } = await signedInAs('ada')
    const connection = await connectRealtime(jar)
    await connection.next()
    const closed = new Promise<number>((resolve) => connection.socket.once('close', resolve))

    await jar.fetch(`${app.baseUrl}${AUTH_LOGOUT_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: profile.csrfToken },
    })

    expect(await closed).toBe(SESSION_REVOKED_CLOSE_CODE)
  })

  it('schliesst offene Verbindungen bei der Deaktivierung und laesst keine neue zu', async () => {
    const admin = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const connection = await connectRealtime(bob.jar)
    await connection.next()
    const closed = new Promise<number>((resolve) => connection.socket.once('close', resolve))

    await admin.jar.fetch(`${app.baseUrl}${ADMIN_USER_STATUS_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: admin.profile.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: bob.profile.user.id, status: 'deactivated' }),
    })

    expect(await closed).toBe(SESSION_REVOKED_CLOSE_CODE)
    await expect(connectRealtime(bob.jar)).rejects.toThrow('upgrade-abgelehnt:401')
  })
})

describe('Sicherheitsheader', () => {
  it('setzt CSP, nosniff und Referrer-Policy auf API-, Fehler- und Weiterleitungsantworten', async () => {
    const antworten = [
      await fetch(`${app.baseUrl}${ME_PATH}`),
      await fetch(`${app.baseUrl}/api/health`),
      await fetch(`${app.baseUrl}/api/auth/login`, { redirect: 'manual' }),
    ]

    for (const response of antworten) {
      const csp = response.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("base-uri 'self'")
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      // HSTS gehoert zur TLS-Terminierung, nicht in die Anwendung.
      expect(response.headers.get('strict-transport-security')).toBeNull()
    }
  })
})

describe('Kein Tokenmaterial verlaesst den Fluss', () => {
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

  it('speichert weder ID- noch Access-Token in der Datenbank und protokolliert sie nicht', async () => {
    await signedInAs('ada')

    const tokens = provider.issuedTokens
    expect(tokens.length).toBeGreaterThan(0)
    const stored = await allStoredValues()
    const logLine = JSON.stringify(app.logs)

    for (const token of tokens) {
      expect(stored.some((value) => value.includes(token))).toBe(false)
      expect(logLine).not.toContain(token)
    }
    // Zusaetzlich generisch: nichts in der Datenbank sieht aus wie ein JWT oder ein Access-Token.
    expect(stored.some((value) => /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value))).toBe(false)
    expect(stored.some((value) => value.startsWith('access-'))).toBe(false)
    expect(logLine).not.toMatch(/ey[A-Za-z0-9_-]{10,}\./)
  })
})
