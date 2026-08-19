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
import { consoleLogger } from './log.js'
import { createOidcClient } from './oidc.js'
import { createRealtimeGateway } from './realtime.js'

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
const pool = createPool(config.databaseUrl)
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
const context: AppContext = {
  config,
  pool,
  identity,
  workspaces,
  boards,
  storage,
  oidc: createOidcClient(config),
  realtime,
  rooms,
  logger: consoleLogger,
  now: () => new Date(),
}
const server = createServer(createRequestListener(createRoutes(context), config.webRoot))
realtime.attach(server)

server.listen(config.port, () => {
  console.log(`Canvaz laeuft auf Port ${String(config.port)} (${config.baseUrl})`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
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
