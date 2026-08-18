/**
 * Authentifizierter WebSocket-Einstieg.
 *
 * Diese Datei liefert ausschliesslich den Upgrade-Pfad mit demselben Auth-Kontext wie die HTTP-Endpunkte
 * und das Verbindungsregister. Protokoll, Raeume und Presence stehen in `board-rooms.ts` und docken ueber
 * `onConnection` an.
 *
 * Der Upgrade laeuft ueber dieselbe Aufloesung wie jeder HTTP-Guard und damit ueber `authenticate()`. Offene
 * Verbindungen werden mitgefuehrt, damit Logout, Deaktivierung und Ablauf sie schliessen koennen - sonst
 * bliebe eine ungueltige Sitzung auf einem langlebigen Socket weiter privilegiert.
 *
 * Zwei Pruefungen gehoeren zum Upgrade selbst: die Herkunft, weil der CSRF-Header hier nicht greift und
 * `SameSite=Lax` das Cookie an einem fremden Ursprung trotzdem mitschickt, und der Ablaufzeitpunkt, weil
 * nach dem Handshake keine Anfrage mehr geprueft wird.
 *
 * ## Was auf dieser Ebene begrenzt wird
 *
 * Alles, was die **Verbindung** betrifft und keinen Raum kennt: die Rahmengroesse (`maxPayload`), die Zahl
 * offener Verbindungen je Nutzer und der Herzschlag gegen halb offene Sockets. Nachrichtenrate,
 * Raumgroesse und Backpressure haengen am Raum und stehen in `board-rooms.ts`.
 */

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

import { REALTIME_PATH } from '../contracts/api.js'
import type { ErrorMessage, ReadyMessage } from '../contracts/realtime.js'
import {
  REALTIME_ERROR_MESSAGES,
  REALTIME_PROTOCOL_VERSION,
  SESSION_REVOKED_CLOSE_CODE,
  TOO_MANY_CLOSE_CODE,
} from '../contracts/realtime.js'
import type { AuthenticatedSession, SessionId, UserId } from '../domain/identity/model.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import type { WorkspaceId, WorkspaceRole } from '../domain/workspace/model.js'
import type { WorkspaceStore } from '../domain/workspace/repositories.js'
import type { AppConfig } from './config.js'
import type { Logger } from './log.js'
import { resolveSession } from './session.js'

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
  /**
   * Hat diese Verbindung seit dem letzten Herzschlag geantwortet?
   *
   * Ein halb offener Socket (Kabel gezogen, Laptop zugeklappt, Proxy ohne FIN) bleibt fuer TCP unbemerkt
   * offen. Ohne diese Markierung behielte er seinen Raumplatz und seinen Presence-Eintrag, bis das
   * Betriebssystem irgendwann aufgibt - das sind Stunden.
   */
  alive: boolean
}

/** Abstand der Ablaufpruefung. Eine Minute genuegt bei Sitzungen von Stunden; Tests setzen ihn kurz. */
const DEFAULT_EXPIRY_CHECK_INTERVAL_MS = 60_000

/**
 * Abstand der Herzschlaege.
 *
 * Uebliche Leerlaufgrenzen von Reverse Proxys liegen bei 60 Sekunden (nginx `proxy_read_timeout`). Ein
 * Herzschlag alle 30 Sekunden haelt die Strecke offen und erkennt einen toten Socket spaetestens nach zwei
 * Runden, also nach einer Minute. Kuerzer waere Verkehr ohne Nutzen, laenger liesse eine Karteileiche zu
 * lange stehen.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Hoechstzahl offener Verbindungen je Nutzer.
 *
 * Ein Mensch arbeitet an einem, hoechstens zwei Boards zugleich; fuenf Tabs sind grosszuegig. Das Lastziel
 * sind zehn gleichzeitige Verbindungen insgesamt - ein einzelnes Konto darf sie nicht allein belegen.
 */
const DEFAULT_MAX_CONNECTIONS_PER_USER = 5

export type RealtimeOptions = {
  readonly config: AppConfig
  readonly identity: IdentityStore
  readonly workspaces: WorkspaceStore
  readonly logger: Logger
  readonly now: () => Date
  readonly expiryCheckIntervalMs?: number
  readonly heartbeatIntervalMs?: number
  readonly maxConnectionsPerUser?: number
  /** Haken fuer die Realtime-Strecke. Ohne ihn bleibt die Verbindung offen und stumm. */
  readonly onConnection?: (socket: WebSocket, auth: AuthenticatedSession, scope: WorkspaceScope) => void
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

export function createRealtimeGateway(options: RealtimeOptions): RealtimeGateway {
  // Groessengrenze am Rahmen selbst: `ws` verwirft alles Groessere, bevor es im Speicher zusammengesetzt
  // wird. Dieselbe Grenze wie fuer einen gespeicherten Snapshot - mehr kann eine Aenderung nie tragen.
  const server = new WebSocketServer({ noServer: true, maxPayload: options.config.maxSceneBytes })
  const connections = new Set<Connection>()
  const allowedOrigin = new URL(options.config.baseUrl).origin
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const maxConnectionsPerUser = options.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER

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
      /**
       * Ohne diesen Zuhoerer beendet ein einziger uebergrosser Rahmen den **gesamten Serverprozess**: `ws`
       * meldet die ueberschrittene `maxPayload` als `error` auf dem Socket, und ein `error` ohne Zuhoerer
       * wird in Node zu einer nicht abgefangenen Ausnahme. `ws` schliesst danach selbst mit dem
       * Standardcode 1009; hier bleibt nur das Protokollieren.
       */
      webSocket.on('error', (error: Error) => {
        options.logger('warn', 'realtime.socket.error', { userId: auth.user.id, reason: error.message })
      })
      if (countForUser(auth.user.id) >= maxConnectionsPerUser) {
        // Benannt abgelehnt statt still verworfen: der Browser sieht den Grund und hoert auf, es zu
        // wiederholen. Die Verbindung wird nicht mitgefuehrt und belegt deshalb auch keinen Platz.
        options.logger('warn', 'realtime.upgrade.denied', { userId: auth.user.id, reason: 'zu-viele-verbindungen' })
        const abgelehnt: ErrorMessage = {
          type: 'error',
          code: 'zu-viele-verbindungen',
          message: REALTIME_ERROR_MESSAGES['zu-viele-verbindungen'],
        }
        webSocket.send(JSON.stringify(abgelehnt))
        webSocket.close(TOO_MANY_CLOSE_CODE, 'Zu viele Verbindungen')
        return
      }
      const connection: Connection = {
        socket: webSocket,
        sessionId: auth.session.id,
        userId: auth.user.id,
        expiresAt: auth.session.expiresAt,
        alive: true,
      }
      connections.add(connection)
      webSocket.on('close', () => connections.delete(connection))
      webSocket.on('pong', () => {
        connection.alive = true
      })
      options.logger('info', 'realtime.upgrade.accepted', { userId: auth.user.id })
      // Erste Nachricht der Zustandsmaschine: verbunden und authentifiziert, aber in keinem Raum. Die
      // Protokollversion steht dabei, damit ein Browser mit altem Bundle es bemerkt, bevor er beitritt.
      const ready: ReadyMessage = {
        type: 'ready',
        protocolVersion: REALTIME_PROTOCOL_VERSION,
        userId: auth.user.id,
      }
      webSocket.send(JSON.stringify(ready))
      const scope: WorkspaceScope = {
        async role(workspaceId: WorkspaceId): Promise<WorkspaceRole | null> {
          const access = await options.workspaces.workspaces.findForUser(workspaceId, auth.user.id)
          return access?.role ?? null
        },
      }
      options.onConnection?.(webSocket, auth, scope)
    })
  }

  function countForUser(userId: UserId): number {
    let offen = 0
    for (const connection of connections) {
      if (connection.userId === userId) {
        offen += 1
      }
    }
    return offen
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

  /**
   * Herzschlag.
   *
   * Wer die letzte Runde nicht beantwortet hat, wird **hart** beendet (`terminate`) und nicht hoeflich
   * geschlossen: ein halb offener Socket beantwortet auch den Schliessvorgang nicht mehr und bliebe sonst
   * bis zum Zeitablauf des Betriebssystems stehen. Das `close`-Ereignis raeumt danach Raumplatz und
   * Presence auf demselben Weg auf wie ein regulaerer Abgang.
   */
  const heartbeat = setInterval(() => {
    for (const connection of [...connections]) {
      if (!connection.alive) {
        options.logger('warn', 'realtime.heartbeat.dead', { userId: connection.userId })
        connections.delete(connection)
        connection.socket.terminate()
        continue
      }
      if (connection.socket.readyState !== connection.socket.OPEN) {
        // Bereits im Schliessen; ein Ping darauf waere nur ein Fehler mehr im Protokoll.
        continue
      }
      connection.alive = false
      connection.socket.ping()
    }
  }, heartbeatIntervalMs)
  heartbeat.unref()

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
      clearInterval(heartbeat)
      closeMatching(() => true)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
