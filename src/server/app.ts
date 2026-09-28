/**
 * Routentabelle.
 *
 * Setzt die Routen der Teilbereiche zusammen. Der Kontext liefert Konfiguration, Persistenz, den optionalen
 * OIDC-Client und den WebSocket-Einstieg; keine Route baut selbst eine Verbindung auf.
 */

import { HEALTH_PATH, METRICS_PATH, READY_PATH } from '../contracts/api.js'
import type { HealthResponse, ReadyResponse } from '../contracts/api.js'
import { createAdminRoutes } from './admin-routes.js'
import { createAuthRoutes } from './auth-routes.js'
import { createBoardRoutes } from './board-routes.js'
import { createBoardShareRoutes } from './board-share-routes.js'
import { createBoardTrashRoutes } from './board-trash-routes.js'
import { createBoardVersionRoutes } from './board-version-routes.js'
import type { AppContext } from './context.js'
import { createFolderRoutes } from './folder-routes.js'
import type { Route } from './http.js'
import { sendBytes, sendJson } from './http.js'
import { createLocalAuthRoutes } from './local-auth-routes.js'
import { createSecondFactorRoutes } from './second-factor-routes.js'
import { describeError } from './log.js'
import { createWorkspaceRoutes } from './workspace-routes.js'

export type { AppContext }

export function createRoutes(context: AppContext): readonly Route[] {
  return [
    {
      method: 'GET',
      path: HEALTH_PATH,
      handle: async ({ response }) => {
        // Ein Health-Check ohne Datenbankkontakt meldet "gesund", waehrend nichts funktioniert.
        await context.pool.query('select 1')
        const body: HealthResponse = { status: 'ok', database: 'ok' }
        sendJson(response, 200, body)
      },
    },
    {
      method: 'GET',
      path: READY_PATH,
      handle: async ({ response }) => {
        // Beide Abhaengigkeiten werden geprueft, auch wenn die erste schon scheitert: die Antwort soll
        // sagen, *was* fehlt, statt nur *dass* etwas fehlt.
        const [database, storage] = await Promise.all([
          context.pool
            .query('select 1')
            .then(() => null)
            .catch((error: unknown) => describeError(error)),
          context.storage
            .probe()
            .then(() => null)
            .catch((error: unknown) => describeError(error)),
        ])
        const body: ReadyResponse = {
          status: database === null && storage === null ? 'ready' : 'unready',
          database: database === null ? 'ok' : 'error',
          storage: storage === null ? 'ok' : 'error',
        }
        if (body.status === 'unready') {
          // Der Grund gehoert ins Log, nicht in die Antwort: die Bereitschaft ist oeffentlich erreichbar.
          context.logger('error', 'ready.failed', {
            database: database ?? 'ok',
            storage: storage ?? 'ok',
          })
        }
        // 503 ist die Antwort, an der ein Reverse Proxy diese Instanz aus dem Verkehr nimmt.
        sendJson(response, body.status === 'ready' ? 200 : 503, body)
      },
    },
    {
      method: 'GET',
      path: METRICS_PATH,
      handle: ({ response }) => {
        const text = context.metrics.render({
          realtimeConnections: context.realtime.openConnections,
          boardRooms: context.rooms.roomCount,
          dbPoolTotal: context.pool.totalCount,
          dbPoolIdle: context.pool.idleCount,
          dbPoolWaiting: context.pool.waitingCount,
        })
        sendBytes(response, Buffer.from(text, 'utf8'), {
          contentType: 'text/plain; version=0.0.4; charset=utf-8',
          cacheControl: 'no-store',
        })
      },
    },
    ...createAuthRoutes(context),
    ...createLocalAuthRoutes(context),
    ...createSecondFactorRoutes(context),
    ...createAdminRoutes(context),
    ...createWorkspaceRoutes(context),
    ...createFolderRoutes(context),
    ...createBoardRoutes(context),
    ...createBoardTrashRoutes(context),
    ...createBoardShareRoutes(context),
    ...createBoardVersionRoutes(context),
  ]
}
