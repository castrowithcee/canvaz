/**
 * Kollaborationsserver des Spikes: HTTP-Snapshot-Endpunkt plus WebSocket-Sync.
 *
 * Belegt drei Dinge, die der Editor allein nicht belegen kann: dass zwei Clients konvergieren, dass ein
 * Reconnect den vollstaendigen Zustand nachlaedt und dass die Schreibentscheidung serverseitig faellt.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

import { WebSocket, WebSocketServer } from 'ws'

import type { Peer, Pointer, Role, ServerMessage } from '../shared/protocol.js'
import { encodeMessage, parseClientMessage } from '../shared/protocol.js'
import { BoardStore } from './board-store.js'
import { canWrite, resolvePrincipal, type Principal } from './auth.js'

const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SNAPSHOT_PATH_PATTERN = /^\/api\/boards\/([^/]+)\/snapshot$/

/** Schreibnachrichten pro Verbindung und Sekunde. Schuetzt den Spike vor einer Endlosschleife im Client. */
const WRITE_RATE_LIMIT = 120

type Connection = {
  readonly socket: WebSocket
  readonly clientId: string
  readonly principal: Principal
  readonly boardId: string
  pointer: Pointer | null
  windowStart: number
  windowCount: number
}

export type CollabServerOptions = {
  readonly port?: number
  readonly dataDir?: string
  readonly now?: () => number
}

export type CollabServer = {
  readonly httpServer: Server
  readonly store: BoardStore
  readonly port: number
  close(): Promise<void>
}

function peerOf(connection: Connection): Peer {
  return {
    clientId: connection.clientId,
    displayName: connection.principal.displayName,
    role: connection.principal.role,
    pointer: connection.pointer,
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(encodeMessage(message))
  }
}

export async function startCollabServer(options: CollabServerOptions = {}): Promise<CollabServer> {
  const dataDir = options.dataDir ?? join(tmpdir(), 'canvaz-spike-boards')
  const now = options.now ?? (() => Date.now())
  const store = new BoardStore({ dataDir, now })
  const connections = new Set<Connection>()
  let clientCounter = 0

  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }
    const snapshotMatch = SNAPSHOT_PATH_PATTERN.exec(url.pathname)
    if (request.method === 'GET' && snapshotMatch !== null) {
      const boardId = snapshotMatch[1] ?? ''
      const principal = resolvePrincipal(url.searchParams.get('token'))
      if (principal === null) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (!BOARD_ID_PATTERN.test(boardId)) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'invalid-board-id' }))
        return
      }
      store
        .load(boardId)
        .then((snapshot) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(snapshot))
        })
        .catch(() => {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'snapshot-unavailable' }))
        })
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not-found' }))
  })

  const wss = new WebSocketServer({ noServer: true })

  function peersOf(boardId: string): Peer[] {
    return [...connections].filter((entry) => entry.boardId === boardId).map(peerOf)
  }

  function broadcast(boardId: string, message: ServerMessage, exclude?: Connection): void {
    for (const entry of connections) {
      if (entry.boardId === boardId && entry !== exclude) {
        send(entry.socket, message)
      }
    }
  }

  function withinRateLimit(connection: Connection): boolean {
    const timestamp = now()
    if (timestamp - connection.windowStart >= 1000) {
      connection.windowStart = timestamp
      connection.windowCount = 0
    }
    connection.windowCount += 1
    return connection.windowCount <= WRITE_RATE_LIMIT
  }

  function handleConnection(socket: WebSocket, boardId: string, principal: Principal, role: Role): void {
    clientCounter += 1
    const connection: Connection = {
      socket,
      clientId: `c${String(clientCounter)}`,
      principal,
      boardId,
      pointer: null,
      windowStart: now(),
      windowCount: 0,
    }
    connections.add(connection)

    store
      .load(boardId)
      .then((snapshot) => {
        send(socket, {
          type: 'welcome',
          clientId: connection.clientId,
          role,
          snapshot,
          peers: peersOf(boardId),
        })
        broadcast(boardId, { type: 'presence', peers: peersOf(boardId) }, connection)
      })
      .catch(() => {
        socket.close(1011, 'board-load-failed')
      })

    socket.on('message', (data) => {
      const message = parseClientMessage(data.toString())
      if (message === null) {
        send(socket, { type: 'mutation-rejected', code: 'invalid-payload', message: 'Nachricht verworfen.' })
        return
      }
      if (message.type === 'pointer') {
        connection.pointer = message.pointer
        broadcast(boardId, { type: 'pointer', clientId: connection.clientId, pointer: message.pointer }, connection)
        return
      }
      if (!canWrite(principal)) {
        send(socket, {
          type: 'mutation-rejected',
          code: 'read-only',
          message: 'Diese Verbindung hat kein Schreibrecht auf dem Board.',
        })
        return
      }
      if (!withinRateLimit(connection)) {
        send(socket, {
          type: 'mutation-rejected',
          code: 'rate-limited',
          message: 'Zu viele Aenderungen in kurzer Zeit.',
        })
        return
      }
      switch (message.type) {
        case 'scene-update': {
          const applied = store.applyElements(boardId, message.elements)
          if (applied.length > 0) {
            broadcast(boardId, { type: 'scene-update', elements: applied, origin: connection.clientId }, connection)
          }
          return
        }
        case 'app-state-update': {
          store.applyAppState(boardId, message.appState)
          broadcast(
            boardId,
            { type: 'app-state-update', appState: message.appState, origin: connection.clientId },
            connection,
          )
          return
        }
        case 'file-ref-add': {
          store.addFileRef(boardId, message.file)
          broadcast(boardId, { type: 'file-ref-add', file: message.file, origin: connection.clientId }, connection)
          return
        }
      }
    })

    socket.on('close', () => {
      connections.delete(connection)
      broadcast(boardId, { type: 'presence', peers: peersOf(boardId) })
    })
  }

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    const boardId = url.searchParams.get('board') ?? ''
    // Der Spike hat keine Session. Das Produkt ersetzt den Query-Token durch das HttpOnly-Session-Cookie
    // aus Issue 2; die Pruefung bleibt an dieser Stelle serverseitig.
    const principal = resolvePrincipal(url.searchParams.get('token'))
    if (!BOARD_ID_PATTERN.test(boardId)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    if (principal === null) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConnection(ws, boardId, principal, principal.role)
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = httpServer.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Server hat keinen TCP-Port erhalten.'))
        return
      }
      resolve(address.port)
    })
  })

  return {
    httpServer,
    store,
    port,
    async close() {
      for (const entry of connections) {
        entry.socket.close(1001, 'server-shutdown')
      }
      connections.clear()
      await store.flush()
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve()
        })
      })
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error !== undefined) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (isDirectRun) {
  const port = Number.parseInt(process.env['PORT'] ?? '3001', 10)
  const dataDir = process.env['CANVAZ_SPIKE_DATA_DIR'] ?? join(process.cwd(), 'spike', 'server', '.data')
  startCollabServer({ port, dataDir })
    .then((server) => {
      process.stdout.write(`Spike-Kollaborationsserver auf http://127.0.0.1:${String(server.port)}\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`Serverstart fehlgeschlagen: ${String(error)}\n`)
      process.exitCode = 1
    })
}
