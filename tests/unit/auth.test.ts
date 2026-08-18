/**
 * Bausteine der Anmeldung ohne IO: transienter Flow-Zustand, Session-Geheimnis, CSRF-Bindung, Cookies.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CSRF_HEADER } from '../../src/contracts/api.js'
import type { AuthenticatedSession } from '../../src/domain/identity/model.js'
import { loadConfig } from '../../src/server/config.js'
import { clearCookie, parseCookies, serializeCookie } from '../../src/server/cookies.js'
import { FLOW_COOKIE, FLOW_TTL_SECONDS, openFlowState, sealFlowState, setFlowCookie } from '../../src/server/flow-state.js'
import {
  SESSION_COOKIE,
  createSessionToken,
  csrfTokenFor,
  hasValidCsrfToken,
  hashSessionToken,
  setSessionCookie,
} from '../../src/server/session.js'

const SECRET = 'ein-test-geheimnis-mit-mehr-als-32-zeichen'
const flow = { state: 'state-1', nonce: 'nonce-1', codeVerifier: 'verifier-1' }

afterEach(() => {
  vi.useRealTimers()
})

describe('Transienter Flow-Zustand', () => {
  it('verschluesselt und liest state, nonce und code_verifier zurueck', async () => {
    const sealed = await sealFlowState(flow, SECRET)

    expect(sealed).not.toContain('verifier-1')
    expect(await openFlowState(sealed, SECRET)).toEqual(flow)
  })

  it('weist ein manipuliertes oder fremdes Cookie zurueck', async () => {
    const sealed = await sealFlowState(flow, SECRET)

    expect(await openFlowState(`${sealed.slice(0, -2)}xy`, SECRET)).toBeNull()
    expect(await openFlowState(sealed, `${SECRET}-anders`)).toBeNull()
    expect(await openFlowState('kein-jwt', SECRET)).toBeNull()
  })

  it('laesst den Zustand nach der Frist verfallen', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    const sealed = await sealFlowState(flow, SECRET)

    vi.setSystemTime(new Date(Date.now() + (FLOW_TTL_SECONDS + 60) * 1000))

    expect(await openFlowState(sealed, SECRET)).toBeNull()
  })
})

describe('Session-Geheimnis', () => {
  it('erzeugt jedes Mal ein neues Geheimnis', () => {
    expect(createSessionToken()).not.toBe(createSessionToken())
    expect(createSessionToken().length).toBeGreaterThanOrEqual(43)
  })

  it('hasht stabil und ungleich', () => {
    const token = createSessionToken()

    expect(hashSessionToken(token)).toBe(hashSessionToken(token))
    expect(hashSessionToken(token)).not.toBe(token)
    expect(hashSessionToken(token)).not.toBe(hashSessionToken(createSessionToken()))
  })
})

describe('CSRF-Bindung', () => {
  const auth = { session: { id: 'session-1' }, user: { id: 'user-1' } } as AuthenticatedSession

  function requestWith(token?: string): IncomingMessage {
    return { headers: token === undefined ? {} : { [CSRF_HEADER]: token } } as unknown as IncomingMessage
  }

  it('haengt am Sitzungsbezug und am Serverschluessel', () => {
    expect(csrfTokenFor('session-1', SECRET)).toBe(csrfTokenFor('session-1', SECRET))
    expect(csrfTokenFor('session-2', SECRET)).not.toBe(csrfTokenFor('session-1', SECRET))
    expect(csrfTokenFor('session-1', 'anderes-geheimnis')).not.toBe(csrfTokenFor('session-1', SECRET))
  })

  it('akzeptiert nur das passende Token im vereinbarten Header', () => {
    expect(hasValidCsrfToken(requestWith(csrfTokenFor('session-1', SECRET)), auth, SECRET)).toBe(true)
    expect(hasValidCsrfToken(requestWith(), auth, SECRET)).toBe(false)
    expect(hasValidCsrfToken(requestWith('falsch'), auth, SECRET)).toBe(false)
    expect(hasValidCsrfToken(requestWith(csrfTokenFor('session-2', SECRET)), auth, SECRET)).toBe(false)
  })
})

describe('Cookies', () => {
  it('liest mehrere Cookies und ignoriert Bruchstuecke', () => {
    expect(parseCookies('a=1; b=zwei%20drei; kaputt; =leer')).toEqual({ a: '1', b: 'zwei drei' })
    expect(parseCookies(undefined)).toEqual({})
  })

  it('ignoriert einen fehlerhaft prozentkodierten Wert wie ein fehlendes Cookie', () => {
    expect(parseCookies('canvaz_session=%')).toEqual({})
    expect(parseCookies('a=1; kaputt=%E0%A4%A; b=2')).toEqual({ a: '1', b: '2' })
  })

  it('setzt die Sicherheitsattribute', () => {
    const cookie = serializeCookie('canvaz_session', 'geheim', { path: '/', maxAgeSeconds: 60, secure: true })

    expect(cookie).toBe('canvaz_session=geheim; Path=/; Max-Age=60; SameSite=Lax; HttpOnly; Secure')
    expect(serializeCookie('x', 'y', { path: '/', maxAgeSeconds: 60, secure: false })).not.toContain('Secure')
    expect(clearCookie('canvaz_session', { path: '/', secure: false })).toContain('Max-Age=0')
  })
})

describe('Cookie-Namen', () => {
  const httpsEnv = {
    CANVAZ_BASE_URL: 'https://canvaz.example.com',
    DATABASE_URL: 'postgres://canvaz:geheim@db:5432/canvaz',
    CANVAZ_SESSION_SECRET: SECRET,
    CANVAZ_OIDC_ISSUER: 'https://idp.example.com',
    CANVAZ_OIDC_CLIENT_ID: 'canvaz',
    CANVAZ_OIDC_CLIENT_SECRET: 'client-secret',
    CANVAZ_OIDC_REDIRECT_URI: 'https://canvaz.example.com/api/auth/callback',
    CANVAZ_STORAGE_FILESYSTEM_ROOT: '/srv/canvaz/assets',
  }
  const httpEnv = {
    ...httpsEnv,
    CANVAZ_BASE_URL: 'http://localhost:3000',
    CANVAZ_OIDC_REDIRECT_URI: 'http://localhost:3000/api/auth/callback',
  }

  /** Faengt die `Set-Cookie`-Zeilen einer Antwort ab, ohne einen Server zu starten. */
  function setCookiesOf(write: (response: ServerResponse) => void): readonly string[] {
    const headers = new Map<string, string | readonly string[]>()
    const response = {
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: string | readonly string[]) => headers.set(name, value),
    } as unknown as ServerResponse
    write(response)
    const value = headers.get('set-cookie') ?? []
    return Array.isArray(value) ? value : [String(value)]
  }

  it('traegt unter HTTPS den __Host--Praefix samt seiner Voraussetzungen', () => {
    const config = loadConfig(httpsEnv)

    const [session] = setCookiesOf((response) => {
      setSessionCookie(response, config, 'geheim')
    })
    const [flow] = setCookiesOf((response) => {
      setFlowCookie(response, config, 'versiegelt')
    })

    expect(session).toContain(`__Host-${SESSION_COOKIE}=geheim`)
    expect(session).toContain('Path=/')
    expect(session).toContain('Secure')
    expect(session).not.toContain('Domain=')
    expect(flow).toContain(`__Host-${FLOW_COOKIE}=versiegelt`)
    expect(flow).toContain('Secure')
  })

  it('bleibt ohne TLS beim schlichten Namen, weil der Praefix dort nicht setzbar ist', () => {
    const config = loadConfig(httpEnv)

    const [session] = setCookiesOf((response) => {
      setSessionCookie(response, config, 'geheim')
    })

    expect(session).toContain(`${SESSION_COOKIE}=geheim`)
    expect(session).not.toContain('__Host-')
  })
})
