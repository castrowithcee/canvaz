/**
 * Bausteine der Anmeldung ohne IO: transienter Flow-Zustand, Session-Geheimnis, CSRF-Bindung, Cookies.
 */

import type { IncomingMessage } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CSRF_HEADER } from '../../src/contracts/api.js'
import type { AuthenticatedSession } from '../../src/domain/identity/model.js'
import { clearCookie, parseCookies, serializeCookie } from '../../src/server/cookies.js'
import { FLOW_TTL_SECONDS, openFlowState, sealFlowState } from '../../src/server/flow-state.js'
import { createSessionToken, csrfTokenFor, hasValidCsrfToken, hashSessionToken } from '../../src/server/session.js'

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

  it('setzt die Sicherheitsattribute', () => {
    const cookie = serializeCookie('canvaz_session', 'geheim', { path: '/', maxAgeSeconds: 60, secure: true })

    expect(cookie).toBe('canvaz_session=geheim; Path=/; Max-Age=60; SameSite=Lax; HttpOnly; Secure')
    expect(serializeCookie('x', 'y', { path: '/', maxAgeSeconds: 60, secure: false })).not.toContain('Secure')
    expect(clearCookie('canvaz_session', { path: '/', secure: false })).toContain('Max-Age=0')
  })
})
