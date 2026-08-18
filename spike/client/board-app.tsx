import { Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Peer, Role } from '../shared/protocol.js'
import type { SyncElement } from '../shared/scene.js'
import { visibleElements } from '../shared/reconcile.js'
import { ExcalidrawBoardAdapter } from './excalidraw-adapter.js'
import { CollabClient, type ConnectionStatus } from './collab-client.js'

export type BoardAppProps = {
  readonly boardId: string
  readonly token: string
  readonly serverUrl: string
}

type Rejection = { readonly code: string; readonly message: string }

export function BoardApp({ boardId, token, serverUrl }: BoardAppProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [role, setRole] = useState<Role | null>(null)
  const [peers, setPeers] = useState<readonly Peer[]>([])
  const [rejection, setRejection] = useState<Rejection | null>(null)
  const adapterRef = useRef<ExcalidrawBoardAdapter | null>(null)
  const clientRef = useRef<CollabClient | null>(null)

  useEffect(() => {
    if (api === null) {
      return
    }
    const adapter = new ExcalidrawBoardAdapter(api, `boards/${boardId}`)
    adapterRef.current = adapter

    const url = `${serverUrl}/ws?board=${encodeURIComponent(boardId)}&token=${encodeURIComponent(token)}`
    const client = new CollabClient(url, {
      onWelcome(message) {
        setRole(message.role)
        adapter.setReadOnly(message.role === 'viewer')
        adapter.applyRemoteAppState(message.snapshot.appState)
        adapter.applyRemoteElements(message.snapshot.elements)
        setPeers(message.peers)
        // Nach einem Reconnect kennt der Server eigene Elemente aus der Offlinephase nicht.
        client.resync(adapter.getElements())
      },
      onSceneUpdate(elements) {
        adapter.applyRemoteElements(elements)
      },
      onAppState(appState) {
        adapter.applyRemoteAppState(appState)
      },
      onFileRef(file) {
        adapter.applyRemoteFileRef(file)
      },
      onPresence(nextPeers) {
        setPeers(nextPeers)
        adapter.showPeers(nextPeers)
      },
      onPointer(clientId, pointer) {
        setPeers((current) =>
          current.map((peer) => (peer.clientId === clientId ? { ...peer, pointer } : peer)),
        )
      },
      onRejected(code, message) {
        setRejection({ code, message })
      },
      onStatus(nextStatus) {
        setStatus(nextStatus)
      },
    })

    const unsubscribe = adapter.onLocalChange((change) => {
      if (change.changedElements.length > 0) {
        client.queueElements(change.changedElements)
      }
      for (const file of change.newFiles) {
        client.sendFileRef(file)
      }
    })

    clientRef.current = client
    adapter.start()
    client.connect()

    return () => {
      unsubscribe()
      adapter.stop()
      client.close()
      clientRef.current = null
      adapterRef.current = null
    }
  }, [api, boardId, serverUrl, token])

  // Haken fuer den Mehrbrowser-Test: Lesen des Editorzustands sowie zwei bewusst unsichere Aktionen, die
  // einen manipulierten Client und einen Netzwerkabbruch nachstellen. Die Kollaboration selbst laeuft in
  // beiden Faellen ueber den normalen Weg.
  useEffect(() => {
    const testHook = {
      elementCount: () => visibleElements(adapterRef.current?.getElements() ?? []).length,
      elementIds: () => visibleElements(adapterRef.current?.getElements() ?? []).map((element) => element.id),
      status: () => status,
      role: () => role,
      rejection: () => rejection,
      sendUncheckedElements: (elements: readonly SyncElement[]) => {
        clientRef.current?.sendUnchecked({ type: 'scene-update', elements })
      },
      dropConnection: () => {
        clientRef.current?.simulateNetworkDrop()
      },
    }
    Reflect.set(window, '__canvazSpike', testHook)
  }, [status, role, rejection])

  const handleApi = useCallback((next: ExcalidrawImperativeAPI) => {
    setApi(next)
  }, [])

  return (
    <div className="board-shell">
      <header className="board-status">
        <span>
          Board <strong data-testid="board-id">{boardId}</strong>
        </span>
        <span>
          Verbindung <strong data-testid="connection-status">{status}</strong>
        </span>
        <span>
          Rolle <strong data-testid="role">{role ?? 'unbekannt'}</strong>
        </span>
        <span>
          Anwesend <strong data-testid="peer-count">{peers.length}</strong>
        </span>
        {rejection !== null ? (
          <span className="rejection" data-testid="rejection">
            {rejection.code}: {rejection.message}
          </span>
        ) : null}
      </header>
      <div className="board-canvas">
        <Excalidraw
          excalidrawAPI={handleApi}
          viewModeEnabled={role === 'viewer'}
          initialData={{ appState: { viewBackgroundColor: '#ffffff' } }}
        />
      </div>
    </div>
  )
}
