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
import { sendError } from './http.js'
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
  const auth = await resolveSession(context.identity, request, context.now())
  if (auth === null) {
    sendError(response, 401, 'Nicht angemeldet')
    return null
  }
  return auth
}

/** Zusaetzliche Pflicht fuer zustandsaendernde Endpunkte. */
export function requireCsrfToken(
  context: AppContext,
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthenticatedSession,
): boolean {
  if (hasValidCsrfToken(request, auth, context.config.sessionSecret)) {
    return true
  }
  context.logger('warn', 'csrf.rejected', { userId: auth.user.id, path: request.url ?? '' })
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
