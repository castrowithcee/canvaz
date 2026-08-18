/**
 * Anwendungskontext und Routentabelle.
 *
 * Nahtstelle fuer die folgenden Pakete: OIDC-Anmeldung, Session-Guard und API-Endpunkte ergaenzen hier ihre
 * Routen und bekommen ueber `AppContext` Konfiguration und Persistenz, ohne selbst eine Verbindung
 * aufzubauen.
 */

import type { Pool } from 'pg'

import { API_BASE_PATH } from '../contracts/api.js'
import type { HealthResponse } from '../contracts/api.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import type { AppConfig } from './config.js'
import type { Route } from './http.js'
import { sendJson } from './http.js'

export type AppContext = {
  readonly config: AppConfig
  readonly pool: Pool
  readonly identity: IdentityStore
}

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
  ]
}
