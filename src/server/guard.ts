/**
 * Serverseitige Guards.
 *
 * Standardmaessig verweigernd: jeder geschuetzte Endpunkt beginnt hier, und die Entscheidung "angemeldet"
 * faellt ausschliesslich ueber `resolveSignedIn` und damit ueber die Domain-Invarianten `signedIn` und
 * `authenticate`. Was die Oberflaeche anzeigt oder ausblendet, spielt keine Rolle.
 *
 * ## Zweiter Faktor
 *
 * Eine Sitzung, deren zweiter Faktor noch aussteht (`secondFactorPending`), kommt an `requireSession` und
 * `requireRequester` **nicht** vorbei - also an keinem Endpunkt der Verwaltung, der Arbeitsbereiche und der
 * Boards. Sie faellt dabei auch nicht auf ein Gastcookie im selben Browser zurueck: eine eingeschraenkte
 * Sitzung ist eine Ablehnung und kein fehlender Zugang. Nur `requireSignedIn` laesst sie durch; das nutzen
 * ausschliesslich Profil, Abmeldung und die Endpunkte des zweiten Faktors.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { UserView } from '../contracts/api.js'
import type { AuthenticatedSession, SignedInSession, User } from '../domain/identity/model.js'
import type { AppContext } from './context.js'
import { hasValidGuestCsrfToken, resolveGuestSession } from './guest-session.js'
import { sendError } from './http.js'
import type { Requester } from './requester.js'
import { requesterFields } from './requester.js'
import { hasValidCsrfToken, resolveSignedIn } from './session.js'

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

/** Antwort an eine Sitzung ohne belegten zweiten Faktor. Die Oberflaeche fuehrt daraufhin zur Abfrage. */
export const SECOND_FACTOR_REQUIRED = 'Zweiter Faktor erforderlich'

function rejectPending(context: AppContext, request: IncomingMessage, response: ServerResponse, auth: SignedInSession): void {
  context.logger('warn', 'authorization.denied', {
    userId: auth.user.id,
    required: 'second-factor',
    path: new URL(request.url ?? '/', 'http://localhost').pathname,
  })
  sendError(response, 403, SECOND_FACTOR_REQUIRED)
}

/**
 * Sitzung nach dem ersten Faktor, auch mit ausstehendem zweitem. Nur fuer Profil, Abmeldung und die
 * Endpunkte des zweiten Faktors; jeder andere Endpunkt nimmt `requireSession`.
 */
export async function requireSignedIn(
  context: AppContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<SignedInSession | null> {
  const auth = await resolveSignedIn(context.identity, context.config, request, context.now())
  if (auth === null) {
    sendError(response, 401, 'Nicht angemeldet')
    return null
  }
  return auth
}

/**
 * Liefert die Sitzung oder beantwortet die Anfrage mit 401 - oder mit 403, wenn der zweite Faktor aussteht -
 * und gibt `null` zurueck.
 */
export async function requireSession(
  context: AppContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<AuthenticatedSession | null> {
  const auth = await requireSignedIn(context, request, response)
  if (auth === null) {
    return null
  }
  if (auth.secondFactorPending) {
    rejectPending(context, request, response, auth)
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
  const auth = await resolveSignedIn(context.identity, context.config, request, now)
  if (auth !== null) {
    if (auth.secondFactorPending) {
      rejectPending(context, request, response, auth)
      return null
    }
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
