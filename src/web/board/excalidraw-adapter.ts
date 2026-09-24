/**
 * Adapter zwischen Excalidraw und dem Board-Editor-Port.
 *
 * Einzige Stelle im Projekt, die Excalidraw-Typen kennt. Die Umwandlung ist bewusst strukturell: unbekannte
 * Elementfelder werden unveraendert durchgereicht, damit ein Upstream-Update keine Daten verliert.
 */

import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw'
import type {
  ExcalidrawImperativeAPI,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  SocketId,
} from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState } from '@excalidraw/excalidraw/types'
import { createElement, useCallback, useEffect, useRef } from 'react'
import type { ReactElement } from 'react'

import type { BinaryFileRef, PersistedAppState, SceneSnapshot, SyncElement } from '../../contracts/scene.js'
import { DEFAULT_APP_STATE } from '../../contracts/scene.js'
import { reconcileElements } from '../../domain/board/reconcile.js'
import { useColorScheme } from '../appearance.js'
import type { BoardEditorPort, EditorPeer, LocalChange, LocalPresence } from './board-editor-port.js'

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
  readonly #listeners = new Set<(change: LocalChange) => void>()
  readonly #presenceListeners = new Set<(presence: LocalPresence) => void>()
  readonly #sentVersions = new Map<string, number>()
  readonly #knownFileIds = new Set<string>()
  #unsubscribe: (() => void) | null = null
  #applyingRemote = false
  #readOnly = false
  /** Zuletzt gemeldeter AppState. `null` heisst: noch kein Ausgangsstand uebernommen. */
  #lastAppState: PersistedAppState | null = null

  constructor(api: ExcalidrawImperativeAPI) {
    this.#api = api
    // Der Ausgangsstand des Editors ist bereits bekannt und keine lokale Aenderung. Ohne diese Uebernahme
    // meldete das erste Editorereignis die geladene Szene als frisch gezeichnet.
    for (const element of this.getElements()) {
      this.#sentVersions.set(element.id, element.version)
    }
    for (const fileId of Object.keys(this.#api.getFiles())) {
      this.#knownFileIds.add(fileId)
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

  /** Inhalt einer Datei als Data-URL. Einzige Stelle, an der Bytes den Editor verlassen. */
  getFileDataUrl(fileId: string): string | null {
    return this.#api.getFiles()[fileId]?.dataURL ?? null
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
    const newFileIds = Object.keys(files).filter((fileId) => !this.#knownFileIds.has(fileId))
    for (const fileId of newFileIds) {
      this.#knownFileIds.add(fileId)
    }
    // Der AppState gehoert zum geteilten Zustand: eine geaenderte Hintergrundfarbe oder ein umgeschaltetes
    // Raster ist eine Aenderung, auch wenn dabei kein Element angefasst wurde.
    const persistedAppState = toPersistedAppState(appState)
    const appStateChanged =
      this.#lastAppState !== null && !samePersistedAppState(this.#lastAppState, persistedAppState)
    this.#lastAppState = persistedAppState
    if (changed.length === 0 && newFileIds.length === 0 && !appStateChanged) {
      return
    }
    const change: LocalChange = { changedElements: changed, appState: persistedAppState, newFileIds }
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

  applyRemoteFileRef(file: BinaryFileRef, dataUrl: string): void {
    // Bekannt, bevor die Datei im Editor landet: sonst meldete das folgende Editorereignis sie als neu und
    // der Aufrufer wuerde dieselbe Datei sofort wieder hochladen.
    this.#knownFileIds.add(file.id)
    // Der Cast liegt an derselben Grenze wie der der Elemente: Excalidraw fuehrt fuer Kennung und Data-URL
    // eigene Markentypen, fachlich sind es Zeichenketten.
    this.#api.addFiles([
      { id: file.id, mimeType: file.mimeType, dataURL: dataUrl, created: file.created },
    ] as unknown as BinaryFileData[])
  }

  showPeers(peers: readonly EditorPeer[]): void {
    const collaborators = new Map<SocketId, Collaborator>()
    for (const peer of peers) {
      const collaborator: Collaborator = {
        username: `${peer.displayName}${peer.readOnly ? ' (nur Lesen)' : ''}`,
        selectedElementIds: Object.fromEntries(peer.selectedElementIds.map((id) => [id, true])),
        ...(peer.pointer === null ? {} : { pointer: { x: peer.pointer.x, y: peer.pointer.y, tool: 'pointer' as const } }),
      }
      collaborators.set(peer.clientId as SocketId, collaborator)
    }
    this.#api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER })
  }

  /**
   * Meldet den eigenen Zeigezustand.
   *
   * Wird von der Zeichenflaeche in Bewegungsrate aufgerufen. Der Adapter buendelt bewusst nicht: das ist
   * eine Frage des Uebertragungswegs und gehoert zum Realtime-Client, nicht zum Editor.
   */
  reportPointer(pointer: LocalPresence['pointer']): void {
    if (this.#presenceListeners.size === 0) {
      return
    }
    const presence: LocalPresence = {
      pointer,
      selectedElementIds: Object.keys(this.#api.getAppState().selectedElementIds),
    }
    for (const listener of this.#presenceListeners) {
      listener(presence)
    }
  }

  onPointerChange(listener: (presence: LocalPresence) => void): () => void {
    this.#presenceListeners.add(listener)
    return () => {
      this.#presenceListeners.delete(listener)
    }
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
  scene,
  onAdapterReady,
}: {
  readonly viewMode: boolean
  /** Ausgangsstand. Wird als `initialData` gesetzt, damit der Editor ihn nicht beim Mounten ueberschreibt. */
  readonly scene: SceneSnapshot
  readonly onAdapterReady: (adapter: ExcalidrawBoardAdapter) => void
}): ReactElement {
  const adapter = useRef<ExcalidrawBoardAdapter | null>(null)
  // Das gerade sichtbare Schema der Produktschale, nie "System". Excalidraw bekommt es ueber seine
  // oeffentliche Prop; seine eigenen Stile und Werkzeuge bleiben unberuehrt. Mit der Prop steuert der Host
  // das Thema, und Excalidraw blendet seinen eigenen Umschalter aus - es gibt dafuer genau einen Ort.
  const theme = useColorScheme()
  // Stabile Identitaet: Excalidraw reicht die Schnittstelle erneut heraus, sobald sich der Rueckruf aendert.
  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      const next = new ExcalidrawBoardAdapter(api)
      adapter.current = next
      // Das Abonnement auf Editoraenderungen gehoert zum Adapter und nicht zum Aufrufer; der Port kennt
      // deshalb weder `start` noch `stop`.
      next.start()
      onAdapterReady(next)
    },
    [onAdapterReady],
  )
  useEffect(
    () => () => {
      adapter.current?.stop()
    },
    [],
  )
  return createElement(Excalidraw, {
    excalidrawAPI: handleApi,
    // Der Zeiger kommt ueber einen eigenen Rueckruf und nicht ueber `onChange`: er ist fluechtig und darf
    // weder eine Speicherung noch eine Aenderungsmeldung ausloesen.
    onPointerUpdate: ({ pointer }: { readonly pointer: { readonly x: number; readonly y: number } }) => {
      adapter.current?.reportPointer({ x: pointer.x, y: pointer.y })
    },
    viewModeEnabled: viewMode,
    theme,
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
