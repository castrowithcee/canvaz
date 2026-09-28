/**
 * Gastsessions und Freigabetokens.
 *
 * Dieselbe Bauweise wie `session.ts` und mit Absicht keine Abkuerzung davon: im Cookie steht ein
 * zufaelliges Geheimnis, in der Datenbank nur dessen SHA-256-Hash, und das CSRF-Token ist ein HMAC ueber
 * die Kennung der Gastsession.
 *
 * Drei Dinge trennen einen Gast trotzdem sauber von einer internen Sitzung:
 *
 * 1. **Ein eigener Cookiename.** Ein Gastzugang darf eine angemeldete Sitzung im selben Browser weder
 *    ueberschreiben noch ersetzen; beide koennen nebeneinander bestehen.
 * 2. **Eine eigene CSRF-Marke.** Der HMAC traegt das Praefix `csrf:guest:`, sodass das Token einer internen
 *    Sitzung eine Gastanfrage nie legitimieren kann und umgekehrt - selbst wenn beide Kennungen kollidierten.
 * 3. **Eine kurze Lebensdauer**, zusaetzlich gedeckelt durch den Ablauf des Links (`guestSessionExpiry`).
 *
 * Das **Freigabetoken** selbst hat mit dem Cookie nichts zu tun: es wird einmal ausgegeben, vom Empfaenger
 * gegen eine Gastsession eingetauscht und danach nie wieder gebraucht. Es steht in keinem Cookie, in keiner
 * URL, die den Server erreicht, und in keinem Protokoll.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { CSRF_HEADER } from '../contracts/api.js'
import type { AuthenticatedGuest, GuestSessionId } from '../domain/board/guest.js'
import { GUEST_SESSION_TTL_SECONDS } from '../domain/board/guest.js'
import type { BoardStore } from '../domain/board/repositories.js'
import type { AppConfig } from './config.js'
import { appendSetCookie, clearCookie, parseCookies, serializeCookie } from './cookies.js'
import { hashSessionToken } from './session.js'

export const GUEST_COOKIE = 'canvaz_guest'

/** Wie beim Sitzungscookie: unter HTTPS traegt es den `__Host-`-Praefix und ist damit domaingebunden. */
export function guestCookieName(config: Pick<AppConfig, 'secureCookies'>): string {
  return config.secureCookies ? `__Host-${GUEST_COOKIE}` : GUEST_COOKIE
}

/**
 * 32 zufaellige Bytes, base64url kodiert - genau wie das Sitzungsgeheimnis.
 *
 * 256 Bit sind gegen Raten nicht zu ueberwinden und brauchen deshalb keine zusaetzliche Ratenbremse: der
 * Suchraum ist groesser als jede Zahl von Versuchen, die eine Instanz je beantworten koennte. Kuerzer waere
 * ein Link, den man sich merken kann, und genau das soll er nicht sein.
 */
const TOKEN_BYTES = 32

export function createShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

export function createGuestSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** Dasselbe Verfahren wie beim Sitzungsgeheimnis: gespeichert wird ausschliesslich der Hash. */
export function hashGuestToken(token: string): string {
  return hashSessionToken(token)
}

export function guestCsrfTokenFor(guestSessionId: GuestSessionId, sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update(`csrf:guest:${guestSessionId}`).digest('base64url')
}

function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function hasValidGuestCsrfToken(
  request: IncomingMessage,
  guest: AuthenticatedGuest,
  sessionSecret: string,
): boolean {
  const provided = request.headers[CSRF_HEADER]
  if (typeof provided !== 'string') {
    return false
  }
  return equalsConstantTime(provided, guestCsrfTokenFor(guest.session.id, sessionSecret))
}

function cookieOptions(config: AppConfig) {
  return { path: '/', secure: config.secureCookies, sameSite: 'Lax' } as const
}

/**
 * `SameSite=Lax` wie bei der internen Sitzung: der Gast kommt ueber einen Link aus einer Nachricht oder
 * einer Mail, also ueber eine fremde Top-Level-Navigation. Mit `Strict` waere er nach genau diesem Klick
 * scheinbar nicht mehr eingetreten. Der CSRF-Header deckt den Rest ab.
 *
 * Die Lebensdauer des Cookies ist die der Gastsession; sie ist bereits am Ablauf des Links gedeckelt.
 */
export function setGuestCookie(response: ServerResponse, config: AppConfig, token: string, expiresAt: Date): void {
  const maxAgeSeconds = Math.max(
    0,
    Math.min(GUEST_SESSION_TTL_SECONDS, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  )
  appendSetCookie(
    response,
    serializeCookie(guestCookieName(config), token, { ...cookieOptions(config), maxAgeSeconds }),
  )
}

export function clearGuestCookie(response: ServerResponse, config: AppConfig): void {
  appendSetCookie(response, clearCookie(guestCookieName(config), cookieOptions(config)))
}

export function readGuestToken(request: IncomingMessage, config: Pick<AppConfig, 'secureCookies'>): string | null {
  const token = parseCookies(request.headers.cookie)[guestCookieName(config)]
  return token === undefined || token.length === 0 ? null : token
}

/**
 * Einziger Weg vom Gastcookie zur gueltigen Gastsession.
 *
 * Die Gueltigkeitsregel liegt in der Abfrage des Repositories und deckt **beide** Seiten ab: die Gastsession
 * und den Link dahinter. Ablauf und Widerruf wirken damit sofort, ohne Aufraeumlauf und ohne dass irgendwo
 * ein aufgeloester Zugriff zwischengespeichert waere.
 */
export async function resolveGuestSession(
  store: BoardStore,
  config: Pick<AppConfig, 'secureCookies'>,
  request: IncomingMessage,
  now: Date,
): Promise<AuthenticatedGuest | null> {
  const token = readGuestToken(request, config)
  if (token === null) {
    return null
  }
  return store.guests.findAuthenticatedByTokenHash(hashGuestToken(token), now)
}
