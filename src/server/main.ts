/**
 * Composition Root.
 *
 * Einziger Ort, an dem Konfiguration, Datenbank und HTTP zusammengesetzt werden. Alles darunter bekommt
 * seine Abhaengigkeiten uebergeben und kennt weder `process.env` noch den Pool.
 */

import { createServer } from 'node:http'

import { createAssetStorage } from '../persistence/asset-storage.js'
import { createBoardStore } from '../persistence/board-store.js'
import { createIdentityStore } from '../persistence/identity-store.js'
import { createPool } from '../persistence/pool.js'
import { createWorkspaceStore } from '../persistence/workspace-store.js'
import { createRoutes } from './app.js'
import { createBoardRooms } from './board-rooms.js'
import { ConfigError, loadConfig } from './config.js'
import type { AppContext } from './context.js'
import { createRequestListener } from './http.js'
import { consoleLogger, describeError } from './log.js'
import { createSmtpMailer } from './mailer.js'
import { createMetrics } from './metrics.js'
import { createOidcClient } from './oidc.js'
import { createRateLimiter } from './rate-limit.js'
import { createRealtimeGateway } from './realtime.js'
import { startTrashRetention } from './trash.js'

function loadConfigOrExit(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }
}

const config = loadConfigOrExit()
const pool = createPool(config.databaseUrl, (error: unknown) => {
  consoleLogger('error', 'database.connection.lost', { error: describeError(error) })
})
const identity = createIdentityStore(pool)
const workspaces = createWorkspaceStore(pool)
const boards = createBoardStore(pool)
const storage = createAssetStorage(config.storage)
// Dieselbe Obergrenze wie fuer einen gespeicherten Snapshot: der Raum haelt genau den Inhalt, den ein
// Checkpoint schreibt und den die HTTP-Speicherung wieder annehmen koennen muss.
const rooms = createBoardRooms({
  boards,
  logger: consoleLogger,
  now: () => new Date(),
  maxRoomBytes: config.maxSceneBytes,
  sceneVersionRetention: config.sceneVersionRetention,
})
const realtime = createRealtimeGateway({
  config,
  identity,
  workspaces,
  boards,
  logger: consoleLogger,
  now: () => new Date(),
  onConnection: rooms.onConnection,
})
const metrics = createMetrics()
const context: AppContext = {
  config,
  pool,
  identity,
  workspaces,
  boards,
  storage,
  // Ohne konfigurierten Provider gibt es keinen Client - und damit auch keine OIDC-Routen.
  oidc: config.oidc === null ? null : createOidcClient(config.oidc, config.baseUrl),
  // Ohne konfigurierten Postausgang gibt es keinen Transport - und damit keine Nachricht, auf die jemand
  // vergeblich wartet.
  mailer: config.mail === null ? null : createSmtpMailer(config.mail),
  realtime,
  rooms,
  logger: consoleLogger,
  metrics,
  now: () => new Date(),
}
/**
 * Die Aufbewahrungsfrist des Papierkorbs laeuft im Anwendungsprozess - kein Worker, keine Queue: der
 * Betriebsvertrag kennt genau eine Instanz, und ein Intervall darin braucht keine Koordination.
 */
const stopTrashRetention = startTrashRetention(context)

const server = createServer(
  createRequestListener(createRoutes(context), {
    webRoot: config.webRoot,
    rateLimit: createRateLimiter({ perMinute: config.rateLimitPerMinute }),
    trustedProxy: config.trustedProxy,
    metrics,
    logger: consoleLogger,
  }),
)
realtime.attach(server)

server.listen(config.port, () => {
  console.log(`Canvaz laeuft auf Port ${String(config.port)} (${config.baseUrl})`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopTrashRetention()
    server.close(() => {
      // Erst die Raeume: was noch nicht persistiert ist, wird beim geordneten Beenden noch geschrieben.
      void rooms
        .close()
        .then(() => pool.end())
        .then(() => {
          process.exit(0)
        })
    })
  })
}
