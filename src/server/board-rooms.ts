/**
 * Boardraeume: autorisierter Beitritt, Fanout, Presence und persistente Checkpoints.
 *
 * Ein Raum je Board, ausschliesslich im Speicher dieser einen Instanz. Es gibt bewusst kein Redis und keine
 * Koordination ueber Prozessgrenzen: die Zielgroesse sind fuenf gleichzeitige Bearbeiter auf einem Board.
 *
 * ## Die WebSocket-Grenze prueft nicht schwaecher als die HTTP-API
 *
 * Jede eingehende Nachricht geht durch `parseClientMessage`, wird gegen den Verbindungszustand und den
 * beigetretenen Raum geprueft, und **jede schreibende Nachricht loest die Berechtigung frisch ueber
 * `decideBoardAccess` auf** - dieselbe Funktion, die auch die Routen benutzen. Nichts wird
 * zwischengespeichert; ein Rollenentzug wirkt deshalb auf die naechste Nachricht und spaetestens mit dem
 * Wiederholungslauf auf jede stille Verbindung.
 *
 * ## Andockpunkt fuer Issue 6
 *
 * `resolveAccess` ist die einzige Stelle, an der aus einer Verbindung eine Berechtigung wird. Dort kommen
 * `boardRole` und die Gastberechtigung in den `PolicySubject`, und dort wuerde ein Gast statt einer internen
 * Serversession stehen. Das Protokoll aendert sich dafuer nicht.
 *
 * ## Was hier bewusst noch nicht steht
 *
 * Reconnect-Haertung, Heartbeat, feingranulare Nachrichtenlimits und Backpressure liefert das folgende
 * Paket. Die Nahtstellen dafuer sind `resync`/`snapshot`, die Groessengrenze am WebSocket-Server und die
 * eine Stelle `send`, ueber die jede ausgehende Nachricht laeuft.
 */

import { randomUUID } from 'node:crypto'

import type { WebSocket } from 'ws'

import type { ClientMessage, PresenceView, RealtimeErrorCode, ServerMessage } from '../contracts/realtime.js'
import {
  BOARD_ACCESS_REVOKED_CLOSE_CODE,
  REALTIME_ERROR_MESSAGES,
  REALTIME_PROTOCOL_VERSION,
  parseClientMessage,
} from '../contracts/realtime.js'
import type { BinaryFileRef, PersistedAppState, SceneSnapshot, SyncElement } from '../contracts/scene.js'
import { SCENE_SCHEMA_VERSION, createEmptySnapshot, findUnstorableValue } from '../contracts/scene.js'
import type { BoardId } from '../domain/board/model.js'
import { SCENE_VERSION_RETENTION } from '../domain/board/model.js'
import { decideBoardAccess } from '../domain/board/policy.js'
import type { BoardStore } from '../domain/board/repositories.js'
import { CorruptSceneError, SceneConflictError } from '../domain/board/repositories.js'
import { reconcileElements } from '../domain/board/reconcile.js'
import type { AuthenticatedSession } from '../domain/identity/model.js'
import type { Logger } from './log.js'

/**
 * Takt der Checkpoints.
 *
 * `IDLE` schreibt kurz nach der letzten Aenderung, damit eine abgeschlossene Zeichnung sofort sicher ist.
 * `MAX` begrenzt den Verlust bei durchgehendem Zeichnen: laenger als zehn Sekunden Arbeit darf ein Absturz
 * nie kosten. Zusammen ergeben sie deutlich weniger Versionen als eine Speicherung je Aenderung - die
 * Historie bleibt lesbar und `scene_versions` waechst nicht mit jedem Mausklick.
 */
const CHECKPOINT_IDLE_MS = 2_000
const CHECKPOINT_MAX_MS = 10_000

/**
 * Buendelung der Presence.
 *
 * Excalidraw meldet Zeigerbewegungen in Bildwiederholrate. Ungebuendelt waeren das bei fuenf Bearbeitern
 * mehrere hundert Nachrichten je Sekunde und Teilnehmer. Der Raum sammelt stattdessen den jeweils letzten
 * Stand und verschickt hoechstens zehnmal je Sekunde **ein** vollstaendiges Teilnehmerfeld. Das ist unter
 * der Wahrnehmungsschwelle fuer einen Mauszeiger und kostet unabhaengig von der Zahl der Bewegungen.
 */
const PRESENCE_INTERVAL_MS = 100

/**
 * Abstand der Berechtigungspruefung stiller Verbindungen.
 *
 * Wer schreibt, wird ohnehin bei jeder Nachricht geprueft. Eine offene, aber stille Verbindung braucht
 * diesen Lauf, damit ein Mitgliedschaftsentzug oder eine Archivierung sie beendet oder herabstuft, ohne dass
 * sich der Nutzer neu anmelden muss.
 */
const ACCESS_CHECK_INTERVAL_MS = 2_000

export type BoardRoomOptions = {
  readonly boards: BoardStore
  readonly logger: Logger
  readonly now: () => Date
  /** Tests setzen die Takte kurz; im Betrieb gelten die Konstanten oben. */
  readonly checkpointIdleMs?: number
  readonly checkpointMaxMs?: number
  readonly presenceIntervalMs?: number
  readonly accessCheckIntervalMs?: number
}

export type BoardRooms = {
  /** Passt auf `RealtimeOptions.onConnection`. */
  onConnection(socket: WebSocket, auth: AuthenticatedSession): void
  /** Offene Raeume; ausschliesslich fuer Tests und Diagnose. */
  readonly roomCount: number
  close(): Promise<void>
}

type Room = {
  readonly boardId: BoardId
  /** Vollstaendiger geteilter Zustand einschliesslich Tombstones. */
  elements: readonly SyncElement[]
  appState: PersistedAppState
  files: Record<string, BinaryFileRef>
  /** Zuletzt **persistierte** Version. Der Raum kennt keine eigene Zaehlung. */
  version: number
  dirty: boolean
  saving: boolean
  /** Zeitpunkt der ersten unpersistierten Aenderung; Grundlage der Obergrenze des Takts. */
  firstDirtyAt: number | null
  /**
   * Wer die letzte angenommene Aenderung beigetragen hat. Er ist der Autor des naechsten Checkpoints, und
   * seine Berechtigung wird beim Schreiben unter der Zeilensperre erneut geprueft.
   */
  lastAuthor: AuthenticatedSession['user'] | null
  checkpointTimer: NodeJS.Timeout | null
  presenceTimer: NodeJS.Timeout | null
  readonly participants: Set<Participant>
}

type Participant = {
  readonly clientId: string
  readonly socket: WebSocket
  readonly auth: AuthenticatedSession
  /** `null` heisst: verbunden, aber in keinem Raum. Das ist der Zustand direkt nach dem Upgrade. */
  room: Room | null
  canWrite: boolean
  pointer: PresenceView['pointer']
  selectedElementIds: readonly string[]
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message))
  }
}

function sendError(socket: WebSocket, code: RealtimeErrorCode): void {
  send(socket, { type: 'error', code, message: REALTIME_ERROR_MESSAGES[code] })
}

function presenceOf(participant: Participant): PresenceView {
  return {
    clientId: participant.clientId,
    displayName: participant.auth.user.displayName,
    canWrite: participant.canWrite,
    pointer: participant.pointer,
    selectedElementIds: participant.selectedElementIds,
  }
}

/** Gleichheit der persistierten Teilmenge. Vier Felder, deshalb ein Vergleich statt einer Bibliothek. */
function sameAppState(left: PersistedAppState, right: PersistedAppState): boolean {
  return (
    left.viewBackgroundColor === right.viewBackgroundColor &&
    left.gridSize === right.gridSize &&
    left.gridModeEnabled === right.gridModeEnabled &&
    left.name === right.name
  )
}

function snapshotOf(room: Room, updatedAt: number): SceneSnapshot {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    boardId: room.boardId,
    elements: room.elements,
    appState: room.appState,
    files: room.files,
    updatedAt,
  }
}

/** Effektive Berechtigung einer Verbindung fuer genau ein Board. */
type BoardPermission = { readonly read: boolean; readonly write: boolean }

const NO_ACCESS: BoardPermission = { read: false, write: false }

export function createBoardRooms(options: BoardRoomOptions): BoardRooms {
  const { boards: store, logger, now } = options
  const checkpointIdleMs = options.checkpointIdleMs ?? CHECKPOINT_IDLE_MS
  const checkpointMaxMs = options.checkpointMaxMs ?? CHECKPOINT_MAX_MS
  const presenceIntervalMs = options.presenceIntervalMs ?? PRESENCE_INTERVAL_MS

  const rooms = new Map<BoardId, Room>()
  /** Gleichzeitige Beitritte in denselben, noch nicht geladenen Raum sollen ihn nicht doppelt laden. */
  const loading = new Map<BoardId, Promise<Room | RealtimeErrorCode>>()
  let closed = false

  /**
   * Einzige Stelle, an der aus einer Verbindung eine Berechtigung wird.
   *
   * Liest bei **jedem** Aufruf frisch und speichert nichts zwischen. Issue 6 ergaenzt hier `boardRole` und
   * die Gastberechtigung im `PolicySubject`; Aufrufform und Protokoll bleiben unveraendert.
   */
  async function resolveAccess(auth: AuthenticatedSession, boardId: BoardId): Promise<BoardPermission> {
    const access = await store.boards.findForUser(boardId, auth.user.id)
    if (access === null) {
      return NO_ACCESS
    }
    const subject = { user: auth.user, workspaceRole: access.role }
    if (!decideBoardAccess(subject, access.workspace, access.board, 'board:read').allowed) {
      // Wer nicht lesen darf, erfaehrt nicht, ob es das Board gibt.
      return NO_ACCESS
    }
    return { read: true, write: decideBoardAccess(subject, access.workspace, access.board, 'scene:write').allowed }
  }

  function schedulePresence(room: Room): void {
    if (room.presenceTimer !== null) {
      return
    }
    room.presenceTimer = setTimeout(() => {
      room.presenceTimer = null
      const peers = [...room.participants].map(presenceOf)
      for (const participant of room.participants) {
        send(participant.socket, { type: 'presence', boardId: room.boardId, peers })
      }
    }, presenceIntervalMs)
    room.presenceTimer.unref()
  }

  function scheduleCheckpoint(room: Room): void {
    if (room.checkpointTimer !== null) {
      clearTimeout(room.checkpointTimer)
    }
    const elapsed = room.firstDirtyAt === null ? 0 : now().getTime() - room.firstDirtyAt
    const delay = Math.max(0, Math.min(checkpointIdleMs, checkpointMaxMs - elapsed))
    room.checkpointTimer = setTimeout(() => {
      room.checkpointTimer = null
      void checkpoint(room)
    }, delay)
    room.checkpointTimer.unref()
  }

  /**
   * Schreibt den Raumzustand ueber genau den Weg, den auch die HTTP-Speicherung nimmt: Transaktion,
   * Zeilensperre, Berechtigungspruefung, `append` auf der naechsten Version.
   *
   * **Ein Checkpoint kann keinen neueren Stand ueberschreiben.** Hat inzwischen jemand ueber die HTTP-API
   * gespeichert, steht in `boards.current_scene_version` eine hoehere Nummer; dann wird der persistierte
   * Stand zuerst in den Raum zusammengefuehrt und erst danach die naechste Version geschrieben. Die
   * Reconciliation entscheidet dabei je Element, nicht der Zeitpunkt der Speicherung.
   */
  async function checkpoint(room: Room): Promise<void> {
    if (!room.dirty || room.saving || room.lastAuthor === null) {
      return
    }
    const author = room.lastAuthor
    room.saving = true
    try {
      const result = await store.transaction(async (tx) => {
        const access = await tx.boards.findForUpdate(room.boardId, author.id)
        if (access === null) {
          return { kind: 'denied', reason: 'not-visible' } as const
        }
        // Dieselbe Entscheidung wie in der HTTP-Route, mit demselben Subjekt aus Nutzer und Workspacerolle.
        // Die Rolle wird hier frisch unter der Zeilensperre gelesen; eine Deaktivierung schliesst die
        // Verbindung bereits ueber die Sitzungsebene.
        const decision = decideBoardAccess(
          { user: author, workspaceRole: access.role },
          access.workspace,
          access.board,
          'scene:write',
        )
        if (!decision.allowed) {
          return { kind: 'denied', reason: decision.reason } as const
        }
        if (access.board.sceneVersion !== room.version) {
          // Zwischen zwei Checkpoints wurde ueber die HTTP-API gespeichert. Der fremde Stand kommt zuerst in
          // den Raum; erst danach entsteht die naechste Version.
          const latest = await tx.scenes.findLatest(room.boardId)
          if (latest !== null) {
            room.elements = reconcileElements(latest.snapshot.elements, room.elements).elements
            room.files = { ...latest.snapshot.files, ...room.files }
          }
          room.version = access.board.sceneVersion
        }
        const version = room.version + 1
        const snapshot = snapshotOf(room, now().getTime())
        const saved = await tx.scenes.append(room.boardId, version, snapshot, author.id)
        await tx.boards.setSceneVersion(room.boardId, version)
        await tx.scenes.prune(room.boardId, SCENE_VERSION_RETENTION)
        return { kind: 'saved', version, savedAt: saved.createdAt } as const
      })
      if (result.kind === 'denied') {
        // Der Zustand bleibt unpersistiert und der Raum bleibt "dirty". Ein neuer Checkpoint entsteht erst
        // wieder mit der naechsten angenommenen Aenderung - also erst, wenn wieder jemand schreiben darf.
        logger('warn', 'board.checkpoint.denied', { boardId: room.boardId, reason: result.reason })
        return
      }
      room.version = result.version
      room.dirty = false
      room.firstDirtyAt = null
      const savedAt = result.savedAt.toISOString()
      for (const participant of room.participants) {
        send(participant.socket, { type: 'saved', boardId: room.boardId, version: result.version, savedAt })
      }
      logger('info', 'board.checkpoint.saved', { boardId: room.boardId, version: result.version })
    } catch (error) {
      if (error instanceof SceneConflictError) {
        // Dieselbe Version wurde parallel angelegt. Der naechste Lauf setzt auf dem dann sichtbaren Stand auf.
        logger('warn', 'board.checkpoint.conflict', { boardId: room.boardId, version: room.version })
      } else {
        logger('error', 'board.checkpoint.failed', { boardId: room.boardId, reason: String(error) })
      }
      scheduleCheckpoint(room)
    } finally {
      room.saving = false
    }
  }

  async function loadRoom(boardId: BoardId): Promise<Room | RealtimeErrorCode> {
    let latest
    try {
      latest = await store.scenes.findLatest(boardId)
    } catch (error) {
      if (!(error instanceof CorruptSceneError)) {
        throw error
      }
      // Ein beschaedigter Stand wird gemeldet, nie als leeres Board geoeffnet - sonst wuerde der erste
      // Checkpoint die Zeichnung endgueltig ueberschreiben.
      logger('error', 'board.scene.corrupt', { boardId, version: error.version })
      return 'szene-beschaedigt'
    }
    const snapshot = latest?.snapshot ?? createEmptySnapshot(boardId, now().getTime())
    return {
      boardId,
      elements: snapshot.elements,
      appState: snapshot.appState,
      files: { ...snapshot.files },
      version: latest?.version ?? 0,
      dirty: false,
      saving: false,
      firstDirtyAt: null,
      lastAuthor: null,
      checkpointTimer: null,
      presenceTimer: null,
      participants: new Set(),
    }
  }

  async function obtainRoom(boardId: BoardId): Promise<Room | RealtimeErrorCode> {
    const existing = rooms.get(boardId)
    if (existing !== undefined) {
      return existing
    }
    const inflight = loading.get(boardId)
    if (inflight !== undefined) {
      const loaded = await inflight
      return typeof loaded === 'string' ? loaded : (rooms.get(boardId) ?? loaded)
    }
    const pending = loadRoom(boardId)
    loading.set(boardId, pending)
    try {
      const loaded = await pending
      if (typeof loaded !== 'string') {
        rooms.set(boardId, loaded)
      }
      return loaded
    } finally {
      loading.delete(boardId)
    }
  }

  /** Entfernt einen Teilnehmer aus seinem Raum und raeumt den Raum auf, wenn er der letzte war. */
  function leaveRoom(participant: Participant): void {
    const room = participant.room
    if (room === null) {
      return
    }
    participant.room = null
    participant.pointer = null
    participant.selectedElementIds = []
    room.participants.delete(participant)
    if (room.participants.size > 0) {
      schedulePresence(room)
      return
    }
    if (room.presenceTimer !== null) {
      clearTimeout(room.presenceTimer)
      room.presenceTimer = null
    }
    if (room.checkpointTimer !== null) {
      clearTimeout(room.checkpointTimer)
      room.checkpointTimer = null
    }
    rooms.delete(room.boardId)
    if (room.dirty) {
      // Der letzte Teilnehmer geht: was noch nicht persistiert ist, wird jetzt geschrieben und nicht erst
      // beim naechsten Takt - den gaebe es nicht mehr.
      void checkpoint(room)
    }
  }

  async function handleJoin(participant: Participant, boardId: BoardId, protocolVersion: number): Promise<void> {
    if (protocolVersion !== REALTIME_PROTOCOL_VERSION) {
      sendError(participant.socket, 'protokoll-version')
      return
    }
    if (participant.room !== null) {
      sendError(participant.socket, 'falscher-zustand')
      return
    }
    const permission = await resolveAccess(participant.auth, boardId)
    if (!permission.read) {
      logger('warn', 'realtime.join.denied', { userId: participant.auth.user.id, boardId })
      sendError(participant.socket, 'board-nicht-gefunden')
      return
    }
    const room = await obtainRoom(boardId)
    if (typeof room === 'string') {
      sendError(participant.socket, room)
      return
    }
    if (participant.socket.readyState !== participant.socket.OPEN || participant.room !== null) {
      // Waehrend der Aufloesung geschlossen. Ein gerade erst geladener, leerer Raum wird wieder abgeraeumt,
      // sonst bliebe er ohne Teilnehmer im Speicher stehen.
      if (room.participants.size === 0) {
        rooms.delete(room.boardId)
      }
      return
    }
    participant.room = room
    participant.canWrite = permission.write
    room.participants.add(participant)
    send(participant.socket, {
      type: 'joined',
      boardId,
      clientId: participant.clientId,
      canWrite: permission.write,
      version: room.version,
      scene: snapshotOf(room, now().getTime()),
      peers: [...room.participants].map(presenceOf),
    })
    logger('info', 'realtime.join.accepted', { userId: participant.auth.user.id, boardId, canWrite: permission.write })
    schedulePresence(room)
  }

  /**
   * Loest die Kennungen neuer Bilddateien gegen `board_assets` auf.
   *
   * Der Client nennt nur Kennungen. Groesse, Typ und Speicherschluessel kommen aus der Datenbank - eine
   * erfundene Referenz erreicht damit weder ein fremdes Asset noch einen falschen Eintrag in der Szene.
   */
  async function resolveFiles(room: Room, fileIds: readonly string[]): Promise<readonly BinaryFileRef[]> {
    const added: BinaryFileRef[] = []
    for (const fileId of fileIds) {
      if (Object.hasOwn(room.files, fileId)) {
        continue
      }
      const asset = await store.assets.findByFileId(room.boardId, fileId)
      if (asset === null) {
        continue
      }
      const ref: BinaryFileRef = {
        id: asset.fileId,
        mimeType: asset.mimeType,
        created: asset.createdAt.getTime(),
        byteSize: asset.byteSize,
        storageKey: asset.storageKey,
      }
      room.files = { ...room.files, [ref.id]: ref }
      added.push(ref)
    }
    return added
  }

  async function handleSceneChange(
    participant: Participant,
    room: Room,
    message: Extract<ClientMessage, { type: 'scene-change' }>,
  ): Promise<void> {
    // Schreibrecht wird bei **jeder** Aenderungsnachricht neu aufgeloest, nicht nur beim Beitritt.
    const permission = await resolveAccess(participant.auth, room.boardId)
    if (!permission.read) {
      revoke(participant)
      return
    }
    if (permission.write !== participant.canWrite) {
      participant.canWrite = permission.write
      send(participant.socket, { type: 'access', boardId: room.boardId, canWrite: permission.write })
      schedulePresence(room)
    }
    if (!permission.write) {
      logger('warn', 'realtime.change.denied', { userId: participant.auth.user.id, boardId: room.boardId })
      sendError(participant.socket, 'kein-schreibrecht')
      return
    }
    if (findUnstorableValue(message.elements) !== null || findUnstorableValue(message.appState) !== null) {
      sendError(participant.socket, 'nicht-speicherbar')
      return
    }
    if (participant.room !== room) {
      // Waehrend der Aufloesung verlassen oder geschlossen.
      return
    }
    const { elements, appliedIds } = reconcileElements(room.elements, message.elements)
    const appStateChanged = message.appState !== null && !sameAppState(room.appState, message.appState)
    room.elements = elements
    if (message.appState !== null) {
      room.appState = message.appState
    }
    const files = await resolveFiles(room, message.fileIds)
    if (appliedIds.size === 0 && !appStateChanged && files.length === 0) {
      // Eine verspaetete Nachricht mit aelterer Version aendert nichts und wird auch nicht weitergegeben.
      return
    }
    room.dirty = true
    room.firstDirtyAt ??= now().getTime()
    room.lastAuthor = participant.auth.user
    scheduleCheckpoint(room)
    const applied = message.elements.filter((element) => appliedIds.has(element.id))
    const broadcast: ServerMessage = {
      type: 'scene-change',
      boardId: room.boardId,
      elements: applied,
      appState: message.appState,
      files,
    }
    for (const peer of room.participants) {
      // Nie an den Absender zurueck: er hat den Stand bereits und wuerde ihn nur erneut verarbeiten.
      if (peer !== participant) {
        send(peer.socket, broadcast)
      }
    }
  }

  /** Zugriff entzogen: der Raum ist verloren, die Sitzung selbst bleibt gueltig. */
  function revoke(participant: Participant): void {
    logger('warn', 'realtime.access.revoked', {
      userId: participant.auth.user.id,
      boardId: participant.room?.boardId ?? '',
    })
    leaveRoom(participant)
    sendError(participant.socket, 'board-nicht-gefunden')
    participant.socket.close(BOARD_ACCESS_REVOKED_CLOSE_CODE, 'Zugriff entzogen')
  }

  async function handle(participant: Participant, message: ClientMessage): Promise<void> {
    if (message.type === 'join') {
      await handleJoin(participant, message.boardId, message.protocolVersion)
      return
    }
    const room = participant.room
    if (room === null) {
      sendError(participant.socket, 'falscher-zustand')
      return
    }
    if (message.boardId !== room.boardId) {
      // Fremder Boardbezug in einer Nachricht: abgewiesen, ohne den Raum zu wechseln oder zu verlassen.
      sendError(participant.socket, 'board-nicht-gefunden')
      return
    }
    switch (message.type) {
      case 'leave':
        leaveRoom(participant)
        send(participant.socket, { type: 'left', boardId: room.boardId })
        return
      case 'resync':
        send(participant.socket, {
          type: 'snapshot',
          boardId: room.boardId,
          version: room.version,
          scene: snapshotOf(room, now().getTime()),
        })
        return
      case 'presence':
        // Presence aendert den Boardzustand nicht; sie setzt Raummitgliedschaft voraus, die beim Beitritt
        // geprueft und durch den Wiederholungslauf laufend bestaetigt wird.
        participant.pointer = message.pointer
        participant.selectedElementIds = message.selectedElementIds
        schedulePresence(room)
        return
      case 'scene-change':
        await handleSceneChange(participant, room, message)
        return
    }
  }

  /**
   * Wiederholungslauf fuer stille Verbindungen.
   *
   * Wer schreibt, wird bei jeder Nachricht geprueft. Ohne diesen Lauf bliebe eine offene, aber stille
   * Verbindung nach einem Mitgliedschaftsentzug im Raum und bekaeme weiter jede fremde Zeichnung.
   */
  async function recheckAccess(): Promise<void> {
    for (const room of [...rooms.values()]) {
      for (const participant of [...room.participants]) {
        const permission = await resolveAccess(participant.auth, room.boardId)
        if (!permission.read) {
          revoke(participant)
          continue
        }
        if (permission.write !== participant.canWrite) {
          participant.canWrite = permission.write
          send(participant.socket, { type: 'access', boardId: room.boardId, canWrite: permission.write })
          schedulePresence(room)
        }
      }
    }
  }

  const accessSweep = setInterval(() => {
    void recheckAccess().catch((error: unknown) => {
      logger('error', 'realtime.access.check.failed', { reason: String(error) })
    })
  }, options.accessCheckIntervalMs ?? ACCESS_CHECK_INTERVAL_MS)
  accessSweep.unref()

  return {
    onConnection(socket: WebSocket, auth: AuthenticatedSession): void {
      const participant: Participant = {
        clientId: randomUUID(),
        socket,
        auth,
        room: null,
        canWrite: false,
        pointer: null,
        selectedElementIds: [],
      }
      /**
       * Nachrichten einer Verbindung werden **nacheinander** abgearbeitet.
       *
       * Zwei Gruende: die Reihenfolge des Absenders bleibt erhalten, und das Schliessen wartet auf die
       * gerade laufende Nachricht. Ohne das ginge eine Aenderung verloren, die genau im Moment des
       * Verbindungsabbruchs noch unterwegs war - der Raum waere abgeraeumt, bevor sie ankommt.
       */
      let pending: Promise<void> = Promise.resolve()
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          sendError(socket, 'ungueltige-nachricht')
          return
        }
        const parsed = parseClientMessage(data.toString('utf8'))
        if (!parsed.ok) {
          sendError(socket, parsed.code)
          return
        }
        pending = pending
          .then(() => handle(participant, parsed.message))
          .catch((error: unknown) => {
            logger('error', 'realtime.message.failed', { userId: auth.user.id, reason: String(error) })
            leaveRoom(participant)
            socket.close(1011, 'Serverfehler')
          })
      })
      socket.on('close', () => {
        void pending.then(() => {
          leaveRoom(participant)
        })
      })
    },
    get roomCount(): number {
      return rooms.size
    },
    async close(): Promise<void> {
      if (closed) {
        return
      }
      closed = true
      clearInterval(accessSweep)
      const open = [...rooms.values()]
      for (const room of open) {
        if (room.presenceTimer !== null) {
          clearTimeout(room.presenceTimer)
          room.presenceTimer = null
        }
        if (room.checkpointTimer !== null) {
          clearTimeout(room.checkpointTimer)
          room.checkpointTimer = null
        }
      }
      // Beim geordneten Herunterfahren geht nichts verloren: alles Unpersistierte wird noch geschrieben.
      await Promise.all(open.map((room) => checkpoint(room)))
      rooms.clear()
    },
  }
}
