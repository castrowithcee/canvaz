/**
 * Routentabelle.
 *
 * Setzt die Routen der Teilbereiche zusammen. Der Kontext liefert Konfiguration, Persistenz, OIDC-Client und
 * WebSocket-Einstieg; keine Route baut selbst eine Verbindung auf.
 */

import { API_BASE_PATH } from '../contracts/api.js'
import type { HealthResponse } from '../contracts/api.js'
import { createAdminRoutes } from './admin-routes.js'
import { createAuthRoutes } from './auth-routes.js'
import type { AppContext } from './context.js'
import type { Route } from './http.js'
import { sendJson } from './http.js'

export type { AppContext }

export function createRoutes(context: AppContext): readonly Route[] {
  return [
    {
      method: 'GET',
      path: `${API_BASE_PATH}/health`,
      handle: async ({ response }) => {
        // Ein Health-Check ohne Datenbankkontakt meldet "gesund", waehrend nichts funktioniert.
        await context.pool.query('select 1')
        const body: HealthResponse = { status: 'ok', database: 'ok' }
        sendJson(response, 200, body)
      },
    },
    ...createAuthRoutes(context),
    ...createAdminRoutes(context),
  ]
}
