/**
 * Serverseitige Guards.
 *
 * Standardmaessig verweigernd: jeder geschuetzte Endpunkt beginnt hier, und die Entscheidung "angemeldet"
 * faellt ausschliesslich ueber `resolveSession` und damit ueber die Domain-Invariante `authenticate`. Was die
 * Oberflaeche anzeigt oder ausblendet, spielt keine Rolle.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { UserView } from '../contracts/api.js'
import type { AuthenticatedSession, User } from '../domain/identity/model.js'
import type { AppContext } from './context.js'
import { hasValidGuestCsrfToken, resolveGuestSession } from './guest-session.js'
import { sendError } from './http.js'
import type { Requester } from './requester.js'
import { requesterFields } from './requester.js'
import { hasValidCsrfToken, resolveSession } from './session.js'

export function toUserView(user: User): UserView {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    status: user.status,
    isSystemAdmin: user.isSystemAdmin,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  }
}

/** Liefert die Sitzung oder beantwortet die Anfrage mit 401 und gibt `null` zurueck. */
export async function requireSession(
  context: AppContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<AuthenticatedSession | null> {
  const auth = await resolveSession(context.identity, context.config, request, context.now())
  if (auth === null) {
    sendError(response, 401, 'Nicht angemeldet')
    return null
  }
  return auth
}

/**
 * Sitzung **oder** Gastsession, in dieser Reihenfolge.
 *
 * Die interne Sitzung hat Vorrang: sie ist die staerkere, namentliche Identitaet, und wer angemeldet ist,
 * soll nicht durch ein altes Gastcookie im selben Browser auf Gastrechte fallen. Erst wenn keine gueltige
 * Sitzung da ist, zaehlt der Gastzugang - und auch der nur, solange Gastsession **und** Link leben.
 *
 * Beantwortet die Anfrage mit 401 und gibt `null` zurueck, wenn beides fehlt.
 */
export async function requireRequester(
  context: AppContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Requester | null> {
  const now = context.now()
  const auth = await resolveSession(context.identity, context.config, request, now)
  if (auth !== null) {
    return { kind: 'user', auth }
  }
  const guest = await resolveGuestSession(context.boards, context.config, request, now)
  if (guest !== null) {
    return { kind: 'guest', guest }
  }
  sendError(response, 401, 'Nicht angemeldet')
  return null
}

/**
 * Zusaetzliche Pflicht fuer zustandsaendernde Endpunkte.
 *
 * Das Token ist an genau die Sitzung gebunden, die die Anfrage fuehrt. Interne Sitzung und Gastsession
 * tragen dabei verschiedene Marken (`csrf:` und `csrf:guest:`), sodass das Token der einen die andere nie
 * legitimieren kann.
 */
export function requireCsrfToken(
  context: AppContext,
  request: IncomingMessage,
  response: ServerResponse,
  requester: Requester,
): boolean {
  const valid =
    requester.kind === 'user'
      ? hasValidCsrfToken(request, requester.auth, context.config.sessionSecret)
      : hasValidGuestCsrfToken(request, requester.guest, context.config.sessionSecret)
  if (valid) {
    return true
  }
  context.logger('warn', 'csrf.rejected', { ...requesterFields(requester), path: request.url ?? '' })
  sendError(response, 403, 'Ungueltiges CSRF-Token')
  return false
}

export function requireSystemAdmin(
  context: AppContext,
  response: ServerResponse,
  auth: AuthenticatedSession,
): boolean {
  if (auth.user.isSystemAdmin) {
    return true
  }
  context.logger('warn', 'authorization.denied', { userId: auth.user.id, required: 'system-admin' })
  sendError(response, 403, 'Keine Berechtigung')
  return false
}
