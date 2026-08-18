import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ServerMessage } from '../shared/protocol.js'
import type { SyncElement } from '../shared/scene.js'
import { startCollabServer, type CollabServer } from '../server/main.js'

type TestClient = {
  readonly socket: WebSocket
  readonly received: ServerMessage[]
  waitFor<T extends ServerMessage['type']>(type: T, timeoutMs?: number): Promise<Extract<ServerMessage, { type: T }>>
  send(message: unknown): void
  close(): Promise<void>
}

const BOARD = 'board-spike'

let server: CollabServer
let dataDir: string
const openClients: TestClient[] = []

function connect(token: string, board = BOARD): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}/ws?board=${board}&token=${token}`)
  const received: ServerMessage[] = []
  socket.on('message', (data) => {
    received.push(JSON.parse(data.toString()) as ServerMessage)
  })

  const client: TestClient = {
    socket,
    received,
    async waitFor(type, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = received.find((message) => message.type === type)
        if (found !== undefined) {
          received.splice(received.indexOf(found), 1)
          return found as Extract<ServerMessage, { type: typeof type }>
        }
        if (Date.now() > deadline) {
          throw new Error(`Nachricht ${type} blieb aus. Erhalten: ${received.map((m) => m.type).join(', ')}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    send(message) {
      socket.send(typeof message === 'string' ? message : JSON.stringify(message))
    },
    async close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          socket.once('close', () => {
            resolve()
          })
          socket.close()
        })
      }
    },
  }

  openClients.push(client)
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      resolve(client)
    })
    socket.once('error', reject)
  })
}

function element(id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}): SyncElement {
  return { id, version, versionNonce, ...extra }
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'canvaz-spike-test-'))
  server = await startCollabServer({ dataDir })
})

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()))
  await server.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe('Kollaborationsserver', () => {
  it('spiegelt eine Aenderung an den zweiten Client', async () => {
    const editorA = await connect('spike-editor')
    const editorB = await connect('spike-editor-2')
    await editorA.waitFor('welcome')
    await editorB.waitFor('welcome')

    editorA.send({ type: 'scene-update', elements: [element('rect-1', 1, 10, { x: 5 })] })
    const update = await editorB.waitFor('scene-update')

    expect(update.elements).toHaveLength(1)
    expect(update.elements[0]?.['x']).toBe(5)
  })

  it('fuehrt konkurrierende Aenderungen an zwei Elementen zusammen', async () => {
    const editorA = await connect('spike-editor')
    const editorB = await connect('spike-editor-2')
    await editorA.waitFor('welcome')
    await editorB.waitFor('welcome')

    editorA.send({ type: 'scene-update', elements: [element('rect-1', 1, 10, { x: 5 })] })
    editorB.send({ type: 'scene-update', elements: [element('ellipse-1', 1, 11, { y: 7 })] })
    await editorB.waitFor('scene-update')
    await editorA.waitFor('scene-update')

    const snapshot = server.store.get(BOARD)
    expect(snapshot?.elements.map((entry) => entry.id).sort()).toEqual(['ellipse-1', 'rect-1'])
  })

  it('verwirft eine Mutation ohne Schreibrecht und laesst den Zustand unveraendert', async () => {
    const editor = await connect('spike-editor')
    const viewer = await connect('spike-viewer')
    await editor.waitFor('welcome')
    await viewer.waitFor('welcome')

    viewer.send({ type: 'scene-update', elements: [element('boeses-rechteck', 9, 1)] })
    const rejection = await viewer.waitFor('mutation-rejected')

    expect(rejection.code).toBe('read-only')
    expect(server.store.get(BOARD)?.elements).toHaveLength(0)
    expect(editor.received.some((message) => message.type === 'scene-update')).toBe(false)
  })

  it('lehnt eine unbekannte oder unvollstaendige Nachricht ab', async () => {
    const editor = await connect('spike-editor')
    await editor.waitFor('welcome')

    editor.send('kein json')
    expect((await editor.waitFor('mutation-rejected')).code).toBe('invalid-payload')

    editor.send({ type: 'scene-update', elements: [{ id: 'ohne-version' }] })
    expect((await editor.waitFor('mutation-rejected')).code).toBe('invalid-payload')
  })

  it('weist eine Verbindung ohne gueltigen Token ab', async () => {
    await expect(connect('unbekannt')).rejects.toThrow(/401/)
  })

  it('liefert nach einem Reconnect den vollstaendigen Zustand nach', async () => {
    const editorA = await connect('spike-editor')
    const editorB = await connect('spike-editor-2')
    await editorA.waitFor('welcome')
    await editorB.waitFor('welcome')

    editorA.send({ type: 'scene-update', elements: [element('rect-1', 1, 10, { x: 5 })] })
    await editorB.waitFor('scene-update')
    await editorB.close()

    editorA.send({ type: 'scene-update', elements: [element('rect-2', 1, 11, { x: 6 })] })
    editorA.send({ type: 'app-state-update', appState: { viewBackgroundColor: '#eee', gridSize: null, gridModeEnabled: false, name: 'Nach Reconnect' } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const reconnected = await connect('spike-editor-2')
    const welcome = await reconnected.waitFor('welcome')

    expect(welcome.snapshot.elements.map((entry) => entry.id)).toEqual(['rect-1', 'rect-2'])
    expect(welcome.snapshot.appState.name).toBe('Nach Reconnect')
  })

  it('meldet Presence beim Verbinden und Trennen', async () => {
    const editorA = await connect('spike-editor')
    await editorA.waitFor('welcome')

    const editorB = await connect('spike-editor-2')
    const presence = await editorA.waitFor('presence')
    expect(presence.peers).toHaveLength(2)

    await editorB.close()
    const afterLeave = await editorA.waitFor('presence')
    expect(afterLeave.peers).toHaveLength(1)
  })

  it('verteilt Zeigerpositionen ohne den Boardzustand zu veraendern', async () => {
    const editorA = await connect('spike-editor')
    const viewer = await connect('spike-viewer')
    await editorA.waitFor('welcome')
    await viewer.waitFor('welcome')

    viewer.send({ type: 'pointer', pointer: { x: 42, y: 24 } })
    const pointer = await editorA.waitFor('pointer')

    expect(pointer.pointer).toEqual({ x: 42, y: 24 })
    expect(server.store.get(BOARD)?.elements).toHaveLength(0)
  })

  it('laedt einen persistierten Snapshot nach einem Neustart verlustfrei', async () => {
    const editor = await connect('spike-editor')
    await editor.waitFor('welcome')
    editor.send({ type: 'scene-update', elements: [element('rect-1', 4, 10, { x: 5, boundElements: [] })] })
    editor.send({
      type: 'file-ref-add',
      file: { id: 'file-1', mimeType: 'image/png', created: 1, byteSize: 10, storageKey: 'boards/board-spike/file-1.png' },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await server.store.flush()

    const written = server.store.get(BOARD)
    server.store.evict(BOARD)
    const reloaded = await server.store.load(BOARD)

    expect(reloaded).toEqual(written)
    expect(reloaded.files['file-1']?.storageKey).toBe('boards/board-spike/file-1.png')
  })
})
