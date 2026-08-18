/**
 * Boardeditor.
 *
 * Die Zeichenflaeche kommt aus `excalidraw-adapter.ts`; diese Datei kennt nur den Editor-Port und den
 * Szenenvertrag. Sie haelt drei Dinge zusammen: den geladenen Stand, die Ausgangsversion der naechsten
 * Speicherung und den sichtbaren Zustand von Laden und Speichern.
 *
 * Es gibt zwei Wege, wie eine Zeichnung sicher wird, und immer nur einen davon zugleich:
 *
 * - **Live verbunden**: Aenderungen gehen an den Boardraum, der sie verteilt und getaktet persistiert. Der
 *   Speicherstatus kommt dann vom Server (`saved`), nicht aus einer eigenen Speicherung.
 * - **Nicht verbunden**: die verzoegerte Speicherung ueber die HTTP-API uebernimmt wieder. Ein Konflikt
 *   (409) beendet das automatische Speichern - einfach mit der neuen Ausgangsversion weiterzumachen waere
 *   genau das stille Ueberschreiben, das die Versionspruefung verhindern soll.
 *
 * Ein **laufender Wiederverbindungsversuch** ist bewusst keiner der beiden Faelle: solange er laeuft und der
 * Aussetzer kurz ist, wird nicht selbst gespeichert. Eine Speicherung gegen die Checkpoints des Raums
 * erzeugte sonst einen Konflikt, den es fachlich gar nicht gibt. Erst wenn die Strecke laenger weg ist,
 * uebernimmt die HTTP-Speicherung wieder.
 *
 * Damit fuehrt ein Verbindungsverlust nie zu stillem Datenverlust: er ist sichtbar, und die Zeichnung wird
 * weiter gesichert. Sichtbar sind ausserdem der laufende Versuch, der erfolgreiche Abgleich nach der
 * Wiederaufnahme und jede benannt abgelehnte Nachricht.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import '@excalidraw/excalidraw/index.css'

import type { BoardView } from '../../contracts/api.js'
import type { PresenceView } from '../../contracts/realtime.js'
import type { BinaryFileRef, SceneSnapshot } from '../../contracts/scene.js'
import { SCENE_SCHEMA_VERSION } from '../../contracts/scene.js'
import { ApiError, fetchBoardAssetDataUrl, fetchBoardScene, saveBoardScene, uploadBoardAsset } from '../api.js'
import type { BoardEditorPort, EditorPeer } from './board-editor-port.js'
import { BoardCanvas } from './excalidraw-adapter.js'
import { connectBoardRealtime } from './realtime-client.js'
import type { BoardRealtime, RealtimeStatus } from './realtime-client.js'

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

/** Presence des Servers wird zu dem, was der Editor darstellen kann - ohne den eigenen Eintrag. */
function fremdePeers(peers: readonly PresenceView[], selbst: string | null): readonly EditorPeer[] {
  return peers
    .filter((peer) => peer.clientId !== selbst)
    .map((peer) => ({
      clientId: peer.clientId,
      displayName: peer.displayName,
      readOnly: !peer.canWrite,
      pointer: peer.pointer,
      selectedElementIds: peer.selectedElementIds,
    }))
}

/**
 * Der Verbindungszustand in einem Satz.
 *
 * Bewusst ausformuliert statt als Symbol: die Zeile steht in einem `role="status"`-Bereich und wird von
 * einer Sprachausgabe vorgelesen, sobald sie sich aendert.
 */
function connectionMessage(status: RealtimeStatus, attempt: number, resyncedAt: Date | null): string {
  switch (status) {
    case 'verbindet':
      return 'Verbindung wird aufgebaut …'
    case 'verbunden':
      return resyncedAt === null
        ? 'Live verbunden.'
        : `Live verbunden. Stand nach Wiederaufnahme um ${resyncedAt.toLocaleTimeString('de-DE')} abgeglichen.`
    case 'wiederverbinden':
      return `Verbindung verloren. Wiederverbindung laeuft (Versuch ${String(attempt)}).`
    case 'getrennt':
      return 'Nicht live verbunden. Aenderungen werden ueber die Speicherung gesichert.'
  }
}

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
  const [connection, setConnection] = useState<RealtimeStatus>('verbindet')
  /** Zaehler der erfolglosen Wiederverbindungsversuche; er macht den laufenden Versuch sichtbar. */
  const [attempt, setAttempt] = useState(0)
  /** Zeitpunkt des letzten erfolgreichen Abgleichs nach einer Wiederaufnahme. */
  const [resyncedAt, setResyncedAt] = useState<Date | null>(null)
  /** Zuletzt vom Server benannt abgelehnte Nachricht. */
  const [rejected, setRejected] = useState<string | null>(null)
  /** Vom Server aufgeloestes Schreibrecht. Bis zum Beitritt entscheidet allein der geladene Boardzustand. */
  const [canWrite, setCanWrite] = useState(true)
  const [peers, setPeers] = useState<readonly EditorPeer[]>([])
  /** Meldung ueber ein Bild, das nicht hochgeladen oder nicht geladen werden konnte. */
  const [assetProblem, setAssetProblem] = useState<string | null>(null)
  /** Erzwingt eine frische Zeichenflaeche beim Neuladen; sonst blieben verworfene Elemente stehen. */
  const [mountKey, setMountKey] = useState(0)

  // Refs statt State: der Speichervorgang liest den jeweils aktuellen Stand, ohne neu aufgebaut zu werden.
  const versionRef = useRef(0)
  const filesRef = useRef<Record<string, BinaryFileRef>>({})
  const blockedRef = useRef(false)
  /** Laufende Bilduploads. Solange einer offen ist, wird die Szene nicht gespeichert. */
  const uploadsRef = useRef(0)
  /** Lokale Realtime-Kennung des letzten zum Server vorgemerkten Standes. */
  const lastSentChangeSequenceRef = useRef(0)
  const clientRef = useRef<BoardRealtime | null>(null)
  /** Eigene fluechtige Kennung im Raum; sie trennt die anderen Teilnehmer vom eigenen Eintrag. */
  const selfRef = useRef<string | null>(null)
  /** Spiegel von `live` fuer die Rueckrufe des Editors, die nicht neu aufgebaut werden sollen. */
  const liveRef = useRef(false)

  const load = useCallback(() => {
    setState({ kind: 'loading' })
    setSave({ kind: 'idle' })
    setAssetProblem(null)
    setAdapter(null)
    setConnection('verbindet')
    setAttempt(0)
    setResyncedAt(null)
    setRejected(null)
    setCanWrite(true)
    setPeers([])
    setMountKey((current) => current + 1)
    blockedRef.current = false
    uploadsRef.current = 0
    lastSentChangeSequenceRef.current = 0
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

  // Der Server entscheidet; die Oberflaeche folgt ihm. `canWrite` kommt aus dem Raum und beruht auf
  // derselben Policy wie die HTTP-API.
  const viewOnly =
    workspaceArchived || !canWrite || (state.kind === 'ready' && state.loaded.board.status === 'archived')
  /** Live heisst: der Raum nimmt Aenderungen an und persistiert sie. Dann speichert die Ansicht nicht selbst. */
  const live = connection === 'verbunden' && !viewOnly
  liveRef.current = live
  /**
   * Nur wenn auf die Strecke kein Verlass mehr ist, speichert die Ansicht selbst. Waehrend eines laufenden
   * kurzen Wiederverbindungsversuchs bleibt die eigene Speicherung aus - der Raum hat den Stand gleich
   * wieder, und eine Speicherung dazwischen erzeugte nur einen Konflikt mit den Checkpoints.
   */
  const speichertSelbst = connection === 'getrennt' && !viewOnly

  const persist = useCallback(() => {
    if (adapter === null || blockedRef.current) {
      return
    }
    // Eine Szene, die auf ein noch nicht hochgeladenes Bild verweist, waere beim naechsten Oeffnen unvollstaendig.
    // Also wird gewartet, statt einen halben Stand festzuschreiben.
    if (uploadsRef.current > 0) {
      setSave({ kind: 'dirty' })
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
        setSave((current) => {
          if (current.kind === 'dirty' || current.kind === 'failed' || current.kind === 'conflict') {
            return current
          }
          return { kind: 'saved', at: new Date(response.savedAt) }
        })
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 409) {
          // Nichts wurde ueberschrieben. Weiter automatisch zu speichern wuerde genau das nachholen.
          blockedRef.current = true
          setSave({ kind: 'conflict' })
          return
        }
        setSave((current) => {
          if (current.kind === 'dirty' || current.kind === 'conflict') {
            return current
          }
          return {
            kind: 'failed',
            message: cause instanceof ApiError ? cause.message : 'Der Server war nicht erreichbar.',
          }
        })
      })
  }, [adapter, boardId, csrfToken])

  // Verzoegertes Speichern: erst wenn eine Weile nichts mehr passiert ist. Solange der Raum traegt, gibt es
  // keine eigene Speicherung - sie wuerde gegen die Checkpoints des Servers laufen und Konflikte erzeugen.
  useEffect(() => {
    if (save.kind !== 'dirty' || !speichertSelbst) {
      return
    }
    const timer = window.setTimeout(persist, AUTOSAVE_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [save, persist, speichertSelbst])

  // Der gezeichnete Ausgangsstand steht bereits im Editor (`scene` an der Zeichenflaeche). Hier kommen die
  // Bilder dazu: ihre Bytes holt der autorisierte Abrufendpunkt, einzeln und mit der laufenden Sitzung.
  useEffect(() => {
    if (adapter === null || state.kind !== 'ready') {
      return
    }
    adapter.setReadOnly(viewOnly)
    let abandoned = false
    void (async () => {
      for (const file of Object.values(state.loaded.scene.files)) {
        try {
          const dataUrl = await fetchBoardAssetDataUrl(boardId, file.id)
          if (!abandoned) {
            adapter.applyRemoteFileRef(file, dataUrl)
          }
        } catch {
          // Ein einzelnes fehlendes Bild macht das Board nicht unbrauchbar; es wird benannt statt verschwiegen.
          if (!abandoned) {
            setAssetProblem('Mindestens ein Bild dieses Boards konnte nicht geladen werden.')
          }
        }
      }
    })()

    const unsubscribe = adapter.onLocalChange((change) => {
      for (const fileId of change.newFileIds) {
        const dataUrl = adapter.getFileDataUrl(fileId)
        if (dataUrl === null) {
          continue
        }
        // Erst hochladen, dann in die Szene aufnehmen: Groesse und Speicherschluessel kommen vom Server.
        uploadsRef.current += 1
        uploadBoardAsset(csrfToken, boardId, fileId, dataUrl)
          .then((response) => {
            filesRef.current = { ...filesRef.current, [response.file.id]: response.file }
            // Erst jetzt darf der Raum die Datei kennen: vorher gaebe es zu der Kennung keinen Datensatz.
            const client = clientRef.current
            client?.sendChange([], null, [response.file.id])
            if (client !== null) {
              lastSentChangeSequenceRef.current = client.lastChangeSequence()
            }
          })
          .catch((cause: unknown) => {
            setAssetProblem(
              cause instanceof ApiError
                ? `Ein Bild wurde nicht uebernommen. ${cause.message}`
                : 'Ein Bild konnte nicht hochgeladen werden.',
            )
          })
          .finally(() => {
            uploadsRef.current -= 1
            setSave((current) => (current.kind === 'conflict' ? current : { kind: 'dirty' }))
          })
      }
      if (liveRef.current) {
        const client = clientRef.current
        client?.sendChange(change.changedElements, change.appState, [])
        if (client !== null) {
          lastSentChangeSequenceRef.current = client.lastChangeSequence()
        }
      }
      setSave((current) => (current.kind === 'conflict' ? current : { kind: 'dirty' }))
    })
    // Der Zeigezustand ist fluechtig und loest weder Speicherung noch Aenderungsmeldung aus.
    const unsubscribePointer = adapter.onPointerChange((presence) => {
      if (liveRef.current) {
        clientRef.current?.sendPresence(presence.pointer, presence.selectedElementIds)
      }
    })
    return () => {
      abandoned = true
      unsubscribe()
      unsubscribePointer()
    }
  }, [adapter, boardId, csrfToken, state, viewOnly])

  /**
   * Der Boardraum.
   *
   * Aufgebaut, sobald Board und Zeichenflaeche stehen; abgebaut mit dem Editor. Die Berechtigung entscheidet
   * ausschliesslich der Server - diese Ansicht stellt sie nur dar.
   */
  useEffect(() => {
    if (adapter === null || state.kind !== 'ready') {
      return
    }
    let abandoned = false

    function zeigePeers(fremde: readonly EditorPeer[]): void {
      setPeers(fremde)
      adapter?.showPeers(fremde)
    }

    const client = connectBoardRealtime(boardId, {
      onStatus(status, versuch): void {
        setConnection(status)
        setAttempt(versuch)
        if (status !== 'verbunden') {
          zeigePeers([])
          setResyncedAt(null)
        }
      },
      onJoined(message, wiederaufnahme): void {
        if (wiederaufnahme) {
          // Sichtbarer Beleg, dass der Stand nach dem Abbruch wieder zusammengefuehrt wurde.
          setResyncedAt(new Date())
          setRejected(null)
        }
        versionRef.current = message.version
        filesRef.current = { ...filesRef.current, ...message.scene.files }
        setCanWrite(message.canWrite)
        selfRef.current = message.clientId
        adapter?.applyRemoteElements(message.scene.elements)
        adapter?.applyRemoteAppState(message.scene.appState)
        zeigePeers(fremdePeers(message.peers, message.clientId))
        // Was vor dem Beitritt gezeichnet wurde, geht als eigener Stand hinaus. Die Reconciliation
        // entscheidet danach je Element; ein aelterer Stand kann keinen neueren verdraengen.
        if (message.canWrite && adapter !== null) {
          client.sendChange(adapter.getElements(), adapter.getAppState(), [])
          lastSentChangeSequenceRef.current = client.lastChangeSequence()
        }
      },
      onSnapshot(message): void {
        versionRef.current = message.version
        adapter?.applyRemoteElements(message.scene.elements)
        adapter?.applyRemoteAppState(message.scene.appState)
      },
      onSceneChange(message): void {
        adapter?.applyRemoteElements(message.elements)
        if (message.appState !== null) {
          adapter?.applyRemoteAppState(message.appState)
        }
        setSave((current) => {
          if (current.kind === 'conflict' || current.kind === 'dirty') {
            return current
          }
          return { kind: 'saving' }
        })
        for (const file of message.files) {
          filesRef.current = { ...filesRef.current, [file.id]: file }
          fetchBoardAssetDataUrl(boardId, file.id)
            .then((dataUrl) => {
              if (!abandoned) {
                adapter?.applyRemoteFileRef(file, dataUrl)
              }
            })
            .catch(() => {
              if (!abandoned) {
                setAssetProblem('Ein Bild eines Mitbearbeiters konnte nicht geladen werden.')
              }
            })
        }
      },
      onPresence(fremde): void {
        zeigePeers(fremdePeers(fremde, selfRef.current))
      },
      onAccess(erlaubt): void {
        setCanWrite(erlaubt)
        if (!erlaubt) {
          // `saving` kann hier nur der Checkpoint eines Mitbearbeiters sein; eigene Aenderungen stehen als
          // `dirty` da und bleiben deshalb sichtbar, wenn das Schreibrecht entzogen wird.
          setSave((current) => (current.kind === 'saving' ? { kind: 'idle' } : current))
        }
      },
      onSaved(message): void {
        versionRef.current = message.version
        const savedSequence = message.clientChangeSequence ?? 0
        setSave((current) => {
          if (savedSequence < lastSentChangeSequenceRef.current) {
            return current.kind === 'conflict' ? current : { kind: 'dirty' }
          }
          if (current.kind === 'conflict') {
            return current
          }
          return { kind: 'saved', at: new Date(message.savedAt) }
        })
      },
      onError(message): void {
        if (message.code === 'board-nicht-gefunden') {
          setState({ kind: 'not-found' })
          return
        }
        // Jede Ablehnung ist benannt und wird benannt gezeigt. Nur wo die Zeichnung dadurch **nicht**
        // angekommen ist, wird zusaetzlich der Speicherstatus auf gescheitert gesetzt.
        setRejected(message.message)
        if (message.code === 'kein-schreibrecht') {
          setSave((current) =>
            current.kind === 'dirty' || current.kind === 'failed'
              ? { kind: 'failed', message: message.message }
              : current,
          )
        } else if (message.code === 'nicht-speicherbar' || message.code === 'raum-zu-gross' || message.code === 'zu-viele-elemente') {
          setSave({ kind: 'failed', message: message.message })
        }
      },
    })
    clientRef.current = client
    return () => {
      abandoned = true
      clientRef.current = null
      liveRef.current = false
      client.close()
    }
  }, [adapter, boardId, state.kind])

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
          {viewOnly && (save.kind === 'idle' || save.kind === 'saved')
            ? 'Nur Lesen: keine Schreibberechtigung.'
            : saveMessage(save)}
        </p>
        <p className="board__state" role="status">
          {connectionMessage(connection, attempt, resyncedAt)}
        </p>
        <p className="board__peers" role="status">
          {peers.length === 0
            ? 'Allein auf diesem Board.'
            : `Mit dabei: ${peers.map((peer) => peer.displayName).join(', ')}`}
        </p>
        {!viewOnly && (
          <button type="button" onClick={persist} disabled={save.kind === 'saving' || adapter === null}>
            Board speichern
          </button>
        )}
        {assetProblem !== null && (
        <p className="notice notice--error" role="alert">
          {assetProblem}
        </p>
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
      {assetProblem !== null && (
        <p className="notice notice--error" role="alert">
          {assetProblem}
        </p>
      )}
      {rejected !== null && (
        <p className="notice notice--error" role="alert">
          Der Server hat eine Nachricht abgelehnt: {rejected}{' '}
          <button type="button" onClick={() => setRejected(null)}>
            Hinweis ausblenden
          </button>
        </p>
      )}
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
