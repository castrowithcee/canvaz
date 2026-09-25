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
 *
 * ## Schwebende Gruppen und Informationen
 *
 * Ueber der Zeichenflaeche ist keine Zeile reserviert. Zwei kompakte Gruppen schweben darueber: oben links
 * Rueckweg, Titel und Boardmenue (darin "Umbenennen" mit einem kurzen Dialog), oben rechts Presence, **ein**
 * verdichteter Zustand (`board-status.ts`), die Freigabe als Symbolaktion und der Ausloeser der
 * Informationen. Sie wiederholen nicht, was schon dasteht - was in Ordnung ist, steht nur als Symbol mit
 * Namen und Kurzhinweis da; ausformuliert wird nur, was Aufmerksamkeit verlangt, und nur das wird
 * Hilfsmitteln angekuendigt. Uhrzeit und Verbindung stehen ausgeschrieben unter "Informationen".
 * Hervorgehoben ist hoechstens **eine** Aktion (`boardActions`): verlangt die Lage eine Handlung - zurueck
 * zum aktuellen Stand, neu laden, jetzt speichern -, ist sie es, und die Freigabe tritt zurueck; sonst ist
 * die Freigabe die Hauptaktion.
 * Ihre Hoehe halten die Bedienelemente der Zeichenflaeche frei; die Zeichnung selbst laeuft darunter weiter.
 *
 * Alles Umfangreichere - Ablage, Arbeitsbereichswechsel, Freigaben, Versionen, Import/Export, Archiv und
 * Papierkorb, dazu Speicher- und Verbindungsdetails - steht in der Informationsleiste (`board-panel.tsx`,
 * sichtbar benannt "Informationen") neben der Zeichenflaeche. Sie ist auf jeder
 * Breite derselbe Knoten: breit eine angedockte Spalte, schmal ein modales Sheet mit Fokusfang, Escape und
 * Fokusrueckgabe von der Plattform. Welcher Bereich offen ist, steht in der Adresse; `Zurueck` schliesst.
 *
 * ## Ein Editor fuer Mitglieder und Gaeste
 *
 * Dieselbe Ansicht traegt beide Wege. Sie kennt vom Board nur Titel und Status - genau das, was in beiden
 * Antwortformen von `GET /api/boards/scene` steht - und verzweigt auf `viewer`, statt aus einer Gastantwort
 * Felder zu lesen, die es dort nicht gibt. Ein Gast bekommt keinen Weg zurueck und keine Informationen: es
 * gibt fuer ihn weder eine Boardliste noch einen Arbeitsbereich, und `member` bleibt fuer ihn `null`.
 *
 * ## Kein stiller Datenverlust
 *
 * Solange Arbeit nur im Browser liegt - Konflikt, fehlgeschlagene Speicherung oder Aenderungen ohne lebende
 * Strecke -, fragt der Rueckweg nach, und ein Neuladen des Tabs geht nicht ohne Rueckfrage des Browsers.
 * Live verbunden ist eine Aenderung dagegen bereits beim Server; dann wird nicht gewarnt.
 *
 * Eigene Aenderungen bleiben gemerkt, bis ein `saved` des Raums sie bestaetigt (`unconfirmed-changes.ts`).
 * Nach jedem Beitritt geht genau das erneut hinaus, was der Raum davon noch nicht traegt - Arbeit vor dem
 * ersten Beitritt, waehrend einer Trennung und im Abbruch verlorene Nachrichten. Ein unveraendert geoeffnetes
 * Board schickt dagegen nichts und bekommt keine neue Version.
 *
 * ## Nur Lesen
 *
 * Das Schreibrecht behauptet diese Ansicht nicht selbst. Es steht schon in der Szenenantwort: sie nennt die
 * effektive Rolle des Anfragenden (`viewerRole`), und ob diese Rolle aendern darf, sagt `mayChangeBoard` -
 * dieselbe Funktion, mit der der Server entscheidet. Der Modus steht damit **vor** dem Beitritt in den
 * Boardraum fest und auch dann, wenn die Realtime-Strecke gar nicht zustande kommt. Aendert sich das Recht
 * waehrend der Sitzung (`access`), wechselt die Ansicht ohne Neuladen: die Zeichenflaeche geht in den
 * Lesemodus, die Speicheraktion verschwindet, und der Wechsel wird in einem `role="status"`-Bereich
 * benannt.
 *
 * ## Vorschau einer frueheren Version
 *
 * Mit `previewVersion` zeigt dieselbe Ansicht genau eine aufbewahrte Version. Sie ist **sicher read-only,
 * nicht bloss schreibgeschuetzt**: sie laedt ueber einen eigenen, nur lesenden Endpunkt, tritt keinem
 * Boardraum bei, kennt keine Ausgangsversion fuer eine Speicherung und bietet die Speicheraktion gar nicht
 * erst an. Es gibt damit keinen Weg, aus einer Vorschau versehentlich einen Schreibvorgang zu machen; wer
 * den Stand uebernehmen will, stellt ihn in der Versionsliste ausdruecklich wieder her.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  ArrowLeft,
  CloudCheck,
  CloudUpload,
  EllipsisVertical,
  History,
  Info,
  Pencil,
  Radio,
  RotateCcw,
  Save,
  Share2,
  Undo2,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import '@excalidraw/excalidraw/index.css'

import type { BoardStatusView, BoardView, MeResponse, WorkspaceView } from '../../contracts/api.js'
import type { PresenceView } from '../../contracts/realtime.js'
import type { BinaryFileRef, SceneSnapshot } from '../../contracts/scene.js'
import { SCENE_SCHEMA_VERSION } from '../../contracts/scene.js'
import { MAX_BOARD_TITLE_LENGTH } from '../../domain/board/model.js'
import type { EffectiveBoardRole } from '../../domain/board/policy.js'
import { mayChangeBoard, mayManageBoard } from '../../domain/board/policy.js'
import {
  ApiError,
  fetchBoardAssetDataUrl,
  fetchBoardScene,
  fetchBoardVersionScene,
  renameBoard,
  saveBoardScene,
  uploadBoardAsset,
} from '../api.js'
import { BoardPanel } from '../board-panel.js'
import { Dialog, Drawer, Menu, MenuItem } from '../overlays.js'
import type { BoardPanelView } from '../router.js'
import { Badge, Button, ConfirmDialog, describedBy, Field, IconButton, Loading, Notice } from '../ui.js'
import type { BoardStatus } from './board-status.js'
import { boardActions, boardStatus, readOnlyReason, sessionDetails } from './board-status.js'
import type { BoardEditorPort, EditorPeer } from './board-editor-port.js'
import { BoardCanvas, samePersistedAppState } from './excalidraw-adapter.js'
import { connectBoardRealtime } from './realtime-client.js'
import type { BoardRealtime, RealtimeStatus } from './realtime-client.js'
import { UnconfirmedChanges } from './unconfirmed-changes.js'

/** Ab hier steht die Informationsleiste als Spalte neben der Zeichenflaeche. Derselbe Wert in `styles.css`. */
const PANEL_DOCKED = '(min-width: 64rem)'

/** Die Informationsleiste ist derselbe Knoten, auf den ihr Ausloeser in der schwebenden Gruppe wirkt. */
const PANEL_ID = 'board-sidebar'

/** Das Symbol eines unkritischen Zustands. Kritische Zustaende stehen als Text da. */
const STATUS_SYMBOLS: Readonly<Record<NonNullable<BoardStatus['symbol']>, LucideIcon>> = {
  live: Radio,
  saving: CloudUpload,
  saved: CloudCheck,
}

/** Ruhezeit nach der letzten Aenderung, bevor gespeichert wird. */
const AUTOSAVE_DELAY_MS = 1_500

/**
 * Was diese Ansicht vom Board braucht: Titel und Status. Beide stehen in der Mitglieds- **und** in der
 * Gastsicht; alles Weitere (Arbeitsbereich, Owner) gehoert nicht in den Editor und erreicht einen Gast
 * ohnehin nicht.
 */
type Loaded = {
  readonly title: string
  readonly status: BoardStatusView
  /** `null` heisst: der aktuelle Stand. Sonst die Nummer der gezeigten Version. */
  readonly previewOf: number | null
  /** Effektive Rolle des Anfragenden, wie der Server sie nennt. Sie wird hier nicht ausgerechnet. */
  readonly role: EffectiveBoardRole
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
 * Der Mitgliedskontext eines Boards.
 *
 * `null` heisst Gast: kein Rueckweg in eine Bibliothek, keine Informationsleiste, kein Umbenennen. Ein Gast
 * kennt genau ein Board und keinen Arbeitsbereich - und die Endpunkte dahinter verlangen ohnehin eine
 * interne Sitzung.
 */
export type BoardMemberContext = {
  readonly me: MeResponse
  readonly workspace: WorkspaceView
  readonly workspaces: readonly WorkspaceView[]
  /** Offener Bereich der Informationsleiste; `null` heisst geschlossen. Er steht in der Adresse. */
  readonly panel: BoardPanelView | null
  readonly onPanel: (panel: BoardPanelView | null) => void
  /** Meldet der Huelle, dass sich an den Boards etwas geaendert hat. */
  readonly onChanged: () => void
  /** Wechselt in die Vorschau einer Version; `null` fuehrt zurueck auf den aktuellen Stand. */
  readonly onPreview: (version: number | null) => void
}

export function BoardEditor({
  boardId,
  csrfToken,
  workspaceArchived,
  previewVersion = null,
  guestName,
  member = null,
  onClose,
}: {
  readonly boardId: string
  /** Token der eigenen Sitzung - der internen oder der des Gastes. */
  readonly csrfToken: string
  readonly workspaceArchived: boolean
  /**
   * Nummer einer aufbewahrten Version. Gesetzt heisst: Read-only-Vorschau genau dieser Version - kein
   * Boardraum, keine Speicherung, keine Ausgangsversion. Fehlt sie, gilt der aktuelle Stand.
   */
  readonly previewVersion?: number | null
  /**
   * Selbst gewaehlter Anzeigename des Gastes; `null` fuer ein Mitglied. Rein beschreibend - ob jemand Gast
   * ist, steht in der Szenenantwort und nicht in dieser Angabe.
   */
  readonly guestName: string | null
  readonly member?: BoardMemberContext | null
  /** `null` heisst: es gibt keinen Weg zurueck. Genau das gilt fuer einen Gast. */
  readonly onClose: (() => void) | null
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
  /**
   * Vom Server aufgeloestes Schreibrecht. `null` heisst nur: die Szene ist noch nicht geladen.
   *
   * Danach kommt es aus der Rolle in der Szenenantwort und spaeter aus dem Boardraum (`joined`, `access`) -
   * beides Aussagen des Servers, beide ueber dieselbe Policy gebildet.
   */
  const [canWrite, setCanWrite] = useState<boolean | null>(null)
  /** Benannter Wechsel des Schreibrechts waehrend der Sitzung. */
  const [accessNote, setAccessNote] = useState<string | null>(null)
  const [peers, setPeers] = useState<readonly EditorPeer[]>([])
  /** Meldung ueber ein Bild, das nicht hochgeladen oder nicht geladen werden konnte. */
  const [assetProblem, setAssetProblem] = useState<string | null>(null)
  /** Erzwingt eine frische Zeichenflaeche beim Neuladen; sonst blieben verworfene Elemente stehen. */
  const [mountKey, setMountKey] = useState(0)
  /** Angedockt heisst: die Informationsleiste ist eine Spalte und kein modales Sheet. */
  const [docked, setDocked] = useState(() => window.matchMedia(PANEL_DOCKED).matches)
  /** Umbenennen im kurzen Dialog, geoeffnet aus dem Boardmenue. */
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  /** Zaehler fuer die Informationsleiste: er steigt, wenn hier etwas am Board geaendert wurde. */
  const [panelRevision, setPanelRevision] = useState(0)
  /** Rueckfrage vor dem Verlassen, solange ungesicherte Arbeit im Editor steht. */
  const [confirmLeave, setConfirmLeave] = useState(false)
  /** Hoehe der schwebenden Gruppen samt Meldungen; `null`, solange sie noch nicht vermessen sind. */
  const [floatHeight, setFloatHeight] = useState<number | null>(null)
  /** Letzter gespeicherter Stand dieser Sitzung - fuer "Informationen", auch wenn danach gezeichnet wird. */
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)

  // Refs statt State: der Speichervorgang liest den jeweils aktuellen Stand, ohne neu aufgebaut zu werden.
  const versionRef = useRef(0)
  const filesRef = useRef<Record<string, BinaryFileRef>>({})
  const blockedRef = useRef(false)
  /** Laufende Bilduploads. Solange einer offen ist, wird die Szene nicht gespeichert. */
  const uploadsRef = useRef(0)
  /** Lokale Realtime-Kennung des letzten zum Server vorgemerkten Standes. */
  const lastSentChangeSequenceRef = useRef(0)
  /**
   * Eigene Aenderungen, die der Raum noch nicht als gespeichert bestaetigt hat. Nur sie gehen nach einem
   * Beitritt erneut hinaus - nie der ganze Stand, der beim Laden von Excalidraw normalisiert wurde.
   */
  const unconfirmedRef = useRef(new UnconfirmedChanges())
  const clientRef = useRef<BoardRealtime | null>(null)
  /** Eigene fluechtige Kennung im Raum; sie trennt die anderen Teilnehmer vom eigenen Eintrag. */
  const selfRef = useRef<string | null>(null)
  /** Spiegel von `live` fuer die Rueckrufe des Editors, die nicht neu aufgebaut werden sollen. */
  const liveRef = useRef(false)
  /** Zuletzt vom Server genanntes Schreibrecht. Er unterscheidet die erste Aussage von einer Aenderung. */
  const canWriteRef = useRef<boolean | null>(null)
  /** Der Ausloeser der Informationsleiste. Angedockt gibt ihm die Ansicht den Fokus selbst zurueck. */
  const panelTriggerRef = useRef<HTMLButtonElement>(null)
  /** Das Titelfeld des Umbenennen-Dialogs. Es bekommt beim Oeffnen und nach einer Ablehnung den Fokus. */
  const renameInputRef = useRef<HTMLInputElement>(null)
  /** Die schwebenden Gruppen. Ihre Hoehe ist der obere Rand, den die Bedienelemente der Zeichenflaeche freihalten. */
  const floatRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    setState({ kind: 'loading' })
    setSave({ kind: 'idle' })
    setAssetProblem(null)
    setAdapter(null)
    setConnection('verbindet')
    setAttempt(0)
    setResyncedAt(null)
    setRejected(null)
    setCanWrite(null)
    canWriteRef.current = null
    setAccessNote(null)
    setPeers([])
    setMountKey((current) => current + 1)
    blockedRef.current = false
    uploadsRef.current = 0
    lastSentChangeSequenceRef.current = 0
    unconfirmedRef.current = new UnconfirmedChanges()
    // Zwei Endpunkte, zwei Bedeutungen: der aktuelle Stand des Boards oder genau eine aufbewahrte Version.
    // Die Vorschau kommt ueber einen nur lesenden Weg und traegt deshalb nie eine Ausgangsversion fuer eine
    // Speicherung; `versionRef` bleibt auf `0` und wird von nichts gelesen, was schreiben koennte.
    const laden =
      previewVersion === null
        ? fetchBoardScene(boardId)
        : fetchBoardVersionScene(boardId, previewVersion).then((response) => ({
            viewer: 'member' as const,
            board: response.board,
            version: response.version,
            scene: response.scene,
          }))
    laden
      .then((response) => {
        versionRef.current = previewVersion === null ? response.version : 0
        filesRef.current = { ...response.scene.files }
        // Verzweigt auf `viewer`: die Gastantwort traegt eine eigene, reduzierte Boardsicht. Titel, Status
        // und die eigene Rolle stehen in beiden - mehr braucht der Editor nicht.
        const role: EffectiveBoardRole =
          response.viewer === 'guest'
            ? { kind: 'guest', role: response.board.viewerRole }
            : { kind: 'member', role: response.board.viewerRole }
        // Der Modus steht damit sofort fest, ohne auf den Boardraum zu warten. Eine Vorschau schreibt nie.
        const erlaubt = previewVersion === null && mayChangeBoard(role)
        setCanWrite(erlaubt)
        canWriteRef.current = erlaubt
        setState({
          kind: 'ready',
          loaded: {
            title: response.board.title,
            status: response.board.status,
            previewOf: previewVersion,
            role,
            version: response.version,
            scene: response.scene,
          },
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
  }, [boardId, previewVersion])

  useEffect(load, [load])

  // Der Server entscheidet; die Oberflaeche folgt ihm. `canWrite` kommt aus dem Raum und beruht auf
  // derselben Policy wie die HTTP-API.
  const viewOnly =
    previewVersion !== null ||
    workspaceArchived ||
    canWrite === false ||
    (state.kind === 'ready' && state.loaded.status === 'archived')
  /** Live heisst: der Raum nimmt Aenderungen an und persistiert sie. Dann speichert die Ansicht nicht selbst. */
  const live = connection === 'verbunden' && !viewOnly
  liveRef.current = live
  /**
   * Nur wenn auf die Strecke kein Verlass mehr ist, speichert die Ansicht selbst. Waehrend eines laufenden
   * kurzen Wiederverbindungsversuchs bleibt die eigene Speicherung aus - der Raum hat den Stand gleich
   * wieder, und eine Speicherung dazwischen erzeugte nur einen Konflikt mit den Checkpoints.
   */
  const speichertSelbst = connection === 'getrennt' && !viewOnly
  /**
   * Ungesicherte Arbeit: sie liegt nur im Browser und wuerde beim Verlassen verschwinden.
   *
   * Live verbunden ist eine Aenderung bereits beim Server; `dirty` heisst dann nur, dass der naechste
   * Checkpoint noch aussteht. Konflikt und Fehlschlag sind dagegen immer ungesichert.
   */
  const unsaved =
    !viewOnly && (save.kind === 'conflict' || save.kind === 'failed' || (save.kind === 'dirty' && !live))

  // Ein Neuladen oder Schliessen des Tabs darf ungesicherte Arbeit nicht stillschweigend verwerfen. Den
  // Text bestimmt der Browser; die Anwendung sagt nur, dass es etwas zu verlieren gibt.
  useEffect(() => {
    if (!unsaved) {
      return
    }
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
    }
  }, [unsaved])

  // Der Dialog beginnt im Titelfeld. `showModal()` (im Effekt des Dialogs, der vor diesem laeuft) setzte den
  // Fokus sonst auf seine erste Schaltflaeche; die Rueckgabe an das Boardmenue uebernimmt die Plattform.
  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }
  }, [renaming])

  useEffect(() => {
    if (save.kind === 'saved') {
      setLastSavedAt(save.at)
    }
  }, [save])

  // Breit ist die Informationsleiste eine Spalte, schmal ein modales Sheet. Umgeschaltet wird per CSS; hier
  // steht nur, welche der beiden Formen die Plattform bedienen soll.
  useEffect(() => {
    const query = window.matchMedia(PANEL_DOCKED)
    const sync = (): void => {
      setDocked(query.matches)
    }
    query.addEventListener('change', sync)
    return () => {
      query.removeEventListener('change', sync)
    }
  }, [])

  // Die schwebenden Gruppen ueberdecken nichts: ihre Hoehe geht als oberer Sicherheitsabstand an die
  // Zeichenflaeche (`--sat` in `styles.css`), und deren Bedienelemente beginnen darunter. Gemessen wird,
  // weil Umbruch, Inline-Eingabe und Meldungen die Hoehe aendern - die Anordnung selbst bleibt CSS.
  useEffect(() => {
    const element = floatRef.current
    if (element === null) {
      return
    }
    const observer = new ResizeObserver(() => {
      setFloatHeight(Math.ceil(element.getBoundingClientRect().height))
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [state.kind])

  /** Der frisch geladene Boardstand aus der Sidebar. Titel und Archivzustand haengen daran. */
  const applyBoard = useCallback((board: BoardView) => {
    setState((current) =>
      current.kind === 'ready'
        ? { kind: 'ready', loaded: { ...current.loaded, title: board.title, status: board.status } }
        : current,
    )
  }, [])

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
            // Ohne Verbindung haelt der Client sie bis zum Beitritt; die Merkliste sorgt dafuer, dass sie
            // auch dann noch hinausgeht, wenn sie verschickt wurde und mit einem Abbruch verloren ging.
            const client = clientRef.current
            let sequence = 0
            if (client !== null) {
              client.sendChange([], null, [response.file.id])
              sequence = client.lastChangeSequence()
              lastSentChangeSequenceRef.current = sequence
            }
            unconfirmedRef.current.note([], false, [response.file.id], sequence)
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
      // Live geht die Aenderung sofort an den Raum. Sonst bleibt sie in der Merkliste und geht mit dem
      // naechsten Beitritt hinaus; bis dahin sichert ohne Strecke die HTTP-Speicherung.
      const client = liveRef.current ? clientRef.current : null
      let sequence = 0
      if (client !== null) {
        client.sendChange(change.changedElements, change.appState, [])
        sequence = client.lastChangeSequence()
        lastSentChangeSequenceRef.current = sequence
      }
      unconfirmedRef.current.note(
        change.changedElements.map((element) => element.id),
        change.appState !== null,
        [],
        sequence,
      )
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
    // Eine Vorschau tritt keinem Raum bei: sie zeigt einen Stand, der nicht der aktuelle ist, und wuerde
    // sonst fremde Aenderungen darueberlegen und die eigene Anzeige zum aktuellen Stand verschieben.
    if (adapter === null || state.kind !== 'ready' || previewVersion !== null) {
      return
    }
    let abandoned = false

    function zeigePeers(fremde: readonly EditorPeer[]): void {
      setPeers(fremde)
      adapter?.showPeers(fremde)
    }

    /** Schickt, was von den eigenen Aenderungen auf dieser Verbindung noch nicht hinausging. */
    function sendeUngesendete(): void {
      if (adapter === null) {
        return
      }
      const offen = unconfirmedRef.current.unsent()
      const elements = adapter.getElements().filter((element) => offen.elementIds.has(element.id))
      if (elements.length === 0 && !offen.appState && offen.fileIds.length === 0) {
        return
      }
      client.sendChange(elements, offen.appState ? adapter.getAppState() : null, offen.fileIds)
      lastSentChangeSequenceRef.current = client.lastChangeSequence()
      unconfirmedRef.current.markSent(lastSentChangeSequenceRef.current)
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
        canWriteRef.current = message.canWrite
        selfRef.current = message.clientId
        zeigePeers(fremdePeers(message.peers, message.clientId))
        if (adapter === null) {
          return
        }
        const unconfirmed = unconfirmedRef.current
        adapter.applyRemoteElements(message.scene.elements)
        const appStateInRoom = samePersistedAppState(message.scene.appState, adapter.getAppState())
        unconfirmed.rejoin(
          message.scene.elements,
          new Set(Object.keys(message.scene.files)),
          appStateInRoom,
          adapter.getElements(),
        )
        // Ein eigener AppState, den der Raum noch nicht kennt, wird nicht vom Raumstand ueberschrieben,
        // sondern geht gleich hinaus - wie ein eigenes Element mit hoeherer Version. Ohne Schreibrecht gilt
        // der Raumstand.
        if (!message.canWrite || !unconfirmed.unsent().appState) {
          adapter.applyRemoteAppState(message.scene.appState)
        }
        // Nur was der Raum noch nicht traegt, geht hinaus: Aenderungen vor dem ersten Beitritt, waehrend der
        // Trennung und solche, die verschickt, aber vor der Bestaetigung verloren gingen. Der unveraenderte
        // Rest des eigenen Stands bleibt zu Hause - er ist nach dem Laden nur normalisiert, nicht geaendert.
        if (message.canWrite) {
          sendeUngesendete()
        }
        if (unconfirmed.empty && uploadsRef.current === 0) {
          // Alles Eigene liegt bereits im Raum, etwa weil es vor dem Abbruch noch ankam. Es gibt nichts
          // mehr zu sichern, und ein `saved` kaeme dafuer nicht.
          setSave((current) => (current.kind === 'dirty' ? { kind: 'idle' } : current))
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
        // Der Wechsel wird benannt, statt die Flaeche stillschweigend umzuschalten. Die erste Aussage des
        // Servers ist keine Aenderung und bleibt deshalb ohne Hinweis.
        if (canWriteRef.current !== null && canWriteRef.current !== erlaubt) {
          setAccessNote(
            erlaubt
              ? 'Du darfst dieses Board jetzt wieder bearbeiten.'
              : 'Dein Schreibrecht fuer dieses Board wurde entzogen. Die Ansicht ist ab sofort schreibgeschuetzt.',
          )
        }
        canWriteRef.current = erlaubt
        setCanWrite(erlaubt)
        if (erlaubt) {
          // Wer beim Beitritt nicht schreiben durfte, hat seine offenen Aenderungen noch nicht geschickt.
          sendeUngesendete()
        }
        if (!erlaubt) {
          // `saving` kann hier nur der Checkpoint eines Mitbearbeiters sein; eigene Aenderungen stehen als
          // `dirty` da und bleiben deshalb sichtbar, wenn das Schreibrecht entzogen wird.
          setSave((current) => (current.kind === 'saving' ? { kind: 'idle' } : current))
        }
      },
      onSaved(message): void {
        versionRef.current = message.version
        const savedSequence = message.clientChangeSequence ?? 0
        unconfirmedRef.current.confirm(savedSequence)
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
  }, [adapter, boardId, previewVersion, state.kind])

  if (state.kind === 'loading') {
    return (
      <Frame title="Board" onClose={onClose}>
        <Loading text="Board wird geladen …" />
      </Frame>
    )
  }
  if (state.kind === 'not-found') {
    return (
      <Frame title="Board nicht gefunden" onClose={onClose}>
        <Notice text="Dieses Board ist nicht (mehr) fuer dich freigegeben oder existiert nicht." />
        {guestName !== null && (
          // Die haeufigste Ursache auf dem Gastweg: eine interne Sitzung im selben Browser. Sie hat Vorrang,
          // und dann entscheidet die eigene Berechtigung statt des Freigabelinks.
          <p className="hint">
            Bist du in diesem Browser mit einem Konto dieser Instanz angemeldet? Eine angemeldete Sitzung hat
            Vorrang vor einem Gastzugang - dann zaehlt deine eigene Berechtigung und nicht der Freigabelink.
            Melde dich ab und oeffne den Link erneut.
          </p>
        )}
      </Frame>
    )
  }
  if (state.kind === 'forbidden') {
    return (
      <Frame title="Kein Zugriff" onClose={onClose}>
        <Notice text={`Dafuer fehlt dir die Berechtigung. ${state.message}`} />
      </Frame>
    )
  }
  if (state.kind === 'failed') {
    return (
      <Frame title="Board" onClose={onClose}>
        <Notice>
          <p>{state.message}</p>
          <p className="actions">
            <button type="button" onClick={load}>
              Erneut laden
            </button>
          </p>
        </Notice>
      </Frame>
    )
  }

  const reason = readOnlyReason({
    workspaceArchived,
    boardArchived: state.loaded.status === 'archived',
    canWrite,
    guestViewer: state.loaded.role.kind === 'guest' && state.loaded.role.role === 'guest-viewer',
    previewOf: state.loaded.previewOf,
  })
  /** Ein Zustand statt dreier Saetze. Der ausformulierte Satz steht daneben und draengt sich nicht vor. */
  const status = boardStatus({
    save: save.kind,
    savedAt: save.kind === 'saved' ? save.at : null,
    failure: save.kind === 'failed' ? save.message : null,
    connection,
    attempt,
    resyncedAt,
    viewOnly,
    preview: state.loaded.previewOf !== null,
  })
  const title = state.loaded.title
  /**
   * Umbenennen darf, wer das Board aendern darf.
   *
   * Ueber `viewOnly` haengt das an derselben Aussage des Servers wie die Zeichenflaeche - Vorschau, Archiv
   * und entzogenes Schreibrecht stehen dort schon. Wird das Recht **waehrend** der Sitzung entzogen,
   * verschwindet damit auch diese Aktion, statt eine Ablehnung anzubieten.
   */
  const titleEditable = member !== null && !viewOnly && mayChangeBoard(state.loaded.role)
  /** Freigeben darf nur, wer sie auch ausfuehren darf. Hervorgehoben ist sie nur ohne dringendere Handlung. */
  const shareable = member !== null && state.loaded.previewOf === null && mayManageBoard(state.loaded.role)
  /** Hoechstens eine hervorgehobene Aktion; "Jetzt speichern" nur, wo der Nutzer handeln muss. */
  const actions = boardActions({
    save: save.kind,
    connection,
    viewOnly,
    preview: state.loaded.previewOf !== null && member !== null,
    shareable,
  })
  const panelOpen = member !== null && member.panel !== null
  const StatusSymbol = status.symbol === null ? null : STATUS_SYMBOLS[status.symbol]
  /** Was die Gruppe nur als Symbol zeigt, steht in den Informationen ausgeschrieben. */
  const details = sessionDetails({
    lastSavedAt,
    connection,
    attempt,
    resyncedAt,
    preview: state.loaded.previewOf !== null,
  })

  function closePanel(): void {
    member?.onPanel(null)
    // Angedockt gibt es keine Plattformrueckgabe des Fokus: die Ansicht bringt ihn selbst zum Ausloeser.
    if (docked) {
      panelTriggerRef.current?.focus()
    }
  }

  function submitRename(next: string): void {
    if (member === null) {
      return
    }
    setRenameBusy(true)
    setRenameError(null)
    renameBoard(member.me.csrfToken, boardId, next)
      .then((board) => {
        applyBoard(board)
        setRenaming(false)
        setPanelRevision((current) => current + 1)
        member.onChanged()
      })
      .catch((cause: unknown) => {
        // Die Eingabe bleibt stehen; der Fokus kehrt in das Feld zurueck, das die Meldung beschreibt.
        setRenameError(
          cause instanceof ApiError ? cause.message : 'Der Titel konnte nicht geaendert werden.',
        )
        renameInputRef.current?.focus()
      })
      .finally(() => {
        setRenameBusy(false)
      })
  }

  /** Wer gerade mit dabei ist - fuer den Kurzhinweis und fuer Hilfsmittel derselbe Satz. */
  const peersText =
    peers.length === 0 ? 'Allein auf diesem Board.' : `Mit dabei: ${peers.map((peer) => peer.displayName).join(', ')}`

  return (
    <div
      className={panelOpen ? 'board board--panel' : 'board'}
      style={floatHeight === null ? undefined : ({ '--board-float': `${String(floatHeight)}px` } as CSSProperties)}
    >
      {/*
        * Die schwebenden Gruppen liegen ueber der Zeichenflaeche und reservieren keine Zeile. Sie stehen im
        * Dokument vor der Informationsleiste: so folgt auf ihren Ausloeser unmittelbar das, was er oeffnet.
        */}
      <div className="board__float" ref={floatRef}>
        <div className="board__group board__group--lead">
          {onClose !== null && (
            <IconButton
              label="Zurueck zur Bibliothek"
              icon={ArrowLeft}
              variant="quiet"
              onClick={() => {
                if (unsaved) {
                  setConfirmLeave(true)
                  return
                }
                onClose()
              }}
            />
          )}
          {/* Gekuerzt wird nur die Anzeige; der volle Titel steht als Kurzhinweis daran. */}
          <h1 className="board__title" title={title}>
            {title}
          </h1>
          {/*
            * Das Boardmenue haelt das Seltene: Umbenennen - sein einziger Ort - und die Wege in die Bereiche
            * der Informationen. Diese sind kein zweiter Ort: jeder Eintrag oeffnet genau den Bereich, in dem
            * die Handlung ohnehin steht.
            */}
          {member !== null && (
            <Menu label={`Boardmenue fuer ${title}`} icon={EllipsisVertical}>
              {titleEditable && (
                <MenuItem
                  icon={Pencil}
                  onSelect={() => {
                    setTitleDraft(title)
                    setRenameError(null)
                    setRenaming(true)
                  }}
                >
                  Umbenennen
                </MenuItem>
              )}
              <MenuItem
                icon={Info}
                onSelect={() => {
                  member.onPanel('uebersicht')
                }}
              >
                Uebersicht und Ablage
              </MenuItem>
              <MenuItem
                icon={History}
                onSelect={() => {
                  member.onPanel('versionen')
                }}
              >
                Versionen
              </MenuItem>
            </Menu>
          )}
        </div>

        <div className="board__group board__group--work">
          <p
            className={peers.length === 0 ? 'board__peers board__peers--allein' : 'board__peers'}
            role="status"
            title={peersText}
          >
            <Users size={16} aria-hidden="true" />
            <span className="board__peers-count" aria-hidden="true">
              {peers.length === 0 ? 'Allein' : String(peers.length + 1)}
            </span>
            <span className="visually-hidden">{peersText}</span>
          </p>
          {/* Der Modus bleibt sichtbar: er entscheidet, was diese Ansicht ueberhaupt anbietet. */}
          {reason !== null && (
            <Badge tone={state.loaded.previewOf === null ? 'neutral' : 'accent'}>
              {state.loaded.previewOf === null
                ? 'Nur lesen'
                : `Version ${String(state.loaded.previewOf)} · nur lesen`}
              <span className="visually-hidden">: {reason}</span>
            </Badge>
          )}
          {guestName !== null && <Badge>Gast: {guestName}</Badge>}
          {StatusSymbol === null ? (
            <p className={`board__status board__status--${status.tone}`} title={status.detail}>
              {status.text}
              <span className="visually-hidden">. {status.detail}</span>
            </p>
          ) : (
            // In Ordnung: nur das Symbol. Name und Satz bleiben fuer Hilfsmittel und als Kurzhinweis.
            <p
              className={`board__status board__status--symbol board__status--${status.tone}`}
              title={status.detail}
            >
              <StatusSymbol size={18} aria-hidden="true" />
              <span className="visually-hidden">
                {status.text}. {status.detail}
              </span>
            </p>
          )}
          {/*
            * Angekuendigt wird nur, was Aufmerksamkeit verlangt. Ein gelungener Checkpoint ist sichtbar,
            * bleibt aber stumm - sonst spraeche eine Sprachausgabe waehrend des Zeichnens im Sekundentakt.
            */}
          <p className="visually-hidden" role="status">
            {status.critical ? status.detail : ''}
          </p>
          {state.loaded.previewOf !== null && member !== null && (
            <Button
              variant={actions.primary === 'current' ? 'primary' : 'normal'}
              icon={Undo2}
              onClick={() => {
                member.onPreview(null)
              }}
            >
              Zum aktuellen Stand
            </Button>
          )}
          {save.kind === 'conflict' && (
            <Button variant={actions.primary === 'reload' ? 'primary' : 'normal'} icon={RotateCcw} onClick={load}>
              Neu laden
            </Button>
          )}
          {/*
            * Manuell gespeichert wird nur, wo der Nutzer handeln muss: nach einem Fehlschlag oder mit Aenderungen
            * bei getrennter Strecke. Waehrend Aufbau und Wiederverbindung nicht - der Zustand steht ohnehin da.
            */}
          {actions.saveNow && (
            <Button
              variant={actions.primary === 'save' ? 'primary' : 'normal'}
              icon={Save}
              onClick={persist}
              disabled={adapter === null}
            >
              Jetzt speichern
            </Button>
          )}
          {/* Auf jeder Breite nur das Symbol; der Name bleibt fuer Hilfsmittel und als Kurzhinweis. */}
          {shareable && member !== null && (
            <IconButton
              label="Freigeben"
              icon={Share2}
              variant={actions.primary === 'share' ? 'primary' : 'normal'}
              onClick={() => {
                member.onPanel('freigaben')
              }}
            />
          )}
          {member !== null && (
            <IconButton
              ref={panelTriggerRef}
              label={panelOpen ? 'Informationen schliessen' : 'Informationen oeffnen'}
              icon={Info}
              variant="quiet"
              aria-expanded={panelOpen}
              aria-controls={PANEL_ID}
              onClick={() => {
                if (panelOpen) {
                  closePanel()
                  return
                }
                member.onPanel('uebersicht')
              }}
            />
          )}
        </div>

        {/* Meldungen schweben unter den Gruppen; die Bedienelemente der Zeichenflaeche ruecken mit. */}
        <div className="board__notices">
          {confirmLeave && onClose !== null && (
            <ConfirmDialog danger>
              <p>
                An diesem Board stehen Aenderungen, die noch nicht gesichert sind. Beim Verlassen gehen sie
                verloren.
              </p>
              <p className="actions">
                <Button
                  onClick={() => {
                    setConfirmLeave(false)
                  }}
                >
                  Hierbleiben
                </Button>
                <Button variant="danger" onClick={onClose}>
                  Trotzdem schliessen
                </Button>
              </p>
            </ConfirmDialog>
          )}
          {accessNote !== null && (
            <Notice kind="info">
              <p>{accessNote}</p>
              <p className="actions">
                <Button
                  onClick={() => {
                    setAccessNote(null)
                  }}
                >
                  Hinweis ausblenden
                </Button>
              </p>
            </Notice>
          )}
          {assetProblem !== null && <Notice text={assetProblem} />}
          {rejected !== null && (
            <Notice>
              <p>Der Server hat eine Nachricht abgelehnt: {rejected}</p>
              <p className="actions">
                <Button
                  onClick={() => {
                    setRejected(null)
                  }}
                >
                  Hinweis ausblenden
                </Button>
              </p>
            </Notice>
          )}
          {save.kind === 'conflict' && (
            <Notice text="Dieses Board wurde inzwischen an anderer Stelle gespeichert. Deine Zeichnung ist noch da, wurde aber nicht uebernommen und hat nichts ueberschrieben. Lade das Board neu, um auf dem aktuellen Stand weiterzuarbeiten." />
          )}
        </div>
      </div>

      <div className="board__body">
        {member !== null && (
          /*
           * Ein Knoten fuer beide Breiten: angedockt macht `styles.css` aus dem `dialog` eine gewoehnliche
           * Spalte, schmal bleibt er ein modales Sheet - dann kommen Fokusfang, Escape und Fokusrueckgabe
           * von der Plattform, und die Zeichenflaeche dahinter ist `inert`.
           *
           * Er steht **vor** der Zeichenflaeche im Dokument: sonst laegen angedockt die zwoelf Tabstopps
           * der Excalidraw-Bedienelemente zwischen dem Ausloeser in der schwebenden Gruppe und dem, was er
           * geoeffnet hat. Rechts erscheint er trotzdem - das erledigt `order` in `styles.css`.
           */
          <Drawer
            id={PANEL_ID}
            open={panelOpen && !docked}
            title="Informationen"
            className="board__panel"
            onClose={closePanel}
          >
            {member.panel !== null && (
              <BoardPanel
                me={member.me}
                workspace={member.workspace}
                workspaces={member.workspaces}
                boardId={boardId}
                section={member.panel}
                revision={panelRevision}
                onSection={member.onPanel}
                onChanged={member.onChanged}
                onBoard={applyBoard}
                onPreview={member.onPreview}
                session={{ state: status.detail, ...details }}
              />
            )}
          </Drawer>
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

      {/*
        * Umbenennen als kurzer Dialog. Er steht ausserhalb der schwebenden Ebene, die keine Zeigerereignisse
        * annimmt. Der Fokus beginnt im Titelfeld und kehrt beim Schliessen zum Boardmenue zurueck; eine
        * Ablehnung steht am Feld, und die Eingabe bleibt erhalten.
        */}
      {member !== null && (
        <Dialog
          open={renaming && titleEditable}
          title="Board umbenennen"
          onClose={() => {
            setRenaming(false)
          }}
        >
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault()
              if (!renameBusy) {
                submitRename(titleDraft.trim())
              }
            }}
          >
            <Field id="board-title" label="Titel" {...(renameError === null ? {} : { error: renameError })}>
              <input
                ref={renameInputRef}
                id="board-title"
                value={titleDraft}
                maxLength={MAX_BOARD_TITLE_LENGTH}
                required
                readOnly={renameBusy}
                aria-invalid={renameError !== null || undefined}
                aria-describedby={describedBy('board-title', false, renameError !== null)}
                onChange={(event) => {
                  setTitleDraft(event.target.value)
                }}
              />
            </Field>
            <p className="actions">
              <Button
                variant="primary"
                type="submit"
                busy={renameBusy}
                disabled={titleDraft.trim().length === 0}
              >
                Umbenennen
              </Button>
              <Button
                variant="quiet"
                disabled={renameBusy}
                onClick={() => {
                  setRenaming(false)
                }}
              >
                Abbrechen
              </Button>
            </p>
          </form>
        </Dialog>
      )}
    </div>
  )
}

function Frame({
  title,
  onClose,
  children,
}: {
  readonly title: string
  /** `null` heisst: kein Rueckweg. Ein Gast hat keine Boardliste, zu der er zurueckkehren koennte. */
  readonly onClose: (() => void) | null
  readonly children: ReactNode
}) {
  return (
    <section className="shell" aria-labelledby="board-frame-heading">
      <h2 id="board-frame-heading">{title}</h2>
      {children}
      {onClose !== null && (
        <p className="actions">
          <button className="button--primary" type="button" onClick={onClose}>
            Zurueck zur Boardliste
          </button>
        </p>
      )}
    </section>
  )
}
