/**
 * Ein Teilnehmer an der Realtime-Strecke, so wie ein Browser sie benutzt.
 *
 * Verbindet mit demselben Cookie und derselben Herkunft wie die SPA und spricht ausschliesslich das
 * Protokoll aus `src/contracts/realtime.ts`. Es gibt keinen Sonderweg an den Guards vorbei; `sendRaw`
 * existiert allein, damit die Negativtests eine manipulierte Nachricht am Vertrag vorbeischicken koennen.
 */

import { WebSocket } from 'ws'

import { REALTIME_PATH } from '../../src/contracts/api.js'
import type { JoinedMessage, ServerMessage } from '../../src/contracts/realtime.js'
import { REALTIME_PROTOCOL_VERSION } from '../../src/contracts/realtime.js'
import type { SyncElement } from '../../src/contracts/scene.js'

/** Wartet eine feste Zeit. Nur dort einsetzen, wo ein Test belegt, dass **nichts** passiert ist. */
export function ruhe(ms = 200): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Ein Element mit frei waehlbarer Version und Nonce; die Reconciliation entscheidet ueber genau diese. */
export function element(
  id: string,
  version: number,
  versionNonce: number,
  extra: Record<string, unknown> = {},
): SyncElement {
  return { id, version, versionNonce, type: 'rectangle', x: 10, y: 20, width: 30, height: 40, ...extra }
}

export function change(boardId: string, elements: readonly SyncElement[], fileIds: readonly string[] = []): unknown {
  return { type: 'scene-change', boardId, elements, appState: null, fileIds }
}

export function ids(elements: readonly SyncElement[]): string[] {
  return elements.map((entry) => entry.id)
}

export type RealtimeTestClient = {
  readonly socket: WebSocket
  /** Alles, was je angekommen ist. Auch die bereits abgeholten Nachrichten bleiben stehen. */
  readonly log: readonly ServerMessage[]
  send(message: unknown): void
  /** Rohtext statt Vertrag - nur die Negativtests brauchen das. */
  sendRaw(raw: string): void
  /** Naechste noch nicht abgeholte Nachricht dieses Typs, die `passt` erfuellt. */
  next<T extends ServerMessage['type']>(
    type: T,
    passt?: (message: Extract<ServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { type: T }>>
  join(boardId: string): Promise<JoinedMessage>
  /** Hoert auf zu lesen, ohne die Verbindung zu schliessen: der Fall "langsamer oder haengender Client". */
  pause(): void
  resume(): void
  readonly closeCode: Promise<number>
  close(): void
}

/** Baut die Verbindung auf und wartet auf `ready` - also auf den authentifizierten Ausgangszustand. */
export async function openRealtime(baseUrl: string, cookieHeader: string): Promise<RealtimeTestClient> {
  const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}${REALTIME_PATH}`, {
    headers: { cookie: cookieHeader, origin: baseUrl },
  })
  const log: ServerMessage[] = []
  const taken = new Set<number>()
  type Waiter = {
    readonly type: string
    readonly passt: (message: ServerMessage) => boolean
    readonly resolve: (message: ServerMessage) => void
  }
  const waiters: Waiter[] = []

  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString('utf8')) as ServerMessage
    const index = log.length
    log.push(message)
    const waiting = waiters.findIndex((waiter) => waiter.type === message.type && waiter.passt(message))
    if (waiting >= 0) {
      taken.add(index)
      waiters.splice(waiting, 1)[0]?.resolve(message)
    }
  })
  // Ein Socketfehler beendet sonst den Testlauf mit einer nicht abgefangenen Ausnahme.
  socket.on('error', () => undefined)

  const closeCode = new Promise<number>((resolve) => {
    socket.once('close', resolve)
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  const client: RealtimeTestClient = {
    socket,
    log,
    send(message: unknown): void {
      socket.send(JSON.stringify(message))
    },
    sendRaw(raw: string): void {
      socket.send(raw)
    },
    next<T extends ServerMessage['type']>(
      type: T,
      passt: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    ): Promise<Extract<ServerMessage, { type: T }>> {
      const trifft = (message: ServerMessage): boolean =>
        message.type === type && passt(message as Extract<ServerMessage, { type: T }>)
      const index = log.findIndex((message, position) => !taken.has(position) && trifft(message))
      if (index >= 0) {
        taken.add(index)
        return Promise.resolve(log[index] as Extract<ServerMessage, { type: T }>)
      }
      return new Promise((resolve) => {
        waiters.push({ type, passt: trifft, resolve: resolve as (message: ServerMessage) => void })
      })
    },
    join(boardId: string): Promise<JoinedMessage> {
      client.send({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId })
      return client.next('joined')
    },
    pause(): void {
      socket.pause()
    },
    resume(): void {
      socket.resume()
    },
    closeCode,
    close(): void {
      socket.close()
    },
  }
  // Eine Verbindung, die der Server sofort benannt ablehnt (etwa wegen der Verbindungsgrenze), sieht nie
  // ein `ready`. Der Aufrufer bekommt sie trotzdem zurueck und liest den Grund aus `log` und `closeCode`.
  await Promise.race([client.next('ready'), closeCode])
  return client
}
