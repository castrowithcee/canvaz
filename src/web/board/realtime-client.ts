/**
 * Realtime-Client des Boardeditors.
 *
 * Duenne Schicht ueber `WebSocket`, genau wie `api.ts` eine duenne Schicht ueber `fetch` ist: Verbindung,
 * Zustandsmaschine, Buendelung und Wiederaufnahme. Fachlogik steht nicht hier - was ein Elementstand
 * bedeutet, entscheidet die Reconciliation, und was jemand darf, entscheidet der Server.
 *
 * **Gebuendelt wird auf dem Weg nach draussen.** Excalidraw meldet Aenderungen und Zeigerbewegungen in
 * Bildwiederholrate; ungebuendelt waeren das mehrere hundert Nachrichten je Sekunde. Der Client sammelt
 * stattdessen je Bündel den zuletzt bekannten Stand eines Elements und verschickt hoechstens alle 50 ms.
 * Weil die Reconciliation ueber `version` entscheidet und nicht ueber die Reihenfolge, geht dabei nichts
 * verloren: ein zurueckgehaltener Zwischenstand wird schlicht vom neueren ueberholt.
 *
 * ## Wiederaufnahme nach einem Abbruch
 *
 * Bricht die Verbindung ab, baut der Client sie mit **Rueckzugstakt** wieder auf: exponentiell wachsender
 * Abstand mit Obergrenze und Streuung. Die Streuung ist kein Beiwerk - ohne sie traefen nach einem
 * Serverneustart alle Browser gleichzeitig wieder ein.
 *
 * Nach dem erneuten Beitritt liefert der Server den **vollstaendigen** Raumzustand (`joined`), und der
 * Aufrufer schickt danach seine eigenen Elemente erneut. Verpasste Teilstuecke werden bewusst nicht
 * nachgefordert: waehrend der Trennung entstandene Aenderungen kennt nur diese Seite, und die
 * Reconciliation entscheidet je Element ueber `version` - ein aelterer Stand kann keinen neueren
 * verdraengen, egal in welcher Reihenfolge er ankommt.
 *
 * Nach einigen Schliessgruenden hilft kein neuer Versuch (`TERMINAL_CLOSE_CODES`): abgelaufene Sitzung,
 * entzogener Boardzugriff, zu viele Verbindungen, zu grosser Rahmen. Dann bleibt es beim Zustand
 * `getrennt`, und der Editor sichert wieder ueber die HTTP-Speicherung.
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
import { REALTIME_PROTOCOL_VERSION, TERMINAL_CLOSE_CODES } from '../../contracts/realtime.js'
import type { PersistedAppState, SyncElement } from '../../contracts/scene.js'

/** Abstand der Buendelung ausgehender Aenderungen und Zeigerstaende. */
const FLUSH_INTERVAL_MS = 50

/**
 * Hoechstzahl Elemente je ausgehender Nachricht.
 *
 * Im laufenden Betrieb faellt ein Element nach dem anderen an; viele auf einmal gibt es nur beim erneuten
 * Senden des eigenen Stands nach einer Wiederaufnahme. Aufgeteilt statt in einem Stueck: eine Nachricht
 * ueber der Rahmengrenze des Servers wuerde die frisch aufgebaute Verbindung sofort wieder beenden. Der
 * Wert liegt eine Groessenordnung unter der Elementgrenze des Servers.
 */
const MAX_ELEMENTS_PER_MESSAGE = 200

/**
 * Rueckzugstakt der Wiederverbindung.
 *
 * Verdopplung ab einer halben Sekunde bis zu 15 Sekunden. Die Streuung nimmt die halbe Wartezeit fest und
 * wuerfelt die andere Haelfte - damit bleibt ein Mindestabstand erhalten, und trotzdem treffen nicht alle
 * Browser im selben Augenblick ein.
 */
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000

/**
 * Ab wann ein Abbruch als "nicht verbunden" gilt.
 *
 * Ein kurzer Aussetzer soll nicht sofort die eigene Speicherung anwerfen: sie liefe gegen die Checkpoints
 * des Raums und erzeugte einen Konflikt, den es nicht gibt. Dauert die Trennung laenger, uebernimmt die
 * HTTP-Speicherung wieder - denn dann ist offen, wann der Raum wieder traegt.
 */
const OFFLINE_AFTER_MS = 5_000

export type RealtimeStatus =
  /** Erster Verbindungsaufbau. */
  | 'verbindet'
  /** Die Strecke steht. */
  | 'verbunden'
  /** Abgebrochen, ein neuer Versuch ist eingeplant, der Aussetzer ist noch kurz. */
  | 'wiederverbinden'
  /** Kein Verlass mehr auf die Strecke: entweder endgueltig oder laenger als `OFFLINE_AFTER_MS` weg. */
  | 'getrennt'

export type RealtimeHandlers = {
  /** `attempt` zaehlt die bisherigen erfolglosen Versuche; im Normalbetrieb ist er null. */
  onStatus(status: RealtimeStatus, attempt: number): void
  /** `wiederaufnahme` ist wahr, wenn dieser Beitritt auf einen Abbruch folgt. */
  onJoined(message: JoinedMessage, wiederaufnahme: boolean): void
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
  /** Hoechste lokale Aenderungskennung, die bereits zum Versand vorgemerkt wurde. */
  lastChangeSequence(): number
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
  let socket: WebSocket | null = null
  let joined = false
  let disposed = false
  /** Kein weiterer Versuch: ein Schliessgrund, an dem sich durch Wiederholen nichts aendert. */
  let endgueltig = false
  let attempt = 0
  /** Wahr, sobald einmal eine Verbindung stand - unterscheidet Wiederaufnahme von Erstverbindung. */
  let hatteVerbindung = false
  let reconnectTimer: number | null = null
  let offlineTimer: number | null = null

  /** Gesammelte Elemente des naechsten Buendels, je Kennung der zuletzt bekannte Stand. */
  const pendingElements = new Map<string, SyncElement>()
  let pendingAppState: PersistedAppState | null = null
  const pendingFileIds = new Set<string>()
  let nextChangeSequence = 0
  let pendingChangeSequence = 0
  type PendingPresence = {
    readonly pointer: { readonly x: number; readonly y: number } | null
    readonly selectedElementIds: readonly string[]
  }
  let pendingPresence: PendingPresence | null = null
  let flushTimer: number | null = null

  function melde(status: RealtimeStatus): void {
    if (!disposed) {
      handlers.onStatus(status, attempt)
    }
  }

  function post(message: unknown): void {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message))
    }
  }

  function flush(): void {
    flushTimer = null
    if (!joined) {
      return
    }
    if (pendingElements.size > 0 || pendingAppState !== null || pendingFileIds.size > 0) {
      // Aufgeteilt, damit keine Nachricht die Rahmengrenze des Servers reisst. Der Rest geht mit dem
      // naechsten Buendel; die Reconciliation ist auf Teilstuecke ohnehin ausgelegt.
      const elements: SyncElement[] = []
      for (const element of pendingElements.values()) {
        if (elements.length >= MAX_ELEMENTS_PER_MESSAGE) {
          break
        }
        elements.push(element)
      }
      for (const element of elements) {
        pendingElements.delete(element.id)
      }
      post({
        type: 'scene-change',
        boardId,
        elements,
        appState: pendingAppState,
        fileIds: [...pendingFileIds],
        clientChangeSequence: pendingChangeSequence,
      })
      pendingAppState = null
      pendingFileIds.clear()
      if (pendingElements.size > 0) {
        scheduleFlush()
      } else {
        pendingChangeSequence = 0
      }
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

  /** Exponentiell wachsend, gedeckelt, zur Haelfte gewuerfelt. */
  function backoffMs(): number {
    const gedeckelt = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1))
    return gedeckelt / 2 + Math.random() * (gedeckelt / 2)
  }

  function planeVersuch(): void {
    if (disposed || endgueltig || reconnectTimer !== null) {
      return
    }
    attempt += 1
    melde('wiederverbinden')
    if (offlineTimer === null) {
      // Ein kurzer Aussetzer bleibt "wiederverbinden"; erst danach gilt die Strecke als nicht verfuegbar.
      offlineTimer = window.setTimeout(() => {
        offlineTimer = null
        if (!disposed && joined === false) {
          melde('getrennt')
        }
      }, OFFLINE_AFTER_MS)
    }
    const wartezeit = backoffMs()
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      oeffne()
    }, wartezeit)
  }

  function oeffne(): void {
    if (disposed) {
      return
    }
    const aktuell = new WebSocket(realtimeUrl())
    socket = aktuell

    aktuell.addEventListener('open', () => {
      if (aktuell !== socket) {
        return
      }
      melde('verbunden')
      post({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId })
    })

    aktuell.addEventListener('message', (event: MessageEvent<string>) => {
      if (aktuell !== socket) {
        return
      }
      let message: ServerMessage
      try {
        message = JSON.parse(event.data) as ServerMessage
      } catch {
        return
      }
      switch (message.type) {
        case 'joined': {
          const wiederaufnahme = hatteVerbindung
          joined = true
          hatteVerbindung = true
          attempt = 0
          if (offlineTimer !== null) {
            window.clearTimeout(offlineTimer)
            offlineTimer = null
          }
          melde('verbunden')
          handlers.onJoined(message, wiederaufnahme)
          // Was vor dem Beitritt gezeichnet wurde, liegt noch im Buendel und geht jetzt raus.
          scheduleFlush()
          return
        }
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
          if (message.code === 'protokoll-version') {
            // Ein neuer Versuch spraeche dieselbe alte Sprache. Der Mensch muss neu laden.
            endgueltig = true
          }
          handlers.onError(message)
          return
        case 'ready':
          return
      }
    })

    aktuell.addEventListener('close', (event: CloseEvent) => {
      if (aktuell !== socket) {
        return
      }
      joined = false
      socket = null
      if (disposed) {
        return
      }
      if (TERMINAL_CLOSE_CODES.includes(event.code)) {
        endgueltig = true
        melde('getrennt')
        return
      }
      planeVersuch()
    })
  }

  melde('verbindet')
  oeffne()

  return {
    sendChange(elements, appState, fileIds): void {
      nextChangeSequence += 1
      pendingChangeSequence = nextChangeSequence
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
    lastChangeSequence(): number {
      return nextChangeSequence
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
      for (const timer of [flushTimer, reconnectTimer, offlineTimer]) {
        if (timer !== null) {
          window.clearTimeout(timer)
        }
      }
      flushTimer = null
      reconnectTimer = null
      offlineTimer = null
      socket?.close()
      socket = null
    },
  }
}
