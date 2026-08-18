/**
 * Authentifizierter WebSocket-Einstieg.
 *
 * Bewusst ohne Protokoll, Raeume oder Presence: dieses Paket liefert nur den Upgrade-Pfad mit demselben
 * Auth-Kontext wie die HTTP-Endpunkte. Die Realtime-Strecke dockt spaeter an `onConnection` an.
 *
 * Der Upgrade laeuft ueber dieselbe Aufloesung wie jeder HTTP-Guard und damit ueber `authenticate()`. Offene
 * Verbindungen werden mitgefuehrt, damit Logout, Deaktivierung und Ablauf sie schliessen koennen - sonst
 * bliebe eine ungueltige Sitzung auf einem langlebigen Socket weiter privilegiert.
 *
 * Zwei Pruefungen gehoeren zum Upgrade selbst: die Herkunft, weil der CSRF-Header hier nicht greift und
 * `SameSite=Lax` das Cookie an einem fremden Ursprung trotzdem mitschickt, und der Ablaufzeitpunkt, weil
 * nach dem Handshake keine Anfrage mehr geprueft wird.
 */

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

import { REALTIME_PATH } from '../contracts/api.js'
import type { AuthenticatedSession, SessionId, UserId } from '../domain/identity/model.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import type { WorkspaceId, WorkspaceRole } from '../domain/workspace/model.js'
import type { WorkspaceStore } from '../domain/workspace/repositories.js'
import type { AppConfig } from './config.js'
import type { Logger } from './log.js'
import { resolveSession } from './session.js'

/** Anwendungsdefinierter Schliessgrund: die Sitzung wurde serverseitig ungueltig. */
export const SESSION_REVOKED_CLOSE_CODE = 4401

/**
 * Andockpunkt fuer die spaetere Realtime-Strecke.
 *
 * Es gibt bewusst noch kein Raumkonzept: eine Verbindung gehoert zu einer Sitzung, nicht zu einem Board.
 * Damit ein spaeterer Boardraum die Workspacezugehoerigkeit pruefen kann, bekommt `onConnection` diese
 * Abfrage mit. Sie liest bei **jedem** Aufruf frisch aus der Datenbank und speichert nichts zwischen -
 * deshalb wirkt ein Mitgliedschaftsentzug sowohl auf neue Verbindungen als auch auf jeden spaeteren Beitritt
 * einer bestehenden Verbindung.
 */
export type WorkspaceScope = {
  role(workspaceId: WorkspaceId): Promise<WorkspaceRole | null>
}

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
  readonly expiresAt: Date
}

/** Abstand der Ablaufpruefung. Eine Minute genuegt bei Sitzungen von Stunden; Tests setzen ihn kurz. */
const DEFAULT_EXPIRY_CHECK_INTERVAL_MS = 60_000

export type RealtimeOptions = {
  readonly config: AppConfig
  readonly identity: IdentityStore
  readonly workspaces: WorkspaceStore
  readonly logger: Logger
  readonly now: () => Date
  readonly expiryCheckIntervalMs?: number
  /** Haken fuer die Realtime-Strecke. Ohne ihn bleibt die Verbindung offen und stumm. */
  readonly onConnection?: (socket: WebSocket, auth: AuthenticatedSession, scope: WorkspaceScope) => void
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

export function createRealtimeGateway(options: RealtimeOptions): RealtimeGateway {
  const server = new WebSocketServer({ noServer: true })
  const connections = new Set<Connection>()
  const allowedOrigin = new URL(options.config.baseUrl).origin

  /**
   * Ein fehlender `Origin` wird angenommen: Browser senden ihn beim WebSocket-Handshake immer, ein Aufruf
   * ohne den Header stammt also nicht aus einem Browser und traegt kein fremd erzwungenes Cookie.
   */
  function hasAllowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    return origin === undefined || origin === allowedOrigin
  }

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== REALTIME_PATH) {
      reject(socket, 404, 'Not Found')
      return
    }
    if (!hasAllowedOrigin(request)) {
      options.logger('warn', 'realtime.upgrade.denied', { path: url.pathname, reason: 'fremde-herkunft' })
      reject(socket, 403, 'Forbidden')
      return
    }
    const auth = await resolveSession(options.identity, options.config, request, options.now())
    if (auth === null) {
      // Standardmaessig verweigernd: ohne gueltige Sitzung entsteht kein WebSocket.
      options.logger('warn', 'realtime.upgrade.denied', { path: url.pathname })
      reject(socket, 401, 'Unauthorized')
      return
    }
    server.handleUpgrade(request, socket, head, (webSocket) => {
      const connection: Connection = {
        socket: webSocket,
        sessionId: auth.session.id,
        userId: auth.user.id,
        expiresAt: auth.session.expiresAt,
      }
      connections.add(connection)
      webSocket.on('close', () => connections.delete(connection))
      options.logger('info', 'realtime.upgrade.accepted', { userId: auth.user.id })
      // Minimale Bestaetigung statt Protokoll: der Client weiss, dass er autorisiert verbunden ist.
      webSocket.send(JSON.stringify({ type: 'ready', userId: auth.user.id }))
      const scope: WorkspaceScope = {
        async role(workspaceId: WorkspaceId): Promise<WorkspaceRole | null> {
          const access = await options.workspaces.workspaces.findForUser(workspaceId, auth.user.id)
          return access?.role ?? null
        },
      }
      options.onConnection?.(webSocket, auth, scope)
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

  // Widerruf und Deaktivierung schliessen unmittelbar; der Ablauf hat kein Ereignis und braucht deshalb eine
  // wiederkehrende Pruefung. `unref` haelt weder Prozess noch Tests offen.
  const expirySweep = setInterval(() => {
    const now = options.now().getTime()
    closeMatching((connection) => connection.expiresAt.getTime() <= now)
  }, options.expiryCheckIntervalMs ?? DEFAULT_EXPIRY_CHECK_INTERVAL_MS)
  expirySweep.unref()

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
      clearInterval(expirySweep)
      closeMatching(() => true)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
