/**
 * Die Board-Sidebar: alle umfangreicheren Aufgaben genau eines Boards, neben seiner Zeichenflaeche.
 *
 * Sie loest die fruehere Detailseite ab. Ablage, Arbeitsbereichswechsel, Freigaben, Versionen,
 * Import/Export, Archiv und Papierkorb standen dort weit weg vom Board; jetzt stehen sie daneben, und der
 * Boardkontext bleibt waehrend der Handlung sichtbar. Fuer dieselbe Handlung gibt es damit **einen** Ort -
 * die alte Adresse fuehrt hierher (siehe `router.tsx`).
 *
 * Drei Bereiche, weil sie drei verschiedene Fragen beantworten: **Uebersicht** (wo liegt das Board, wem
 * gehoert es, wie geht es weg), **Freigaben** (wer darf es) und **Versionen** (was war frueher, was geht
 * rein und raus). Der offene Bereich steht in der Adresse; ein `history.back()` schliesst die Sidebar.
 *
 * Die Ansicht entscheidet nichts. Was sie anbietet, leitet sie aus der vom Server genannten Rolle mit
 * **denselben** Funktionen ab, mit denen der Server entscheidet (`mayChangeBoard`, `mayManageBoard`,
 * `mayRestoreBoard`); jede Ablehnung erscheint als Text. Freigaben und Versionen kommen unveraendert aus
 * `board-share.tsx` und `board-versions.tsx` - hier entsteht keine zweite Fachlogik.
 *
 * Ein Gast erreicht diese Sidebar nicht: sie wird nur im Mitgliedskontext gerendert, und jeder ihrer
 * Endpunkte verlangt ohnehin eine interne Sitzung.
 */

import { useCallback, useEffect, useState } from 'react'
import { Archive, ArchiveRestore, History, Info, Share2, Trash2 } from 'lucide-react'

import type { BoardRoleView, BoardView, FolderView, MeResponse, WorkspaceView } from '../contracts/api.js'
import type { EffectiveBoardRole } from '../domain/board/policy.js'
import { mayChangeBoard, mayManageBoard, mayRestoreBoard } from '../domain/board/policy.js'
import {
  ApiError,
  fetchBoardGrants,
  fetchFolders,
  moveBoardToFolder,
  moveBoardToWorkspace,
  setBoardStatus,
  trashBoard,
} from './api.js'
import { BoardShare } from './board-share.js'
import { BoardVersions } from './board-versions.js'
import { FolderSelect } from './folders.js'
import type { BoardPanelView } from './router.js'
import { navigate } from './router.js'
import { Button, ConfirmDialog, Loading, Notice } from './ui.js'

const ROLE_LABELS: Readonly<Record<BoardRoleView, string>> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer',
}

const SECTIONS: readonly { readonly id: BoardPanelView; readonly label: string }[] = [
  { id: 'uebersicht', label: 'Uebersicht' },
  { id: 'freigaben', label: 'Freigaben' },
  { id: 'versionen', label: 'Versionen' },
]

/** Uebersetzt eine Serverantwort in einen Satz. 404 und 403 bekommen bewusst eigene Texte. */
function messageOf(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) {
    return fallback
  }
  if (cause.status === 404) {
    return 'Dieses Board ist nicht (mehr) fuer dich freigegeben oder existiert nicht.'
  }
  if (cause.status === 403) {
    return `Dafuer fehlt dir die Berechtigung. ${cause.message}`
  }
  return cause.message
}

/** Die Rolle, die der Server fuer dieses Board nennt - in der Form, in der die Policy sie liest. */
function viewerRoleOf(board: BoardView): EffectiveBoardRole {
  return { kind: 'member', role: board.viewerRole }
}

/**
 * Wechsel des Arbeitsbereichs.
 *
 * Zwei Schritte, weil er nicht folgenlos ist: die Wirkung steht **vor** dem Ausloesen da, und erst eine
 * ausdrueckliche Bestaetigung schickt ihn ab. Das Board landet im Ziel unmittelbar im Arbeitsbereich; in
 * einen Ordner legt es dort dieselbe Sidebar im naechsten Schritt.
 *
 * qatlas-dev: bewusst ohne Ordnerwahl im Ziel - dafuer muesste diese Ansicht den fremden Ordnerbaum
 * mitladen. Ergaenzen, sobald jemand regelmaessig ueber Arbeitsbereiche hinweg einsortiert.
 */
function MoveToWorkspace({
  me,
  board,
  workspaces,
  onMoved,
  onError,
}: {
  readonly me: MeResponse
  readonly board: BoardView
  readonly workspaces: readonly WorkspaceView[]
  readonly onMoved: (board: BoardView) => void
  readonly onError: (message: string) => void
}) {
  const [targetId, setTargetId] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  // Angeboten wird, was ueberhaupt ein Ziel sein kann: ein anderer, aktiver Arbeitsbereich mit eigener
  // Mitgliedschaft. Ob dort ein Board angelegt werden darf, entscheidet weiterhin der Endpunkt.
  const targets = workspaces.filter(
    (entry) => entry.id !== board.workspaceId && entry.status === 'active' && entry.role !== null,
  )
  const selected = targets.find((entry) => entry.id === targetId) ?? null

  if (targets.length === 0) {
    return <p className="hint">Es gibt keinen weiteren aktiven Arbeitsbereich, in den dieses Board wechseln koennte.</p>
  }

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="board-target-workspace">Neuer Arbeitsbereich dieses Boards</label>
        <select
          id="board-target-workspace"
          aria-describedby="board-target-hint"
          value={targetId}
          onChange={(event) => {
            setTargetId(event.target.value)
            setConfirming(false)
          }}
        >
          <option value="">Bitte auswaehlen</option>
          {targets.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </div>
      <p className="hint" id="board-target-hint">
        Beim Wechsel <strong>entfallen alle internen Freigaben</strong> dieses Boards, und{' '}
        <strong>jeder noch gueltige Gastlink wird widerrufen</strong>: beide gelten Personen des bisherigen
        Arbeitsbereichs. Offene Verbindungen werden dabei geschlossen. Das Board liegt danach unmittelbar im
        Ziel und kann dort in einen Ordner gelegt werden.
      </p>
      {!confirming && (
        <p>
          <Button
            disabled={selected === null}
            onClick={() => {
              setConfirming(true)
            }}
          >
            Arbeitsbereich wechseln
          </Button>
        </p>
      )}
      {confirming && selected !== null && (
        <ConfirmDialog>
          <p>
            <strong>{board.title}</strong> wirklich nach <strong>{selected.name}</strong> verschieben? Die
            internen Freigaben und die Gastlinks dieses Boards enden damit.
          </p>
          <p className="actions">
            <Button
              variant="primary"
              busy={busy}
              onClick={() => {
                setBusy(true)
                onError('')
                moveBoardToWorkspace(me.csrfToken, { boardId: board.id, workspaceId: selected.id })
                  .then((moved) => {
                    setConfirming(false)
                    setTargetId('')
                    onMoved(moved)
                  })
                  .catch((cause: unknown) => {
                    onError(messageOf(cause, 'Das Board konnte nicht verschoben werden.'))
                  })
                  .finally(() => {
                    setBusy(false)
                  })
              }}
            >
              Ja, nach {selected.name} verschieben
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirming(false)
              }}
            >
              Wechsel abbrechen
            </Button>
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}

/**
 * Loeschen in den Papierkorb.
 *
 * Ebenfalls zwei Schritte: das Board verschwindet damit sofort aus jeder Liste, und jeder interne wie
 * externe Zugriff endet. Zurueckzunehmen ist es nur noch im Papierkorb des Arbeitsbereichs.
 */
function TrashBoard({
  me,
  board,
  onTrashed,
  onError,
}: {
  readonly me: MeResponse
  readonly board: BoardView
  readonly onTrashed: () => void
  readonly onError: (message: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    <div className="stack">
      <p className="hint">
        Geloescht wird in den Papierkorb dieses Arbeitsbereichs. Von dort laesst sich das Board bis zum Ende
        der Aufbewahrungsfrist zuruecknehmen.
      </p>
      {!confirming ? (
        <p>
          <Button
            icon={Trash2}
            onClick={() => {
              setConfirming(true)
            }}
          >
            Board loeschen
          </Button>
        </p>
      ) : (
        <ConfirmDialog danger>
          <p>
            <strong>{board.title}</strong> wirklich in den Papierkorb legen? Das Board verschwindet sofort aus
            allen Listen, laesst sich nicht mehr oeffnen, und jeder Freigabe- und Gastzugriff endet.
          </p>
          <p className="actions">
            <Button
              variant="danger"
              busy={busy}
              onClick={() => {
                setBusy(true)
                onError('')
                trashBoard(me.csrfToken, board.id)
                  .then(() => {
                    onTrashed()
                  })
                  .catch((cause: unknown) => {
                    onError(messageOf(cause, 'Das Board konnte nicht geloescht werden.'))
                    setBusy(false)
                  })
              }}
            >
              Ja, {board.title} in den Papierkorb legen
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirming(false)
              }}
            >
              Loeschen abbrechen
            </Button>
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}

/** Uebersicht und Ablage: wo das Board liegt, wem es gehoert und wie es den Arbeitsbereich verlaesst. */
function Overview({
  me,
  workspace,
  workspaces,
  board,
  folders,
  busy,
  onRun,
  onApply,
  onError,
  onChanged,
}: {
  readonly me: MeResponse
  readonly workspace: WorkspaceView
  readonly workspaces: readonly WorkspaceView[]
  readonly board: BoardView
  readonly folders: readonly FolderView[]
  readonly busy: boolean
  readonly onRun: (action: Promise<BoardView>, fallback: string) => void
  readonly onApply: (board: BoardView) => void
  readonly onError: (message: string) => void
  readonly onChanged: () => void
}) {
  const workspaceActive = workspace.status === 'active'
  /** Was der Server fuer diese Rolle zulaesst - nicht, was diese Ansicht fuer richtig haelt. */
  const role = viewerRoleOf(board)
  const editable = workspaceActive && mayChangeBoard(role)
  /** Stammdaten sind an einem archivierten Board unveraenderlich; die Archivierung selbst nicht. */
  const changeable = editable && board.status === 'active'
  const responsible = workspaceActive && mayRestoreBoard(role, workspace.role)
  const folderName = folders.find((entry) => entry.id === board.folderId)?.name ?? null

  return (
    <>
      <dl className="details">
        <dt>Arbeitsbereich</dt>
        <dd>
          {workspace.name}
          {workspaceActive ? '' : ' (archiviert)'}
        </dd>
        <dt>Ordner</dt>
        <dd>{folderName ?? 'Arbeitsbereich (kein Ordner)'}</dd>
        <dt>Owner</dt>
        <dd>
          {board.ownerDisplayName}
          {board.ownerUserId === me.user.id && ' (du)'}
        </dd>
        <dt>Status</dt>
        <dd>{board.status === 'active' ? 'aktiv' : 'archiviert'}</dd>
        <dt>Eigene Rolle</dt>
        <dd>{ROLE_LABELS[board.viewerRole]}</dd>
        <dt>Stand</dt>
        <dd>{board.sceneVersion === 0 ? 'noch leer' : `Version ${String(board.sceneVersion)}`}</dd>
        <dt>Geaendert</dt>
        <dd>{new Date(board.updatedAt).toLocaleString('de-DE')}</dd>
      </dl>

      {!workspaceActive && (
        <p className="hint">
          Dieser Arbeitsbereich ist archiviert. Seine Boards bleiben lesbar, aenderbar sind sie erst nach dem
          Entarchivieren.
        </p>
      )}
      {!editable && workspaceActive && (
        <p className="hint">
          Deine Rolle auf diesem Board traegt keine Aenderung. Ansehen und Versionen bleiben dir offen.
        </p>
      )}

      {editable && (
        <>
          <h4 className="sidebar__title">Ablage</h4>
          <FolderSelect
            id="board-folder"
            label={`Ordner von ${board.title}`}
            folders={folders}
            value={board.folderId}
            disabled={busy || !changeable}
            onChange={(folderId) => {
              onRun(
                moveBoardToFolder(me.csrfToken, board.id, folderId),
                'Das Board konnte nicht verschoben werden.',
              )
            }}
          />
          {!changeable && <p className="hint">Ein archiviertes Board wird nicht verschoben.</p>}

          <h4 className="sidebar__title">Archiv</h4>
          <p>
            <Button
              icon={board.status === 'active' ? Archive : ArchiveRestore}
              busy={busy}
              onClick={() => {
                onRun(
                  setBoardStatus(me.csrfToken, board.id, board.status === 'active' ? 'archived' : 'active'),
                  'Der Status konnte nicht geaendert werden.',
                )
              }}
            >
              {board.status === 'active' ? 'Board archivieren' : 'Board reaktivieren'}
            </Button>
          </p>
          <p className="hint">
            Ein archiviertes Board bleibt lesbar und in jeder Liste auffindbar; geaendert wird es erst nach
            der Reaktivierung.
          </p>
        </>
      )}

      {responsible && (
        <>
          <h4 className="sidebar__title">Arbeitsbereich wechseln</h4>
          <MoveToWorkspace
            me={me}
            board={board}
            workspaces={workspaces}
            onMoved={(moved) => {
              // Erst die neue Boardsicht uebernehmen, dann die Adresse: sonst zeigte die Sidebar noch auf
              // den bisherigen Arbeitsbereich und der Abgleich der Huelle schickte sie dorthin zurueck.
              onApply(moved)
              navigate({
                kind: 'board',
                workspaceId: moved.workspaceId,
                boardId: moved.id,
                version: null,
                panel: 'uebersicht',
              })
            }}
            onError={onError}
          />

          <h4 className="sidebar__title">Papierkorb</h4>
          <TrashBoard
            me={me}
            board={board}
            onTrashed={() => {
              onChanged()
              navigate({ kind: 'papierkorb', workspaceId: workspace.id })
            }}
            onError={onError}
          />
        </>
      )}
    </>
  )
}

export function BoardPanel({
  me,
  workspace,
  workspaces,
  boardId,
  section,
  revision,
  onSection,
  onChanged,
  onBoard,
  onPreview,
}: {
  readonly me: MeResponse
  /** Der Arbeitsbereich der Adresse. */
  readonly workspace: WorkspaceView
  readonly workspaces: readonly WorkspaceView[]
  readonly boardId: string
  readonly section: BoardPanelView
  /** Zaehler des Editors: er steigt, wenn dort etwas am Board geaendert wurde (etwa der Titel). */
  readonly revision: number
  readonly onSection: (section: BoardPanelView) => void
  /** Meldet der Huelle, dass sich an den Boards etwas geaendert hat. */
  readonly onChanged: () => void
  /** Meldet dem Editor den frisch geladenen Stand des Boards - Titel und Archivzustand haengen daran. */
  readonly onBoard: (board: BoardView) => void
  /** Oeffnet die Read-only-Vorschau genau einer Version. */
  readonly onPreview: (version: number) => void
}) {
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly board: BoardView }
    | { readonly kind: 'failed'; readonly message: string }
  >({ kind: 'loading' })
  const [folders, setFolders] = useState<readonly FolderView[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetchBoardGrants(boardId)
      .then((response) => {
        setState({ kind: 'ready', board: response.board })
        onBoard(response.board)
      })
      .catch((cause: unknown) => {
        setState({ kind: 'failed', message: messageOf(cause, 'Das Board konnte nicht geladen werden.') })
      })
    // Neu geladen wird bei einem anderen Board und wenn der Editor eine Aenderung meldet (`revision`).
    // `onBoard` ist nur der Rueckkanal dorthin und darf das Laden nicht ausloesen.
  }, [boardId, revision, onBoard])

  useEffect(load, [load])

  const workspaceId = workspace.id
  useEffect(() => {
    fetchFolders(workspaceId)
      .then((response) => {
        setFolders(response.folders)
      })
      .catch(() => {
        setFolders([])
      })
  }, [workspaceId])

  const tabs = (
    <div className="board__sections" role="group" aria-label="Bereich der Board-Sidebar">
      {SECTIONS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={entry.id === section ? 'board__section board__section--aktiv' : 'board__section'}
          aria-current={entry.id === section ? 'true' : undefined}
          onClick={() => {
            onSection(entry.id)
          }}
        >
          {entry.id === 'uebersicht' && <Info size={16} aria-hidden="true" />}
          {entry.id === 'freigaben' && <Share2 size={16} aria-hidden="true" />}
          {entry.id === 'versionen' && <History size={16} aria-hidden="true" />}
          {entry.label}
        </button>
      ))}
    </div>
  )

  if (state.kind === 'loading') {
    return (
      <>
        {tabs}
        <Loading text="Das Board wird geladen …" />
      </>
    )
  }
  if (state.kind === 'failed') {
    return (
      <>
        {tabs}
        <Notice text={state.message} />
      </>
    )
  }

  const board = state.board
  const manageable = mayManageBoard(viewerRoleOf(board))

  function apply(updated: BoardView): void {
    setState({ kind: 'ready', board: updated })
    onBoard(updated)
    onChanged()
  }

  function run(action: Promise<BoardView>, fallback: string): void {
    setBusy(true)
    setActionError(null)
    action
      .then(apply)
      .catch((cause: unknown) => {
        setActionError(messageOf(cause, fallback))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  function reportError(message: string): void {
    setActionError(message === '' ? null : message)
  }

  return (
    <>
      {tabs}
      {actionError !== null && <Notice text={actionError} />}
      {section === 'uebersicht' && (
        <Overview
          me={me}
          workspace={workspace}
          workspaces={workspaces}
          board={board}
          folders={folders}
          busy={busy}
          onRun={run}
          onApply={apply}
          onError={reportError}
          onChanged={onChanged}
        />
      )}
      {section === 'freigaben' && (
        <>
          {!manageable && <p className="hint">Aendern kann die Freigaben der Owner dieses Boards.</p>}
          <BoardShare me={me} boardId={board.id} onChanged={load} />
        </>
      )}
      {section === 'versionen' && (
        <BoardVersions
          me={me}
          boardId={board.id}
          workspaceArchived={workspace.status !== 'active'}
          onPreview={onPreview}
          onChanged={() => {
            load()
            onChanged()
          }}
        />
      )}
    </>
  )
}
