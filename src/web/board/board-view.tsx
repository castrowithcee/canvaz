/**
 * Boardeditor.
 *
 * Die Zeichenflaeche kommt aus `excalidraw-adapter.ts`; diese Datei kennt nur den Editor-Port und den
 * Szenenvertrag. Sie haelt drei Dinge zusammen: den geladenen Stand, die Ausgangsversion der naechsten
 * Speicherung und den sichtbaren Zustand von Laden und Speichern.
 *
 * Gespeichert wird verzoegert nach der letzten Aenderung und auf Knopfdruck. Ein Konflikt (409) beendet das
 * automatische Speichern: einfach mit der neuen Ausgangsversion weiterzumachen waere genau das stille
 * Ueberschreiben, das die Versionspruefung verhindern soll. Die Aufloesung entscheidet der Mensch, bis
 * Issue 5 die Zusammenfuehrung mehrerer Bearbeiter bringt.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import '@excalidraw/excalidraw/index.css'

import type { BoardView } from '../../contracts/api.js'
import type { BinaryFileRef, SceneSnapshot } from '../../contracts/scene.js'
import { SCENE_SCHEMA_VERSION } from '../../contracts/scene.js'
import { ApiError, fetchBoardScene, saveBoardScene } from '../api.js'
import type { BoardEditorPort } from './board-editor-port.js'
import { BoardCanvas } from './excalidraw-adapter.js'

/** Ruhezeit nach der letzten Aenderung, bevor gespeichert wird. */
const AUTOSAVE_DELAY_MS = 1_500

type Loaded = {
  readonly board: BoardView
  readonly version: number
  readonly scene: SceneSnapshot
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly loaded: Loaded }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'dirty' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly at: Date }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'failed'; readonly message: string }

function saveMessage(state: SaveState): string {
  switch (state.kind) {
    case 'idle':
      return 'Keine ungespeicherten Aenderungen.'
    case 'dirty':
      return 'Nicht gespeicherte Aenderungen.'
    case 'saving':
      return 'Wird gespeichert …'
    case 'saved':
      return `Gespeichert um ${state.at.toLocaleTimeString('de-DE')}.`
    case 'conflict':
      return 'Konflikt: nicht gespeichert.'
    case 'failed':
      return `Speichern fehlgeschlagen. ${state.message}`
  }
}

export function BoardEditor({
  boardId,
  csrfToken,
  workspaceArchived,
  onClose,
}: {
  readonly boardId: string
  readonly csrfToken: string
  readonly workspaceArchived: boolean
  readonly onClose: () => void
}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [adapter, setAdapter] = useState<BoardEditorPort | null>(null)
  /** Erzwingt eine frische Zeichenflaeche beim Neuladen; sonst blieben verworfene Elemente stehen. */
  const [mountKey, setMountKey] = useState(0)

  // Refs statt State: der Speichervorgang liest den jeweils aktuellen Stand, ohne neu aufgebaut zu werden.
  const versionRef = useRef(0)
  const filesRef = useRef<Record<string, BinaryFileRef>>({})
  const blockedRef = useRef(false)

  const load = useCallback(() => {
    setState({ kind: 'loading' })
    setSave({ kind: 'idle' })
    setAdapter(null)
    setMountKey((current) => current + 1)
    blockedRef.current = false
    fetchBoardScene(boardId)
      .then((response) => {
        versionRef.current = response.version
        filesRef.current = { ...response.scene.files }
        setState({
          kind: 'ready',
          loaded: { board: response.board, version: response.version, scene: response.scene },
        })
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 404) {
          setState({ kind: 'not-found' })
          return
        }
        if (cause instanceof ApiError && cause.status === 403) {
          setState({ kind: 'forbidden', message: cause.message })
          return
        }
        setState({
          kind: 'failed',
          message: cause instanceof ApiError ? cause.message : 'Das Board konnte nicht geladen werden.',
        })
      })
  }, [boardId])

  useEffect(load, [load])

  const viewOnly =
    workspaceArchived || (state.kind === 'ready' && state.loaded.board.status === 'archived')

  const persist = useCallback(() => {
    if (adapter === null || blockedRef.current) {
      return
    }
    const snapshot: SceneSnapshot = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      boardId,
      elements: adapter.getElements(),
      appState: adapter.getAppState(),
      files: filesRef.current,
      updatedAt: Date.now(),
    }
    setSave({ kind: 'saving' })
    saveBoardScene(csrfToken, { boardId, baseVersion: versionRef.current, scene: snapshot })
      .then((response) => {
        versionRef.current = response.version
        setSave({ kind: 'saved', at: new Date(response.savedAt) })
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 409) {
          // Nichts wurde ueberschrieben. Weiter automatisch zu speichern wuerde genau das nachholen.
          blockedRef.current = true
          setSave({ kind: 'conflict' })
          return
        }
        setSave({
          kind: 'failed',
          message: cause instanceof ApiError ? cause.message : 'Der Server war nicht erreichbar.',
        })
      })
  }, [adapter, boardId, csrfToken])

  // Verzoegertes Speichern: erst wenn eine Weile nichts mehr passiert ist.
  useEffect(() => {
    if (save.kind !== 'dirty') {
      return
    }
    const timer = window.setTimeout(persist, AUTOSAVE_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [save, persist])

  // Der gezeichnete Ausgangsstand steht bereits im Editor (`scene` an der Zeichenflaeche). Hier kommen nur
  // die Dateireferenzen dazu - ihre Bytes liegen hinter dem Storage-Port - und das Abonnement auf Aenderungen.
  useEffect(() => {
    if (adapter === null || state.kind !== 'ready') {
      return
    }
    adapter.setReadOnly(viewOnly)
    for (const file of Object.values(state.loaded.scene.files)) {
      adapter.applyRemoteFileRef(file)
    }
    return adapter.onLocalChange((change) => {
      for (const file of change.newFiles) {
        filesRef.current = { ...filesRef.current, [file.id]: file }
      }
      setSave((current) => (current.kind === 'conflict' ? current : { kind: 'dirty' }))
    })
  }, [adapter, state, viewOnly])

  if (state.kind === 'loading') {
    return (
      <Frame title="Board" onClose={onClose}>
        <p aria-live="polite">Board wird geladen …</p>
      </Frame>
    )
  }
  if (state.kind === 'not-found') {
    return (
      <Frame title="Board nicht gefunden" onClose={onClose}>
        <p className="notice notice--error" role="alert">
          Dieses Board ist nicht (mehr) fuer dich freigegeben oder existiert nicht.
        </p>
      </Frame>
    )
  }
  if (state.kind === 'forbidden') {
    return (
      <Frame title="Kein Zugriff" onClose={onClose}>
        <p className="notice notice--error" role="alert">
          Dafuer fehlt dir die Berechtigung. {state.message}
        </p>
      </Frame>
    )
  }
  if (state.kind === 'failed') {
    return (
      <Frame title="Board" onClose={onClose}>
        <p className="notice notice--error" role="alert">
          {state.message}{' '}
          <button type="button" onClick={load}>
            Erneut laden
          </button>
        </p>
      </Frame>
    )
  }

  return (
    <div className="board">
      <header className="board__bar">
        <h2 className="board__title">{state.loaded.board.title}</h2>
        <p className="board__state" role="status">
          {viewOnly ? 'Nur Lesen: archiviert.' : saveMessage(save)}
        </p>
        {!viewOnly && (
          <button type="button" onClick={persist} disabled={save.kind === 'saving' || adapter === null}>
            Board speichern
          </button>
        )}
        {save.kind === 'conflict' && (
          <button type="button" onClick={load}>
            Neu laden und eigene Aenderungen verwerfen
          </button>
        )}
        <button type="button" onClick={onClose}>
          Board schliessen
        </button>
      </header>
      {save.kind === 'conflict' && (
        <p className="notice notice--error" role="alert">
          Dieses Board wurde inzwischen an anderer Stelle gespeichert. Deine Zeichnung ist noch da, wurde aber
          nicht uebernommen und hat nichts ueberschrieben. Lade das Board neu, um auf dem aktuellen Stand
          weiterzuarbeiten.
        </p>
      )}
      <div className="board__canvas">
        <BoardCanvas
          key={mountKey}
          viewMode={viewOnly}
          storagePrefix={`boards/${boardId}`}
          scene={state.loaded.scene}
          onAdapterReady={setAdapter}
        />
      </div>
    </div>
  )
}

function Frame({
  title,
  onClose,
  children,
}: {
  readonly title: string
  readonly onClose: () => void
  readonly children: ReactNode
}) {
  return (
    <section className="shell" aria-labelledby="board-frame-heading">
      <h2 id="board-frame-heading">{title}</h2>
      {children}
      <p>
        <button type="button" onClick={onClose}>
          Zurueck zur Boardliste
        </button>
      </p>
    </section>
  )
}
