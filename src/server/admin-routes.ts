/**
 * Systemadministration.
 *
 * Minimal und serverseitig geprueft: Liste aller Nutzer sowie Aktivieren und Deaktivieren. Die Berechtigung
 * haengt an `isSystemAdmin` des angemeldeten Nutzers, nicht an der Oberflaeche. Deaktivieren widerruft alle
 * Sitzungen des betroffenen Nutzers und schliesst seine offenen WebSockets; ein Systemadmin kann sich selbst
 * nicht deaktivieren, sonst waere eine Instanz ohne Administration erzeugbar.
 */

import type { AdminUsersResponse, SetUserStatusRequest, UserStatusView } from '../contracts/api.js'
import { ADMIN_USER_STATUS_PATH, ADMIN_USERS_PATH } from '../contracts/api.js'
import type { AppContext } from './context.js'
import { requireCsrfToken, requireSession, requireSystemAdmin, toUserView } from './guard.js'
import type { Route } from './http.js'
import { readJsonBody, sendError, sendJson } from './http.js'
import { asRequester } from './requester.js'

const STATUSES: readonly UserStatusView[] = ['active', 'deactivated']

function parseRequest(body: Record<string, unknown> | null): SetUserStatusRequest | null {
  if (body === null) {
    return null
  }
  const userId = body['userId']
  const status = body['status']
  if (typeof userId !== 'string' || userId.length === 0) {
    return null
  }
  const parsed = STATUSES.find((candidate) => candidate === status)
  return parsed === undefined ? null : { userId, status: parsed }
}

export function createAdminRoutes(context: AppContext): readonly Route[] {
  return [
    {
      method: 'GET',
      path: ADMIN_USERS_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireSystemAdmin(context, response, auth)) {
          return
        }
        const users = await context.identity.users.list()
        const body: AdminUsersResponse = { users: users.map(toUserView) }
        sendJson(response, 200, body)
      },
    },

    {
      method: 'POST',
      path: ADMIN_USER_STATUS_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        if (!requireSystemAdmin(context, response, auth)) {
          return
        }
        const parsed = parseRequest(await readJsonBody(request))
        if (parsed === null) {
          sendError(response, 400, 'userId und status werden erwartet')
          return
        }
        if (parsed.userId === auth.user.id && parsed.status === 'deactivated') {
          sendError(response, 400, 'Ein Systemadmin kann sich nicht selbst deaktivieren')
          return
        }
        const target = await context.identity.users.findById(parsed.userId)
        if (target === null) {
          sendError(response, 404, 'Unbekannter Nutzer')
          return
        }
        const updated = await context.identity.users.setStatus(parsed.userId, parsed.status)
        if (parsed.status === 'deactivated') {
          // Sofort wirksam: bestehende Sitzungen und offene Verbindungen enden mit der Deaktivierung.
          await context.identity.sessions.revokeAllForUser(parsed.userId, context.now())
          context.realtime.closeUser(parsed.userId)
        }
        context.logger('info', 'admin.user-status.changed', {
          actorId: auth.user.id,
          userId: updated.id,
          status: updated.status,
        })
        sendJson(response, 200, toUserView(updated))
      },
    },
  ]
}
