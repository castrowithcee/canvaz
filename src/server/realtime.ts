/**
 * Authentifizierter WebSocket-Einstieg.
 *
 * Diese Datei liefert ausschliesslich den Upgrade-Pfad mit demselben Auth-Kontext wie die HTTP-Endpunkte
 * und das Verbindungsregister. Protokoll, Raeume und Presence stehen in `board-rooms.ts` und docken ueber
 * `onConnection` an.
 *
 * Der Upgrade laeuft ueber dieselbe Aufloesung wie jeder HTTP-Guard und damit ueber `authenticate()` -
 * beziehungsweise, fuer einen Gast, ueber dieselbe Abfrage, die auch seine HTTP-Anfragen aufloest. Offene
 * Verbindungen werden mitgefuehrt, damit Logout, Deaktivierung, Ablauf und der Widerruf eines
 * Freigabelinks sie schliessen koennen - sonst bliebe ein ungueltig gewordener Zugang auf einem
 * langlebigen Socket weiter privilegiert.
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
import type { BoardShareLinkId } from '../domain/board/guest.js'
import type { BoardStore } from '../domain/board/repositories.js'
import type { SessionId, UserId } from '../domain/identity/model.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import type { WorkspaceId, WorkspaceRole } from '../domain/workspace/model.js'
import type { WorkspaceStore } from '../domain/workspace/repositories.js'
import type { AppConfig } from './config.js'
import { resolveGuestSession } from './guest-session.js'
import type { Logger } from './log.js'
import type { Requester } from './requester.js'
import { requesterFields, sessionIdOf } from './requester.js'
import { resolveSignedIn } from './session.js'

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
  /** Beendet offene Verbindungen einer Sitzung, etwa beim Logout. Gilt auch fuer eine Gastsession. */
  closeSession(sessionId: SessionId): void
  /** Beendet offene Verbindungen eines Nutzers, etwa bei Deaktivierung. */
  closeUser(userId: UserId): void
  /**
   * Beendet offene Verbindungen aller Gaeste eines Freigabelinks - der Widerruf.
   *
   * Die wiederkehrende Nachpruefung im Raum wuerde sie ohnehin beenden; dieser Weg macht daraus ein
   * Ereignis statt einer Wartezeit, genau wie `closeSession` beim Logout.
   */
  closeShareLink(shareLinkId: BoardShareLinkId): void
  readonly openConnections: number
  close(): Promise<void>
}

type Connection = {
  readonly socket: WebSocket
  /** Kennung der internen Sitzung oder der Gastsession. Zwei getrennte Kennungsraeume, ein Feld. */
  readonly sessionId: string
  /** `null` bei einem Gast: er hat kein Konto, das deaktiviert werden koennte. */
  readonly userId: UserId | null
  /** Nur beim Gast gesetzt. Traegt den Widerruf des Links auf die offene Verbindung. */
  readonly shareLinkId: BoardShareLinkId | null
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
 * Hoechstzahl offener Verbindungen je Zugang.
 *
 * Ein Mensch arbeitet an einem, hoechstens zwei Boards zugleich; fuenf Tabs sind grosszuegig. Das Lastziel
 * sind zehn gleichzeitige Verbindungen insgesamt - ein einzelnes Konto darf sie nicht allein belegen. Fuer
 * einen Gast zaehlt dasselbe je Gastsession; ein geteilter Link vervielfacht die Grenze nicht, weil jeder
 * Beitritt seine eigene Gastsession bekommt und der Raum zusaetzlich seine Teilnehmerzahl begrenzt.
 */
const DEFAULT_MAX_CONNECTIONS_PER_USER = 5

export type RealtimeOptions = {
  readonly config: AppConfig
  readonly identity: IdentityStore
  readonly workspaces: WorkspaceStore
  /** Fuer die Aufloesung einer Gastsession; sie haengt an Freigabelink und Board, nicht an einem Konto. */
  readonly boards: BoardStore
  readonly logger: Logger
  readonly now: () => Date
  readonly expiryCheckIntervalMs?: number
  readonly heartbeatIntervalMs?: number
  readonly maxConnectionsPerUser?: number
  /** Haken fuer die Realtime-Strecke. Ohne ihn bleibt die Verbindung offen und stumm. */
  readonly onConnection?: (socket: WebSocket, requester: Requester, scope: WorkspaceScope) => void
}

function reject(socket: Duplex, status: number, reason: string): void {
  // Die Gegenstelle kann zwischen Pruefung und Antwort laengst weg sein; ein Schreibfehler darf hier nicht
  // aus der Ablehnung selbst einen Fehler machen.
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`, () => undefined)
  }
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
    const requester = await resolveRequester(request)
    if (requester === 'second-factor-pending') {
      // Dieselbe Grenze wie im HTTP-Guard: ohne belegten zweiten Faktor keine Verbindung - auch nicht ueber
      // ein Gastcookie im selben Browser.
      options.logger('warn', 'realtime.upgrade.denied', { path: url.pathname, reason: 'zweiter-faktor' })
      reject(socket, 403, 'Forbidden')
      return
    }
    if (requester === null) {
      // Standardmaessig verweigernd: ohne gueltige Sitzung entsteht kein WebSocket. Fuer einen Gast heisst
      // das zusaetzlich: ohne lebenden Link keine Verbindung, auch nicht mit gueltigem Gastcookie.
      options.logger('warn', 'realtime.upgrade.denied', { path: url.pathname })
      reject(socket, 401, 'Unauthorized')
      return
    }
    const who = requesterFields(requester)
    server.handleUpgrade(request, socket, head, (webSocket) => {
      /**
       * Ohne diesen Zuhoerer beendet ein einziger uebergrosser Rahmen den **gesamten Serverprozess**: `ws`
       * meldet die ueberschrittene `maxPayload` als `error` auf dem Socket, und ein `error` ohne Zuhoerer
       * wird in Node zu einer nicht abgefangenen Ausnahme. `ws` schliesst danach selbst mit dem
       * Standardcode 1009; hier bleibt nur das Protokollieren.
       */
      webSocket.on('error', (error: Error) => {
        options.logger('warn', 'realtime.socket.error', { ...who, reason: error.message })
      })
      if (countForSession(requester) >= maxConnectionsPerUser) {
        // Benannt abgelehnt statt still verworfen: der Browser sieht den Grund und hoert auf, es zu
        // wiederholen. Die Verbindung wird nicht mitgefuehrt und belegt deshalb auch keinen Platz.
        options.logger('warn', 'realtime.upgrade.denied', { ...who, reason: 'zu-viele-verbindungen' })
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
        sessionId: sessionIdOf(requester),
        userId: requester.kind === 'user' ? requester.auth.user.id : null,
        shareLinkId: requester.kind === 'guest' ? requester.guest.session.shareLinkId : null,
        expiresAt:
          requester.kind === 'user' ? requester.auth.session.expiresAt : requester.guest.session.expiresAt,
        alive: true,
      }
      connections.add(connection)
      webSocket.on('close', () => connections.delete(connection))
      webSocket.on('pong', () => {
        connection.alive = true
      })
      options.logger('info', 'realtime.upgrade.accepted', who)
      // Erste Nachricht der Zustandsmaschine: verbunden und authentifiziert, aber in keinem Raum. Die
      // Protokollversion steht dabei, damit ein Browser mit altem Bundle es bemerkt, bevor er beitritt.
      // `userId` bleibt fuer einen internen Nutzer genau seine Nutzerkennung; ein Gast hat keine und
      // bekommt die Kennung seiner Gastsession. Das Protokoll aendert sich dafuer nicht, und der Client
      // braucht das Feld ohnehin nur, um sich selbst wiederzuerkennen.
      const ready: ReadyMessage = {
        type: 'ready',
        protocolVersion: REALTIME_PROTOCOL_VERSION,
        userId: connection.userId ?? connection.sessionId,
      }
      webSocket.send(JSON.stringify(ready))
      const scope: WorkspaceScope = {
        async role(workspaceId: WorkspaceId): Promise<WorkspaceRole | null> {
          // Ein Gast ist in keinem Arbeitsbereich Mitglied - fuer ihn ist die Antwort immer `null`.
          if (requester.kind === 'guest') {
            return null
          }
          const access = await options.workspaces.workspaces.findForUser(workspaceId, requester.auth.user.id)
          return access?.role ?? null
        },
      }
      options.onConnection?.(webSocket, requester, scope)
    })
  }

  /**
   * Interne Sitzung **oder** Gastsession, in dieser Reihenfolge.
   *
   * Dieselbe Rangfolge wie im HTTP-Guard: wer angemeldet ist, verbindet sich als er selbst und faellt nicht
   * wegen eines alten Gastcookies im selben Browser auf Gastrechte zurueck.
   */
  async function resolveRequester(request: IncomingMessage): Promise<Requester | 'second-factor-pending' | null> {
    const now = options.now()
    const auth = await resolveSignedIn(options.identity, options.config, request, now)
    if (auth !== null) {
      return auth.secondFactorPending ? 'second-factor-pending' : { kind: 'user', auth }
    }
    const guest = await resolveGuestSession(options.boards, options.config, request, now)
    return guest === null ? null : { kind: 'guest', guest }
  }

  /** Zaehlt je Zugang: beim Nutzer ueber alle seine Sitzungen, beim Gast ueber seine eine Gastsession. */
  function countForSession(requester: Requester): number {
    const sessionId = sessionIdOf(requester)
    const userId = requester.kind === 'user' ? requester.auth.user.id : null
    let offen = 0
    for (const connection of connections) {
      if (userId === null ? connection.sessionId === sessionId : connection.userId === userId) {
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

  /**
   * Nachpruefung der Sitzungen offener Verbindungen.
   *
   * Widerruf und Deaktivierung **in diesem Prozess** schliessen unmittelbar (`closeSession`, `closeUser`).
   * Ein Widerruf aus einem anderen Prozess - etwa der Betreiberbefehl zur Wiederherstellung des
   * Systemadmins - kommt hier nicht als Ereignis an; ohne diesen Lauf bliebe ein widerrufener Zugang auf
   * einem langlebigen Socket bis zum Ablauf der Sitzung bestehen. Eine Abfrage je Lauf fuer alle internen
   * Verbindungen; Gastsessions pruefen ihre Raeume selbst nach.
   */
  let revalidating = false
  async function closeRevokedSessions(now: Date): Promise<void> {
    const checked = new Set(
      [...connections].filter((connection) => connection.userId !== null).map((connection) => connection.sessionId),
    )
    if (checked.size === 0) {
      return
    }
    const live = await options.identity.sessions.findLiveIds([...checked], now)
    // Nur, was geprueft wurde: eine waehrend der Abfrage hinzugekommene Verbindung wartet auf den naechsten Lauf.
    closeMatching(
      (connection) => connection.userId !== null && checked.has(connection.sessionId) && !live.has(connection.sessionId),
    )
  }

  // Der Ablauf hat kein Ereignis und braucht deshalb eine wiederkehrende Pruefung; derselbe Lauf faengt einen
  // fremden Widerruf auf. `unref` haelt weder Prozess noch Tests offen.
  const expirySweep = setInterval(() => {
    const now = options.now()
    closeMatching((connection) => connection.expiresAt.getTime() <= now.getTime())
    if (revalidating) {
      return
    }
    revalidating = true
    void closeRevokedSessions(now)
      .catch((error: unknown) => {
        // Ein Datenbankfehler schliesst keine Verbindung: im Zweifel entscheidet der naechste Lauf.
        options.logger('warn', 'realtime.session.check.failed', { reason: String(error) })
      })
      .finally(() => {
        revalidating = false
      })
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
        // Node entfernt beim Ausloesen von `upgrade` seinen eigenen Fehlerzuhoerer vom Socket. Ohne den
        // eigenen wuerde ein Verbindungsabbruch waehrend der Sitzungsaufloesung als unbehandeltes
        // `error`-Ereignis den gesamten Prozess beenden - ausloesbar ohne jedes Konto.
        socket.on('error', (error: unknown) => {
          options.logger('warn', 'realtime.upgrade.socket-error', { reason: String(error) })
          socket.destroy()
        })
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
    closeShareLink(shareLinkId: BoardShareLinkId): void {
      closeMatching((connection) => connection.shareLinkId === shareLinkId)
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
