/**
 * Authentifizierter WebSocket-Einstieg.
 *
 * Bewusst ohne Protokoll, Raeume oder Presence: dieses Paket liefert nur den Upgrade-Pfad mit demselben
 * Auth-Kontext wie die HTTP-Endpunkte. Die Realtime-Strecke dockt spaeter an `onConnection` an.
 *
 * Der Upgrade laeuft ueber dieselbe Aufloesung wie jeder HTTP-Guard und damit ueber `authenticate()`. Offene
 * Verbindungen werden mitgefuehrt, damit Logout und Deaktivierung sie sofort schliessen koennen - sonst
 * bliebe eine widerrufene Sitzung auf einem langlebigen Socket weiter privilegiert.
 */

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

import { REALTIME_PATH } from '../contracts/api.js'
import type { AuthenticatedSession, SessionId, UserId } from '../domain/identity/model.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import type { Logger } from './log.js'
import { resolveSession } from './session.js'

/** Anwendungsdefinierter Schliessgrund: die Sitzung wurde serverseitig ungueltig. */
export const SESSION_REVOKED_CLOSE_CODE = 4401

export type RealtimeGateway = {
  attach(server: Server): void
  /** Beendet offene Verbindungen einer Sitzung, etwa beim Logout. */
  closeSession(sessionId: SessionId): void
  /** Beendet offene Verbindungen eines Nutzers, etwa bei Deaktivierung. */
  closeUser(userId: UserId): void
  readonly openConnections: number
  close(): Promise<void>
}

type Connection = {
  readonly socket: WebSocket
  readonly sessionId: SessionId
  readonly userId: UserId
}

export type RealtimeOptions = {
  readonly identity: IdentityStore
  readonly logger: Logger
  readonly now: () => Date
  /** Haken fuer die Realtime-Strecke. Ohne ihn bleibt die Verbindung offen und stumm. */
  readonly onConnection?: (socket: WebSocket, auth: AuthenticatedSession) => void
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

export function createRealtimeGateway(options: RealtimeOptions): RealtimeGateway {
  const server = new WebSocketServer({ noServer: true })
  const connections = new Set<Connection>()

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== REALTIME_PATH) {
      reject(socket, 404, 'Not Found')
      return
    }
    const auth = await resolveSession(options.identity, request, options.now())
    if (auth === null) {
      // Standardmaessig verweigernd: ohne gueltige Sitzung entsteht kein WebSocket.
      options.logger('warn', 'realtime.upgrade.denied', { path: url.pathname })
      reject(socket, 401, 'Unauthorized')
      return
    }
    server.handleUpgrade(request, socket, head, (webSocket) => {
      const connection: Connection = { socket: webSocket, sessionId: auth.session.id, userId: auth.user.id }
      connections.add(connection)
      webSocket.on('close', () => connections.delete(connection))
      options.logger('info', 'realtime.upgrade.accepted', { userId: auth.user.id })
      // Minimale Bestaetigung statt Protokoll: der Client weiss, dass er autorisiert verbunden ist.
      webSocket.send(JSON.stringify({ type: 'ready', userId: auth.user.id }))
      options.onConnection?.(webSocket, auth)
    })
  }

  function closeMatching(matches: (connection: Connection) => boolean): void {
    for (const connection of connections) {
      if (matches(connection)) {
        connection.socket.close(SESSION_REVOKED_CLOSE_CODE, 'Sitzung ungueltig')
        connections.delete(connection)
      }
    }
  }

  return {
    attach(httpServer: Server): void {
      httpServer.on('upgrade', (request, socket, head) => {
        void upgrade(request, socket, head).catch((error: unknown) => {
          options.logger('error', 'realtime.upgrade.failed', { reason: String(error) })
          reject(socket, 500, 'Internal Server Error')
        })
      })
    },
    closeSession(sessionId: SessionId): void {
      closeMatching((connection) => connection.sessionId === sessionId)
    },
    closeUser(userId: UserId): void {
      closeMatching((connection) => connection.userId === userId)
    },
    get openConnections(): number {
      return connections.size
    },
    async close(): Promise<void> {
      closeMatching(() => true)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
