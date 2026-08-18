/**
 * Transienter Zustand des Anmeldeflusses.
 *
 * `state`, `nonce` und `code_verifier` muessen den Redirect zum Provider ueberleben. Gewaehlt ist ein
 * kurzlebiges, verschluesseltes HttpOnly-Cookie statt einer Tabelle: der Zustand gehoert genau einem
 * Browser, lebt zehn Minuten und braucht weder Migration noch Aufraeumjob - abgelaufene Cookies verfallen
 * von selbst, und die Ablaufpruefung liegt zusaetzlich serverseitig im `exp`-Claim.
 *
 * Einmalverwendung: der Callback loescht das Cookie, bevor er den Code einloest. Ein zweiter Aufruf findet
 * keinen Zustand mehr, und ein wiederverwendeter `state` aus einem anderen Fluss passt nicht zum Cookie.
 *
 * Verschluesselt wird mit `jose` (A256GCM, direkter Schluessel), abgeleitet aus dem Session-Geheimnis ueber
 * HKDF. Eigene Kryptografie kommt hier nicht zum Einsatz.
 */

import { hkdfSync } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { EncryptJWT, jwtDecrypt } from 'jose'

import type { AppConfig } from './config.js'
import { appendSetCookie, clearCookie, parseCookies, serializeCookie } from './cookies.js'

export const FLOW_COOKIE = 'canvaz_oidc_flow'

/** Zehn Minuten reichen fuer eine Anmeldung samt Zwei-Faktor-Schritt und begrenzen das Replay-Fenster. */
export const FLOW_TTL_SECONDS = 600

const ENCRYPTION = 'A256GCM'
const AUDIENCE = 'canvaz:oidc-flow'

export type FlowState = {
  readonly state: string
  readonly nonce: string
  readonly codeVerifier: string
}

function flowKey(sessionSecret: string): Uint8Array {
  // Eigener abgeleiteter Schluessel: das Session-Geheimnis wird nie unmittelbar als Schluessel verwendet.
  return new Uint8Array(hkdfSync('sha256', sessionSecret, 'canvaz-oidc-flow', 'aes-256-gcm', 32))
}

export async function sealFlowState(state: FlowState, sessionSecret: string): Promise<string> {
  return new EncryptJWT({ ...state })
    .setProtectedHeader({ alg: 'dir', enc: ENCRYPTION })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${String(FLOW_TTL_SECONDS)}s`)
    .encrypt(flowKey(sessionSecret))
}

/** `null` bedeutet: fehlend, abgelaufen, fremd verschluesselt oder manipuliert - in allen Faellen ungueltig. */
export async function openFlowState(sealed: string, sessionSecret: string): Promise<FlowState | null> {
  try {
    const { payload } = await jwtDecrypt(sealed, flowKey(sessionSecret), { audience: AUDIENCE })
    const { state, nonce, codeVerifier } = payload as Record<string, unknown>
    if (typeof state !== 'string' || typeof nonce !== 'string' || typeof codeVerifier !== 'string') {
      return null
    }
    return { state, nonce, codeVerifier }
  } catch {
    return null
  }
}

function flowCookieOptions(config: AppConfig) {
  return { path: '/', secure: config.secureCookies, sameSite: 'Lax' } as const
}

export function setFlowCookie(response: ServerResponse, config: AppConfig, sealed: string): void {
  appendSetCookie(
    response,
    serializeCookie(FLOW_COOKIE, sealed, { ...flowCookieOptions(config), maxAgeSeconds: FLOW_TTL_SECONDS }),
  )
}

export function readFlowCookie(request: IncomingMessage): string | null {
  const value = parseCookies(request.headers.cookie)[FLOW_COOKIE]
  return value === undefined || value.length === 0 ? null : value
}

export function clearFlowCookie(response: ServerResponse, config: AppConfig): void {
  appendSetCookie(response, clearCookie(FLOW_COOKIE, flowCookieOptions(config)))
}
