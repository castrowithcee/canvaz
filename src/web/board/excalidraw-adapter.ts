/**
 * Adapter zwischen Excalidraw und dem Board-Editor-Port.
 *
 * Einzige Stelle im Projekt, die Excalidraw-Typen kennt. Die Umwandlung ist bewusst strukturell: unbekannte
 * Elementfelder werden unveraendert durchgereicht, damit ein Upstream-Update keine Daten verliert.
 */

import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI, BinaryFiles, Collaborator, SocketId } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState } from '@excalidraw/excalidraw/types'
import { createElement, useCallback, useEffect, useRef } from 'react'
import type { ReactElement } from 'react'

import type { BinaryFileRef, PersistedAppState, SceneSnapshot, SyncElement } from '../../contracts/scene.js'
import { DEFAULT_APP_STATE } from '../../contracts/scene.js'
import { reconcileElements } from '../../domain/board/reconcile.js'
import type { BoardEditorPort, EditorPeer, LocalChange } from './board-editor-port.js'

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

/** Gleichheit der persistierten Teilmenge. Vier Felder, deshalb ein Vergleich statt einer Bibliothek. */
function samePersistedAppState(left: PersistedAppState, right: PersistedAppState): boolean {
  return (
    left.viewBackgroundColor === right.viewBackgroundColor &&
    left.gridSize === right.gridSize &&
    left.gridModeEnabled === right.gridModeEnabled &&
    left.name === right.name
  )
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
  /** Zuletzt gemeldeter AppState. `null` heisst: noch kein Ausgangsstand uebernommen. */
  #lastAppState: PersistedAppState | null = null

  constructor(api: ExcalidrawImperativeAPI, storagePrefix: string) {
    this.#api = api
    this.#storagePrefix = storagePrefix
    // Der Ausgangsstand des Editors ist bereits bekannt und keine lokale Aenderung. Ohne diese Uebernahme
    // meldete das erste Editorereignis die geladene Szene als frisch gezeichnet.
    for (const element of this.getElements()) {
      this.#sentVersions.set(element.id, element.version)
    }
    for (const file of this.getFileRefs()) {
      this.#knownFileIds.add(file.id)
    }
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

  /** Persistierte Teilmenge des aktuellen AppState. Der Aufrufer sieht nie einen Excalidraw-Typ. */
  getAppState(): PersistedAppState {
    return toPersistedAppState(this.#api.getAppState())
  }

  /** Referenzen aller im Editor bekannten Binaerdateien. Die Bytes bleiben beim Storage-Port. */
  getFileRefs(): readonly BinaryFileRef[] {
    return toFileRefs(this.#api.getFiles(), this.#storagePrefix)
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
    // Der AppState gehoert zum geteilten Zustand: eine geaenderte Hintergrundfarbe oder ein umgeschaltetes
    // Raster ist eine Aenderung, auch wenn dabei kein Element angefasst wurde.
    const persistedAppState = toPersistedAppState(appState)
    const appStateChanged =
      this.#lastAppState !== null && !samePersistedAppState(this.#lastAppState, persistedAppState)
    this.#lastAppState = persistedAppState
    if (changed.length === 0 && newFiles.length === 0 && !appStateChanged) {
      return
    }
    const change: LocalChange = { changedElements: changed, appState: persistedAppState, newFiles }
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
    // Der Vergleichsmassstab wird verworfen und beim naechsten Editorereignis neu genommen. Ihn hier auf den
    // uebernommenen Stand zu setzen waere falsch: Excalidraw kennt fuer `gridSize` keinen Nullwert und
    // meldet stattdessen seinen Standardabstand zurueck - das saehe wie eine lokale Aenderung aus.
    this.#lastAppState = null
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

  showPeers(peers: readonly EditorPeer[]): void {
    const collaborators = new Map<SocketId, Collaborator>()
    for (const peer of peers) {
      const collaborator: Collaborator = {
        username: `${peer.displayName}${peer.readOnly ? ' (nur Lesen)' : ''}`,
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

/**
 * Mountet die Zeichenflaeche und reicht einen fertigen Adapter heraus.
 *
 * Bewusst hier und nicht in der Boardansicht: das Excalidraw-Paket - Komponente wie Typen - erscheint
 * ausschliesslich in dieser Datei. Die Boardansicht kennt nur `BoardEditorPort`. Ohne JSX, damit die Datei
 * eine `.ts` bleiben kann.
 */
export function BoardCanvas({
  viewMode,
  storagePrefix,
  scene,
  onAdapterReady,
}: {
  readonly viewMode: boolean
  readonly storagePrefix: string
  /** Ausgangsstand. Wird als `initialData` gesetzt, damit der Editor ihn nicht beim Mounten ueberschreibt. */
  readonly scene: SceneSnapshot
  readonly onAdapterReady: (adapter: ExcalidrawBoardAdapter) => void
}): ReactElement {
  const adapter = useRef<ExcalidrawBoardAdapter | null>(null)
  // Stabile Identitaet: Excalidraw reicht die Schnittstelle erneut heraus, sobald sich der Rueckruf aendert.
  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      const next = new ExcalidrawBoardAdapter(api, storagePrefix)
      adapter.current = next
      // Das Abonnement auf Editoraenderungen gehoert zum Adapter und nicht zum Aufrufer; der Port kennt
      // deshalb weder `start` noch `stop`.
      next.start()
      onAdapterReady(next)
    },
    [storagePrefix, onAdapterReady],
  )
  useEffect(
    () => () => {
      adapter.current?.stop()
    },
    [],
  )
  return createElement(Excalidraw, {
    excalidrawAPI: handleApi,
    viewModeEnabled: viewMode,
    langCode: 'de-DE',
    initialData: {
      elements: toExcalidrawElements(scene.elements),
      appState: {
        viewBackgroundColor: scene.appState.viewBackgroundColor,
        gridModeEnabled: scene.appState.gridModeEnabled,
        name: scene.appState.name,
        // `gridSize: null` bedeutet im Boardzustand "kein Raster". Excalidraw kennt dafuer keinen Nullwert
        // und steuert die Sichtbarkeit ueber `gridModeEnabled`; der Snapshot behaelt `null`.
        gridSize: scene.appState.gridSize ?? EXCALIDRAW_DEFAULT_GRID_SIZE,
      },
      // Kamera und Auswahl sind clientlokal und werden nicht gespeichert; der Blick geht deshalb auf den
      // vorhandenen Inhalt statt auf den Nullpunkt.
      scrollToContent: true,
    },
  })
}
