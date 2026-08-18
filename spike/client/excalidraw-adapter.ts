/**
 * Adapter zwischen Excalidraw und dem Board-Editor-Port.
 *
 * Einzige Stelle im Projekt, die Excalidraw-Typen kennt. Die Umwandlung ist bewusst strukturell: unbekannte
 * Elementfelder werden unveraendert durchgereicht, damit ein Upstream-Update keine Daten verliert.
 */

import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI, BinaryFiles, Collaborator, SocketId } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState } from '@excalidraw/excalidraw/types'

import type { Peer } from '../shared/protocol.js'
import type { BinaryFileRef, PersistedAppState, SyncElement } from '../shared/scene.js'
import { DEFAULT_APP_STATE } from '../shared/scene.js'
import { reconcileElements } from '../shared/reconcile.js'
import type { BoardEditorPort, LocalChange } from './board-editor-port.js'

/** Excalidraws eigener Rasterabstand, wenn der Boardzustand kein Raster vorgibt. */
const EXCALIDRAW_DEFAULT_GRID_SIZE = 20

/**
 * Excalidraw-Elemente erfuellen den SyncElement-Vertrag strukturell. Der Cast liegt bewusst an genau dieser
 * Grenze und wird durch `isSyncElement` auf der Serverseite abgesichert.
 */
function toSyncElements(elements: readonly ExcalidrawElement[]): readonly SyncElement[] {
  return elements as unknown as readonly SyncElement[]
}

function toExcalidrawElements(elements: readonly SyncElement[]): readonly ExcalidrawElement[] {
  return elements as unknown as readonly ExcalidrawElement[]
}

export function toPersistedAppState(appState: Pick<AppState, 'viewBackgroundColor' | 'gridSize' | 'gridModeEnabled' | 'name'>): PersistedAppState {
  return {
    viewBackgroundColor: appState.viewBackgroundColor,
    gridSize: appState.gridSize ?? null,
    gridModeEnabled: appState.gridModeEnabled,
    name: appState.name ?? DEFAULT_APP_STATE.name,
  }
}

/** Binaerassets verlassen den Editor nur als Referenz; die Bytes gehen spaeter an den Storage-Port. */
export function toFileRefs(files: BinaryFiles, storagePrefix: string): BinaryFileRef[] {
  return Object.values(files).map((file) => ({
    id: file.id,
    mimeType: file.mimeType,
    created: file.created,
    byteSize: file.dataURL.length,
    storageKey: `${storagePrefix}/${file.id}`,
  }))
}

export class ExcalidrawBoardAdapter implements BoardEditorPort {
  readonly #api: ExcalidrawImperativeAPI
  readonly #storagePrefix: string
  readonly #listeners = new Set<(change: LocalChange) => void>()
  readonly #sentVersions = new Map<string, number>()
  readonly #knownFileIds = new Set<string>()
  #unsubscribe: (() => void) | null = null
  #applyingRemote = false
  #readOnly = false

  constructor(api: ExcalidrawImperativeAPI, storagePrefix: string) {
    this.#api = api
    this.#storagePrefix = storagePrefix
  }

  start(): void {
    this.#unsubscribe ??= this.#api.onChange((elements, appState, files) => {
      this.#handleChange(elements, appState, files)
    })
  }

  stop(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  getElements(): readonly SyncElement[] {
    return toSyncElements(this.#api.getSceneElementsIncludingDeleted())
  }

  #handleChange(elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles): void {
    if (this.#applyingRemote || this.#readOnly) {
      return
    }
    const changed: SyncElement[] = []
    for (const element of toSyncElements(elements)) {
      if (this.#sentVersions.get(element.id) !== element.version) {
        this.#sentVersions.set(element.id, element.version)
        changed.push(element)
      }
    }
    const newFiles = toFileRefs(files, this.#storagePrefix).filter((file) => !this.#knownFileIds.has(file.id))
    for (const file of newFiles) {
      this.#knownFileIds.add(file.id)
    }
    if (changed.length === 0 && newFiles.length === 0) {
      return
    }
    const change: LocalChange = { changedElements: changed, appState: toPersistedAppState(appState), newFiles }
    for (const listener of this.#listeners) {
      listener(change)
    }
  }

  applyRemoteElements(remote: readonly SyncElement[]): void {
    const { elements, appliedIds } = reconcileElements(this.getElements(), remote)
    if (appliedIds.size === 0) {
      return
    }
    for (const element of elements) {
      this.#sentVersions.set(element.id, element.version)
    }
    this.#applyingRemote = true
    try {
      this.#api.updateScene({
        elements: toExcalidrawElements(elements),
        // Entfernte Aenderungen gehoeren nicht in die lokale Undo-Historie.
        captureUpdate: CaptureUpdateAction.NEVER,
      })
    } finally {
      this.#applyingRemote = false
    }
  }

  applyRemoteAppState(appState: PersistedAppState): void {
    this.#applyingRemote = true
    try {
      this.#api.updateScene({
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          gridModeEnabled: appState.gridModeEnabled,
          name: appState.name,
          // `gridSize: null` bedeutet im Boardzustand "kein Raster". Excalidraw kennt dafuer keinen
          // Nullwert und steuert die Sichtbarkeit ueber `gridModeEnabled`; der Snapshot behaelt `null`.
          gridSize: appState.gridSize ?? EXCALIDRAW_DEFAULT_GRID_SIZE,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      })
    } finally {
      this.#applyingRemote = false
    }
  }

  applyRemoteFileRef(file: BinaryFileRef): void {
    // Der Spike transportiert keine Bytes. Das Produkt laedt sie hier ueber den Storage-Port nach und ruft
    // danach `api.addFiles`.
    this.#knownFileIds.add(file.id)
  }

  showPeers(peers: readonly Peer[]): void {
    const collaborators = new Map<SocketId, Collaborator>()
    for (const peer of peers) {
      const collaborator: Collaborator = {
        username: `${peer.displayName}${peer.role === 'viewer' ? ' (nur Lesen)' : ''}`,
        ...(peer.pointer === null ? {} : { pointer: { x: peer.pointer.x, y: peer.pointer.y, tool: 'pointer' as const } }),
      }
      collaborators.set(peer.clientId as SocketId, collaborator)
    }
    this.#api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER })
  }

  setReadOnly(readOnly: boolean): void {
    this.#readOnly = readOnly
  }

  onLocalChange(listener: (change: LocalChange) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}
