/**
 * WebSocket-Client der Kollaboration.
 *
 * Buendelt lokale Aenderungen, haelt die Verbindung ueber einen Backoff und laedt nach jedem Reconnect den
 * vollstaendigen Serverzustand nach, statt auf verpasste Deltas zu hoffen.
 */

import type { PersistedAppState, BinaryFileRef, SyncElement } from '../shared/scene.js'
import type { ClientMessage, Peer, Pointer, ServerMessage } from '../shared/protocol.js'
import { encodeMessage } from '../shared/protocol.js'

export type ConnectionStatus = 'connecting' | 'online' | 'offline'

export type CollabHandlers = {
  onWelcome(message: Extract<ServerMessage, { type: 'welcome' }>): void
  onSceneUpdate(elements: readonly SyncElement[]): void
  onAppState(appState: PersistedAppState): void
  onFileRef(file: BinaryFileRef): void
  onPresence(peers: readonly Peer[]): void
  onPointer(clientId: string, pointer: Pointer): void
  onRejected(code: string, message: string): void
  onStatus(status: ConnectionStatus): void
}

const FLUSH_INTERVAL_MS = 50
const MAX_BACKOFF_MS = 5_000

export class CollabClient {
  readonly #url: string
  readonly #handlers: CollabHandlers
  readonly #pendingElements = new Map<string, SyncElement>()
  #socket: WebSocket | null = null
  #flushTimer: ReturnType<typeof setTimeout> | null = null
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #attempt = 0
  #closedByUser = false

  constructor(url: string, handlers: CollabHandlers) {
    this.#url = url
    this.#handlers = handlers
  }

  connect(): void {
    this.#closedByUser = false
    this.#handlers.onStatus('connecting')
    const socket = new WebSocket(this.#url)
    this.#socket = socket

    socket.addEventListener('open', () => {
      this.#attempt = 0
      this.#handlers.onStatus('online')
    })

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as ServerMessage
      switch (message.type) {
        case 'welcome':
          this.#handlers.onWelcome(message)
          return
        case 'scene-update':
          this.#handlers.onSceneUpdate(message.elements)
          return
        case 'app-state-update':
          this.#handlers.onAppState(message.appState)
          return
        case 'file-ref-add':
          this.#handlers.onFileRef(message.file)
          return
        case 'presence':
          this.#handlers.onPresence(message.peers)
          return
        case 'pointer':
          this.#handlers.onPointer(message.clientId, message.pointer)
          return
        case 'mutation-rejected':
          this.#handlers.onRejected(message.code, message.message)
          return
      }
    })

    socket.addEventListener('close', () => {
      this.#socket = null
      this.#handlers.onStatus('offline')
      if (!this.#closedByUser) {
        this.#scheduleReconnect()
      }
    })

    socket.addEventListener('error', () => {
      socket.close()
    })
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) {
      return
    }
    this.#attempt += 1
    const delay = Math.min(200 * 2 ** (this.#attempt - 1), MAX_BACKOFF_MS)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** Sammelt Aenderungen desselben Elements, damit ein Zeichenzug nicht jede Zwischenversion sendet. */
  queueElements(elements: readonly SyncElement[]): void {
    for (const element of elements) {
      this.#pendingElements.set(element.id, element)
    }
    this.#flushTimer ??= setTimeout(() => {
      this.#flushTimer = null
      this.#flush()
    }, FLUSH_INTERVAL_MS)
  }

  #flush(): void {
    if (this.#pendingElements.size === 0) {
      return
    }
    const elements = [...this.#pendingElements.values()]
    this.#pendingElements.clear()
    this.#send({ type: 'scene-update', elements })
  }

  sendAppState(appState: PersistedAppState): void {
    this.#send({ type: 'app-state-update', appState })
  }

  sendFileRef(file: BinaryFileRef): void {
    this.#send({ type: 'file-ref-add', file })
  }

  sendPointer(pointer: Pointer): void {
    this.#send({ type: 'pointer', pointer })
  }

  #send(message: ClientMessage): void {
    const socket = this.#socket
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      // Offline gesammelte Elemente gehen nicht verloren: der naechste Welcome-Snapshot gleicht ab und
      // eigene, noch nicht bestaetigte Elemente werden danach erneut gesendet.
      if (message.type === 'scene-update') {
        for (const element of message.elements) {
          this.#pendingElements.set(element.id, element)
        }
      }
      return
    }
    socket.send(encodeMessage(message))
  }

  /** Sendet nach einem Reconnect alle lokalen Elemente erneut, damit der Server nichts verpasst. */
  resync(elements: readonly SyncElement[]): void {
    if (elements.length > 0) {
      this.#send({ type: 'scene-update', elements })
    }
  }

  /**
   * Sendet eine Nachricht ohne lokale Rechtepruefung. Der Mehrbrowser-Test simuliert damit einen
   * manipulierten Client; die Entscheidung muss serverseitig fallen.
   */
  sendUnchecked(message: ClientMessage): void {
    this.#send(message)
  }

  /** Trennt die Verbindung wie ein Netzwerkabbruch: der Reconnect-Pfad laeuft normal an. */
  simulateNetworkDrop(): void {
    this.#socket?.close()
  }

  close(): void {
    this.#closedByUser = true
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = null
    }
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    this.#socket?.close()
    this.#socket = null
  }
}
