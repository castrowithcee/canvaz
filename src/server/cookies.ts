/**
 * Cookie-Hilfsfunktionen.
 *
 * Node liefert weder Parser noch Serialisierung mit. Der Bedarf sind zwei Cookies mit festen Attributen;
 * dafuer waere eine Abhaengigkeit mehr Aufwand als die zwei Funktionen hier.
 */

import type { ServerResponse } from 'node:http'

/**
 * `null` bedeutet: fehlerhaft prozentkodiert. Ein solcher Wert kann nicht von dieser Anwendung stammen und
 * zaehlt wie ein fehlendes Cookie - `decodeURIComponent` wuerde sonst mitten im Guard werfen und aus einer
 * unauthentisierten Anfrage einen Serverfehler machen.
 */
function decodeCookieValue(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  if (header === undefined) {
    return {}
  }
  const cookies: Record<string, string> = {}
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) {
      continue
    }
    const name = part.slice(0, separator).trim()
    const value = decodeCookieValue(part.slice(separator + 1).trim())
    if (name.length > 0 && value !== null && cookies[name] === undefined) {
      cookies[name] = value
    }
  }
  return cookies
}

export type CookieOptions = {
  readonly path: string
  readonly maxAgeSeconds: number
  readonly secure: boolean
  /** Nur `Lax` wird gebraucht: der Provider schickt den Nutzer per Top-Level-Navigation zurueck. */
  readonly sameSite?: 'Lax' | 'Strict'
  readonly httpOnly?: boolean
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${String(options.maxAgeSeconds)}`,
    `SameSite=${options.sameSite ?? 'Lax'}`,
  ]
  if (options.httpOnly !== false) {
    attributes.push('HttpOnly')
  }
  if (options.secure) {
    attributes.push('Secure')
  }
  return attributes.join('; ')
}

/** Ein Cookie wird geloescht, indem derselbe Pfad mit leerem Wert und abgelaufener Lebensdauer gesetzt wird. */
export function clearCookie(name: string, options: Omit<CookieOptions, 'maxAgeSeconds'>): string {
  return serializeCookie(name, '', { ...options, maxAgeSeconds: 0 })
}

/**
 * Haengt ein weiteres `Set-Cookie` an die Antwort. Der Callback setzt zwei Cookies in einer Antwort; ein
 * einfaches `setHeader` wuerde das erste stillschweigend verwerfen.
 */
export function appendSetCookie(response: ServerResponse, value: string): void {
  const existing = response.getHeader('set-cookie')
  if (existing === undefined) {
    response.setHeader('set-cookie', value)
    return
  }
  response.setHeader('set-cookie', [...(Array.isArray(existing) ? existing : [String(existing)]), value])
}
