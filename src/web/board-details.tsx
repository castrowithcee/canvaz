/**
 * Detailansicht genau eines Boards: seine Angaben und **alle** seine Aktionen an einer Stelle.
 *
 * Sie loest die verstreuten Aktionen der Boardzeile ab. Die Liste verweist nur noch hierher; umbenennen,
 * ablegen, archivieren, freigeben, Versionen ansehen, in einen anderen Arbeitsbereich verschieben und
 * loeschen stehen hier gemeinsam. Freigaben und Versionen kommen unveraendert aus `board-share.tsx` und
 * `board-versions.tsx` - beide sind bereits Abschnitte im Fluss der Seite und bleiben es.
 *
 * Die Ansicht entscheidet nichts. Was sie anbietet, leitet sie aus der vom Server genannten Rolle mit
 * **denselben** Funktionen ab, mit denen der Server entscheidet (`mayChangeBoard`, `mayManageBoard`,
 * `mayRestoreBoard`); jede Ablehnung erscheint als Text. Ein Gast erreicht diese Ansicht nicht - sie steht
 * in der angemeldeten Huelle, und jeder ihrer Endpunkte verlangt eine interne Sitzung.
 *
 * Die Boardsicht kommt aus der Freigabeliste: sie ist der lesende Endpunkt, der ein Board ohne seine Szene
 * liefert, und verlangt genau das Leserecht.
 */

import { useCallback, useEffect, useState } from 'react'

import type { BoardRoleView, BoardView, FolderView, MeResponse, WorkspaceView } from '../contracts/api.js'
import { MAX_BOARD_TITLE_LENGTH } from '../domain/board/model.js'
import type { EffectiveBoardRole } from '../domain/board/policy.js'
import { mayChangeBoard, mayManageBoard, mayRestoreBoard } from '../domain/board/policy.js'
import {
  ApiError,
  fetchBoardGrants,
  fetchFolders,
  moveBoardToFolder,
  moveBoardToWorkspace,
  renameBoard,
  setBoardStatus,
  trashBoard,
} from './api.js'
import { BoardShare } from './board-share.js'
import { BoardVersions } from './board-versions.js'
import { FolderSelect } from './folders.js'
import { Link, navigate } from './router.js'

const ROLE_LABELS: Readonly<Record<BoardRoleView, string>> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer',
}

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

function Notice({ text }: { readonly text: string }) {
  return (
    <p className="notice notice--error" role="alert">
      {text}
    </p>
  )
}

/**
 * Wechsel des Arbeitsbereichs.
 *
 * Zwei Schritte, weil er nicht folgenlos ist: die Wirkung steht **vor** dem Ausloesen da, und erst eine
 * ausdrueckliche Bestaetigung schickt ihn ab. Das Board landet im Ziel unmittelbar im Arbeitsbereich; in
 * einen Ordner legt es dort dieselbe Ansicht im naechsten Schritt.
 *
 * callbell-dev: bewusst ohne Ordnerwahl im Ziel - dafuer muesste diese Ansicht den fremden Ordnerbaum
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
    return <p>Es gibt keinen weiteren aktiven Arbeitsbereich, in den dieses Board wechseln koennte.</p>
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
          <button
            type="button"
            disabled={selected === null}
            onClick={() => {
              setConfirming(true)
            }}
          >
            Arbeitsbereich wechseln
          </button>
        </p>
      )}
      {confirming && selected !== null && (
        <div className="notice" role="alert">
          <p>
            <strong>{board.title}</strong> wirklich nach <strong>{selected.name}</strong> verschieben? Die
            internen Freigaben und die Gastlinks dieses Boards enden damit.
          </p>
          <p>
            <button
              type="button"
              disabled={busy}
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
            </button>{' '}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false)
              }}
            >
              Wechsel abbrechen
            </button>
          </p>
        </div>
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
  retentionHint,
  onTrashed,
  onError,
}: {
  readonly me: MeResponse
  readonly board: BoardView
  readonly retentionHint: string
  readonly onTrashed: () => void
  readonly onError: (message: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    <div className="stack">
      <p className="hint">{retentionHint}</p>
      {!confirming ? (
        <p>
          <button
            type="button"
            onClick={() => {
              setConfirming(true)
            }}
          >
            Board loeschen
          </button>
        </p>
      ) : (
        <div className="notice" role="alert">
          <p>
            <strong>{board.title}</strong> wirklich in den Papierkorb legen? Das Board verschwindet sofort aus
            allen Listen, laesst sich nicht mehr oeffnen, und jeder Freigabe- und Gastzugriff endet.
          </p>
          <p>
            <button
              type="button"
              disabled={busy}
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
            </button>{' '}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false)
              }}
            >
              Loeschen abbrechen
            </button>
          </p>
        </div>
      )}
    </div>
  )
}

export function BoardDetails({
  me,
  workspace,
  workspaces,
  boardId,
  onChanged,
}: {
  readonly me: MeResponse
  /** Der Arbeitsbereich der Adresse. Liegt das Board inzwischen woanders, wechselt die Ansicht dorthin. */
  readonly workspace: WorkspaceView
  readonly workspaces: readonly WorkspaceView[]
  readonly boardId: string
  /** Meldet der Huelle, dass sich an den Boards etwas geaendert hat. */
  readonly onChanged: () => void
}) {
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly board: BoardView }
    | { readonly kind: 'failed'; readonly message: string }
  >({ kind: 'loading' })
  const [folders, setFolders] = useState<readonly FolderView[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)
  /** Freigaben und Versionen stehen als eigene Abschnitte im Fluss der Seite, nicht als Dialog. */
  const [panel, setPanel] = useState<'keiner' | 'freigaben' | 'versionen'>('keiner')

  const load = useCallback(() => {
    fetchBoardGrants(boardId)
      .then((response) => {
        setState({ kind: 'ready', board: response.board })
        setTitle(response.board.title)
      })
      .catch((cause: unknown) => {
        setState({ kind: 'failed', message: messageOf(cause, 'Das Board konnte nicht geladen werden.') })
      })
  }, [boardId])

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

  const board = state.kind === 'ready' ? state.board : null
  const boardWorkspaceId = board?.workspaceId ?? null
  // Ein geteilter Link kann auf den bisherigen Arbeitsbereich zeigen; die Adresse folgt dann dem Board.
  useEffect(() => {
    if (boardWorkspaceId !== null && boardWorkspaceId !== workspaceId) {
      navigate({ kind: 'boarddetails', workspaceId: boardWorkspaceId, boardId }, { replace: true })
    }
  }, [boardWorkspaceId, workspaceId, boardId])

  if (state.kind === 'loading') {
    return (
      <section aria-labelledby="board-details-heading">
        <h2 id="board-details-heading">Board</h2>
        <p aria-live="polite">Das Board wird geladen …</p>
      </section>
    )
  }
  if (state.kind === 'failed') {
    return (
      <section aria-labelledby="board-details-heading">
        <h2 id="board-details-heading">Board</h2>
        <Notice text={state.message} />
        <p>
          <Link className="button" route={{ kind: 'arbeitsbereich', workspaceId, folder: null }}>
            Zur Boardliste
          </Link>
        </p>
      </section>
    )
  }

  const current = state.board
  const workspaceActive = workspace.status === 'active'
  /** Was der Server fuer diese Rolle zulaesst - nicht, was diese Ansicht fuer richtig haelt. */
  const role = viewerRoleOf(current)
  const editable = workspaceActive && mayChangeBoard(role)
  /** Stammdaten sind an einem archivierten Board unveraenderlich; die Archivierung selbst nicht. */
  const changeable = editable && current.status === 'active'
  const manageable = mayManageBoard(role)
  const responsible = workspaceActive && mayRestoreBoard(role, workspace.role)
  const folderName = folders.find((entry) => entry.id === current.folderId)?.name ?? null

  function apply(updated: BoardView): void {
    setState({ kind: 'ready', board: updated })
    setTitle(updated.title)
    setRenaming(false)
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

  return (
    <section aria-labelledby="board-details-heading">
      <h2 id="board-details-heading">{current.title}</h2>
      <p>
        <Link
          className="button"
          route={{ kind: 'board', workspaceId, boardId: current.id, version: null }}
        >
          Board oeffnen
        </Link>{' '}
        <Link route={{ kind: 'arbeitsbereich', workspaceId, folder: null }}>Zur Boardliste</Link>
      </p>

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
          {current.ownerDisplayName}
          {current.ownerUserId === me.user.id && ' (du)'}
        </dd>
        <dt>Status</dt>
        <dd>{current.status === 'active' ? 'aktiv' : 'archiviert'}</dd>
        <dt>Eigene Rolle</dt>
        <dd>{ROLE_LABELS[current.viewerRole]}</dd>
        <dt>Stand</dt>
        <dd>{current.sceneVersion === 0 ? 'noch leer' : `Version ${String(current.sceneVersion)}`}</dd>
        <dt>Geaendert</dt>
        <dd>{new Date(current.updatedAt).toLocaleString('de-DE')}</dd>
      </dl>

      {actionError !== null && <Notice text={actionError} />}

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
          <h5>Titel</h5>
          {renaming ? (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault()
                run(renameBoard(me.csrfToken, current.id, title), 'Das Board konnte nicht umbenannt werden.')
              }}
            >
              <div className="field">
                <label htmlFor="board-title">Neuer Titel</label>
                <input
                  id="board-title"
                  value={title}
                  maxLength={MAX_BOARD_TITLE_LENGTH}
                  required
                  autoFocus
                  onChange={(event) => {
                    setTitle(event.target.value)
                  }}
                />
              </div>
              <p>
                <button type="submit" disabled={busy || title.trim().length === 0}>
                  Titel speichern
                </button>{' '}
                <button
                  type="button"
                  onClick={() => {
                    setTitle(current.title)
                    setRenaming(false)
                  }}
                >
                  Umbenennen abbrechen
                </button>
              </p>
            </form>
          ) : (
            <p>
              <button
                type="button"
                disabled={busy || !changeable}
                onClick={() => {
                  setRenaming(true)
                }}
              >
                Board umbenennen
              </button>
              {!changeable && ' '}
              {!changeable && <span className="hint">Ein archiviertes Board wird nicht umbenannt.</span>}
            </p>
          )}

          <h5>Ordner</h5>
          <div className="stack">
            <FolderSelect
              id="board-folder"
              label={`Ordner von ${current.title}`}
              folders={folders}
              value={current.folderId}
              disabled={busy || !changeable}
              onChange={(folderId) => {
                run(
                  moveBoardToFolder(me.csrfToken, current.id, folderId),
                  'Das Board konnte nicht verschoben werden.',
                )
              }}
            />
          </div>

          <h5>Status</h5>
          <p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                run(
                  setBoardStatus(me.csrfToken, current.id, current.status === 'active' ? 'archived' : 'active'),
                  'Der Status konnte nicht geaendert werden.',
                )
              }}
            >
              {current.status === 'active' ? 'Board archivieren' : 'Board reaktivieren'}
            </button>
          </p>
        </>
      )}

      {responsible && (
        <>
          <h5>Arbeitsbereich wechseln</h5>
          <MoveToWorkspace
            me={me}
            board={current}
            workspaces={workspaces}
            onMoved={(moved) => {
              // Erst die neue Boardsicht uebernehmen, dann die Adresse: sonst zeigte die Ansicht noch auf
              // den bisherigen Arbeitsbereich und der Abgleich unten schickte sie dorthin zurueck.
              apply(moved)
              navigate({ kind: 'boarddetails', workspaceId: moved.workspaceId, boardId: moved.id })
            }}
            onError={(message) => {
              setActionError(message === '' ? null : message)
            }}
          />

          <h5>Loeschen</h5>
          <TrashBoard
            me={me}
            board={current}
            retentionHint="Geloescht wird in den Papierkorb dieses Arbeitsbereichs. Von dort laesst sich das Board bis zum Ende der Aufbewahrungsfrist zuruecknehmen."
            onTrashed={() => {
              onChanged()
              navigate({ kind: 'papierkorb', workspaceId })
            }}
            onError={(message) => {
              setActionError(message === '' ? null : message)
            }}
          />
          <p>
            <Link route={{ kind: 'papierkorb', workspaceId }}>Papierkorb dieses Arbeitsbereichs</Link>
          </p>
        </>
      )}

      <h5>Freigaben und Versionen</h5>
      <p>
        <button
          type="button"
          onClick={() => {
            setPanel(panel === 'freigaben' ? 'keiner' : 'freigaben')
          }}
        >
          {panel === 'freigaben' ? 'Freigaben schliessen' : 'Freigaben verwalten'}
        </button>{' '}
        <button
          type="button"
          onClick={() => {
            setPanel(panel === 'versionen' ? 'keiner' : 'versionen')
          }}
        >
          {panel === 'versionen' ? 'Versionen schliessen' : 'Versionen ansehen'}
        </button>
      </p>
      {!manageable && panel === 'freigaben' && (
        <p className="hint">Aendern kann die Freigaben der Owner dieses Boards.</p>
      )}
      {panel === 'freigaben' && (
        <BoardShare
          me={me}
          boardId={current.id}
          onClose={() => {
            setPanel('keiner')
          }}
          onChanged={load}
        />
      )}
      {panel === 'versionen' && (
        <BoardVersions
          me={me}
          boardId={current.id}
          workspaceArchived={!workspaceActive}
          onPreview={(version) => {
            navigate({ kind: 'board', workspaceId, boardId: current.id, version })
          }}
          onClose={() => {
            setPanel('keiner')
          }}
          onChanged={() => {
            load()
            onChanged()
          }}
        />
      )}
    </section>
  )
}
