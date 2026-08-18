/**
 * Realtime-Client des Boardeditors.
 *
 * Duenne Schicht ueber `WebSocket`, genau wie `api.ts` eine duenne Schicht ueber `fetch` ist: Verbindung,
 * Zustandsmaschine und Buendelung. Fachlogik steht nicht hier - was ein Elementstand bedeutet, entscheidet
 * die Reconciliation, und was jemand darf, entscheidet der Server.
 *
 * **Gebuendelt wird auf dem Weg nach draussen.** Excalidraw meldet Aenderungen und Zeigerbewegungen in
 * Bildwiederholrate; ungebuendelt waeren das mehrere hundert Nachrichten je Sekunde. Der Client sammelt
 * stattdessen je Bündel den zuletzt bekannten Stand eines Elements und verschickt hoechstens alle 50 ms.
 * Weil die Reconciliation ueber `version` entscheidet und nicht ueber die Reihenfolge, geht dabei nichts
 * verloren: ein zurueckgehaltener Zwischenstand wird schlicht vom neueren ueberholt.
 *
 * Reconnect, Heartbeat und Backpressure sind bewusst nicht hier: sie kommen im folgenden Paket. Diese Datei
 * meldet einen Abbruch als Zustand nach aussen, damit die Oberflaeche ihn zeigen und die Speicherung ueber
 * die HTTP-API weiterlaufen kann.
 */

import { REALTIME_PATH } from '../../contracts/api.js'
import type {
  JoinedMessage,
  PresenceView,
  SavedMessage,
  SceneBroadcastMessage,
  ServerMessage,
  SnapshotMessage,
} from '../../contracts/realtime.js'
import { REALTIME_PROTOCOL_VERSION } from '../../contracts/realtime.js'
import type { PersistedAppState, SyncElement } from '../../contracts/scene.js'

/** Abstand der Buendelung ausgehender Aenderungen und Zeigerstaende. */
const FLUSH_INTERVAL_MS = 50

export type RealtimeStatus = 'verbindet' | 'verbunden' | 'getrennt'

export type RealtimeHandlers = {
  onStatus(status: RealtimeStatus): void
  onJoined(message: JoinedMessage): void
  onSnapshot(message: SnapshotMessage): void
  onSceneChange(message: SceneBroadcastMessage): void
  onPresence(peers: readonly PresenceView[]): void
  onAccess(canWrite: boolean): void
  onSaved(message: SavedMessage): void
  onError(message: Extract<ServerMessage, { type: 'error' }>): void
}

export type BoardRealtime = {
  /** Sammelt die Aenderung und verschickt sie mit dem naechsten Buendel. */
  sendChange(elements: readonly SyncElement[], appState: PersistedAppState | null, fileIds: readonly string[]): void
  sendPresence(pointer: { readonly x: number; readonly y: number } | null, selectedElementIds: readonly string[]): void
  /** Bittet um den vollstaendigen Raumzustand. */
  requestSnapshot(): void
  close(): void
}

function realtimeUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}${REALTIME_PATH}`
}

export function connectBoardRealtime(boardId: string, handlers: RealtimeHandlers): BoardRealtime {
  const socket = new WebSocket(realtimeUrl())
  let joined = false
  let disposed = false

  /** Gesammelte Elemente des naechsten Buendels, je Kennung der zuletzt bekannte Stand. */
  const pendingElements = new Map<string, SyncElement>()
  let pendingAppState: PersistedAppState | null = null
  const pendingFileIds = new Set<string>()
  type PendingPresence = {
    readonly pointer: { readonly x: number; readonly y: number } | null
    readonly selectedElementIds: readonly string[]
  }
  let pendingPresence: PendingPresence | null = null
  let flushTimer: number | null = null

  function post(message: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message))
    }
  }

  function flush(): void {
    flushTimer = null
    if (!joined) {
      return
    }
    if (pendingElements.size > 0 || pendingAppState !== null || pendingFileIds.size > 0) {
      post({
        type: 'scene-change',
        boardId,
        elements: [...pendingElements.values()],
        appState: pendingAppState,
        fileIds: [...pendingFileIds],
      })
      pendingElements.clear()
      pendingAppState = null
      pendingFileIds.clear()
    }
    if (pendingPresence !== null) {
      post({ type: 'presence', boardId, ...pendingPresence })
      pendingPresence = null
    }
  }

  function scheduleFlush(): void {
    if (flushTimer === null) {
      flushTimer = window.setTimeout(flush, FLUSH_INTERVAL_MS)
    }
  }

  socket.addEventListener('open', () => {
    handlers.onStatus('verbunden')
    post({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId })
  })

  socket.addEventListener('message', (event: MessageEvent<string>) => {
    let message: ServerMessage
    try {
      message = JSON.parse(event.data) as ServerMessage
    } catch {
      return
    }
    switch (message.type) {
      case 'joined':
        joined = true
        handlers.onJoined(message)
        // Was vor dem Beitritt gezeichnet wurde, liegt noch im Buendel und geht jetzt raus.
        scheduleFlush()
        return
      case 'snapshot':
        handlers.onSnapshot(message)
        return
      case 'scene-change':
        handlers.onSceneChange(message)
        return
      case 'presence':
        handlers.onPresence(message.peers)
        return
      case 'access':
        handlers.onAccess(message.canWrite)
        return
      case 'saved':
        handlers.onSaved(message)
        return
      case 'left':
        joined = false
        return
      case 'error':
        handlers.onError(message)
        return
      case 'ready':
        return
    }
  })

  const ende = () => {
    joined = false
    if (!disposed) {
      handlers.onStatus('getrennt')
    }
  }
  socket.addEventListener('close', ende)
  socket.addEventListener('error', ende)

  handlers.onStatus('verbindet')

  return {
    sendChange(elements, appState, fileIds): void {
      for (const element of elements) {
        pendingElements.set(element.id, element)
      }
      if (appState !== null) {
        pendingAppState = appState
      }
      for (const fileId of fileIds) {
        pendingFileIds.add(fileId)
      }
      scheduleFlush()
    },
    sendPresence(pointer, selectedElementIds): void {
      pendingPresence = { pointer, selectedElementIds }
      scheduleFlush()
    },
    requestSnapshot(): void {
      post({ type: 'resync', boardId })
    },
    close(): void {
      disposed = true
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
      socket.close()
    },
  }
}
