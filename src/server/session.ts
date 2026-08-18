/**
 * Serverseitige Sessions und CSRF-Bindung.
 *
 * Im Cookie steht ein zufaelliges Geheimnis, in der Datenbank nur dessen SHA-256-Hash. Ein Leseleck der
 * Datenbank uebernimmt damit keine Sitzung. Das CSRF-Token ist ein HMAC ueber die Session-Kennung: es ist an
 * genau diese Sitzung gebunden, braucht keinen zusaetzlichen Zustand und ist fuer eine fremde Herkunft nicht
 * lesbar, weil sie die Antwort von `/api/me` nicht auslesen darf.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { CSRF_HEADER } from '../contracts/api.js'
import type { AuthenticatedSession, SessionId, UserId } from '../domain/identity/model.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import type { AppConfig } from './config.js'
import { appendSetCookie, clearCookie, parseCookies, serializeCookie } from './cookies.js'

export const SESSION_COOKIE = 'canvaz_session'

const SESSION_TOKEN_BYTES = 32

export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function csrfTokenFor(sessionId: SessionId, sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update(`csrf:${sessionId}`).digest('base64url')
}

function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Zustandsaendernde Endpunkte verlangen das an die Session gebundene Token im eigenen Header. */
export function hasValidCsrfToken(
  request: IncomingMessage,
  auth: AuthenticatedSession,
  sessionSecret: string,
): boolean {
  const provided = request.headers[CSRF_HEADER]
  if (typeof provided !== 'string') {
    return false
  }
  return equalsConstantTime(provided, csrfTokenFor(auth.session.id, sessionSecret))
}

function cookieOptions(config: AppConfig) {
  return { path: '/', secure: config.secureCookies, sameSite: 'Lax' } as const
}

export function setSessionCookie(response: ServerResponse, config: AppConfig, token: string): void {
  appendSetCookie(
    response,
    serializeCookie(SESSION_COOKIE, token, { ...cookieOptions(config), maxAgeSeconds: config.sessionTtlSeconds }),
  )
}

export function clearSessionCookie(response: ServerResponse, config: AppConfig): void {
  appendSetCookie(response, clearCookie(SESSION_COOKIE, cookieOptions(config)))
}

export function readSessionToken(request: IncomingMessage): string | null {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
  return token === undefined || token.length === 0 ? null : token
}

/**
 * Legt eine Session an und liefert das Geheimnis fuer das Cookie. Das Geheimnis existiert nur hier und im
 * Browser; gespeichert wird ausschliesslich sein Hash.
 */
export async function startSession(
  store: IdentityStore,
  config: AppConfig,
  userId: UserId,
  now: Date,
): Promise<{ readonly token: string; readonly session: AuthenticatedSession['session'] }> {
  const token = createSessionToken()
  const session = await store.sessions.create({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now.getTime() + config.sessionTtlSeconds * 1000),
  })
  return { token, session }
}

/**
 * Einziger Weg vom Cookie zur angemeldeten Sitzung. Die Gueltigkeitsregel selbst steht in der Domain
 * (`authenticate`) und wird vom Repository angewandt; hier kommt nur der Transport dazu.
 */
export async function resolveSession(
  store: IdentityStore,
  request: IncomingMessage,
  now: Date,
): Promise<AuthenticatedSession | null> {
  const token = readSessionToken(request)
  if (token === null) {
    return null
  }
  return store.sessions.findAuthenticatedByTokenHash(hashSessionToken(token), now)
}
