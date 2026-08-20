/**
 * Boardbibliothek eines Arbeitsbereichs.
 *
 * Liste, Titelsuche, Anlegen, Umbenennen, Archivieren und eine getrennte Archivansicht. Die Oberflaeche
 * blendet aus, was die eigene Rolle nicht traegt - das ist Bequemlichkeit, keine Sicherheitsgrenze; jede
 * Aktion wird serverseitig entschieden und jede Ablehnung hier als Text gezeigt.
 *
 * Bewusst ohne UI-Framework und ohne Dialoge: Formulare stehen im Fluss der Seite, damit es keine Fokusfalle
 * und keine eigene Escape-Behandlung braucht.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { BoardStatusView, BoardView, MeResponse, WorkspaceView } from '../contracts/api.js'
import { MAX_BOARD_TITLE_LENGTH } from '../domain/board/model.js'
import type { EffectiveBoardRole } from '../domain/board/policy.js'
import { mayChangeBoard, mayManageBoard } from '../domain/board/policy.js'
import { ApiError, createBoard, fetchBoards, renameBoard, setBoardStatus } from './api.js'
import { BoardShare } from './board-share.js'
import { BoardVersions } from './board-versions.js'

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

/**
 * Die Rolle, die der Server fuer dieses Board nennt - in der Form, in der die Policy sie liest.
 *
 * Die Boardliste ist immer die Antwort an ein Mitglied; ein Gast hat keine Liste. Was mit dieser Rolle
 * moeglich ist, entscheiden `mayChangeBoard` und `mayManageBoard` - dieselben Funktionen, mit denen der
 * Server entscheidet. Diese Datei leitet daraus nichts eigenes ab.
 */
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

function BoardRow({
  me,
  board,
  editable,
  manageable,
  onOpen,
  onShare,
  onVersions,
  onChanged,
  onError,
}: {
  readonly me: MeResponse
  readonly board: BoardView
  readonly editable: boolean
  /** Wahr, wenn die vom Server genannte Rolle die Freigabeverwaltung traegt - Bequemlichkeit, keine Grenze. */
  readonly manageable: boolean
  readonly onOpen: (board: BoardView) => void
  readonly onShare: (board: BoardView) => void
  readonly onVersions: (board: BoardView) => void
  readonly onChanged: () => void
  readonly onError: (message: string) => void
}) {
  const [title, setTitle] = useState(board.title)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(false)

  useEffect(() => {
    setTitle(board.title)
  }, [board.title])

  function run(action: Promise<unknown>, fallback: string): void {
    setBusy(true)
    onError('')
    action
      .then(() => {
        setRenaming(false)
        onChanged()
      })
      .catch((cause: unknown) => {
        onError(messageOf(cause, fallback))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <tr>
      <td>
        {renaming ? (
          <form
            className="field"
            onSubmit={(event) => {
              event.preventDefault()
              run(renameBoard(me.csrfToken, board.id, title), 'Das Board konnte nicht umbenannt werden.')
            }}
          >
            <label htmlFor={`board-title-${board.id}`}>Neuer Titel fuer {board.title}</label>
            <input
              id={`board-title-${board.id}`}
              value={title}
              maxLength={MAX_BOARD_TITLE_LENGTH}
              required
              autoFocus
              onChange={(event) => {
                setTitle(event.target.value)
              }}
            />
            <p>
              <button type="submit" disabled={busy || title.trim().length === 0}>
                Titel speichern
              </button>{' '}
              <button
                type="button"
                onClick={() => {
                  setTitle(board.title)
                  setRenaming(false)
                }}
              >
                Umbenennen abbrechen
              </button>
            </p>
          </form>
        ) : (
          board.title
        )}
      </td>
      <td>{board.ownerDisplayName}</td>
      <td>{board.sceneVersion === 0 ? 'noch leer' : `Version ${String(board.sceneVersion)}`}</td>
      <td>{new Date(board.updatedAt).toLocaleDateString('de-DE')}</td>
      <td>
        <button
          type="button"
          onClick={() => {
            onOpen(board)
          }}
        >
          {board.title} oeffnen
        </button>{' '}
        {!renaming && (
          <button
            type="button"
            onClick={() => {
              onVersions(board)
            }}
          >
            Versionen von {board.title} zeigen
          </button>
        )}{' '}
        {manageable && !renaming && (
          <button
            type="button"
            onClick={() => {
              onShare(board)
            }}
          >
            Freigaben von {board.title} verwalten
          </button>
        )}{' '}
        {editable && !renaming && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRenaming(true)
              }}
            >
              {board.title} umbenennen
            </button>{' '}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                run(
                  setBoardStatus(me.csrfToken, board.id, board.status === 'active' ? 'archived' : 'active'),
                  'Der Status konnte nicht geaendert werden.',
                )
              }}
            >
              {board.status === 'active' ? `${board.title} archivieren` : `${board.title} entarchivieren`}
            </button>
          </>
        )}
      </td>
    </tr>
  )
}

export function Boards({
  me,
  workspace,
  onOpenBoard,
  onListChanged,
}: {
  readonly me: MeResponse
  readonly workspace: WorkspaceView
  /**
   * Oeffnet ein Board. Mit `previewVersion` steht die Read-only-Vorschau genau dieser Version - derselbe
   * Weg wie das normale Oeffnen, damit die Vorschau die ganze Flaeche bekommt und nicht ein zweiter,
   * halber Editor daneben entsteht.
   */
  readonly onOpenBoard: (board: BoardView, previewVersion?: number) => void
  /**
   * Meldet, dass diese Liste (neu) geladen wurde. Die Huelle haelt daran ihre Seitenleiste aktuell, ohne
   * dass diese Datei sie kennen muesste.
   */
  readonly onListChanged?: () => void
}) {
  const [status, setStatus] = useState<BoardStatusView>('active')
  /** Der abgeschickte Suchbegriff. Gefiltert wird serverseitig, nicht im Browser. */
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const [list, setList] = useState<readonly BoardView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)
  /** Board, dessen Freigaben gerade verwaltet werden. Der Abschnitt steht im Fluss der Seite, nicht als Dialog. */
  const [shareBoardId, setShareBoardId] = useState<string | null>(null)
  /** Board, dessen Versionen gerade gezeigt werden. Derselbe Fluss, derselbe Grund. */
  const [versionsBoard, setVersionsBoard] = useState<BoardView | null>(null)

  const workspaceId = workspace.id
  // Ref statt Abhaengigkeit: der Rueckruf darf das Laden nicht neu ausloesen - das waere eine Schleife.
  const onChangedRef = useRef(onListChanged)
  onChangedRef.current = onListChanged

  const load = useCallback(() => {
    setError(null)
    fetchBoards(workspaceId, { status, query: term })
      .then((response) => {
        setList(response.boards)
      })
      .catch((cause: unknown) => {
        setList([])
        setError(messageOf(cause, 'Die Boards konnten nicht geladen werden.'))
      })
  }, [workspaceId, status, term])

  useEffect(load, [load])

  /** Nach einer Aenderung: neu laden und die Huelle benachrichtigen, damit ihre Seitenleiste mitzieht. */
  const reload = useCallback(() => {
    load()
    onChangedRef.current?.()
  }, [load])

  const archived = status === 'archived'
  /** Ein archivierter Arbeitsbereich ist vollstaendig unveraenderlich - unabhaengig von jeder Boardrolle. */
  const workspaceActive = workspace.status === 'active'

  return (
    <section aria-labelledby="boards-heading">
      <h4 id="boards-heading">Boards</h4>

      <div className="board-filters">
        <form
          className="field"
          onSubmit={(event) => {
            event.preventDefault()
            setTerm(query.trim())
          }}
        >
          <label htmlFor="board-search">Boards nach Titel suchen</label>
          <input
            id="board-search"
            type="search"
            value={query}
            maxLength={MAX_BOARD_TITLE_LENGTH}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
          <p>
            <button type="submit">Boardliste filtern</button>{' '}
            {term !== '' && (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  setTerm('')
                }}
              >
                Boardfilter aufheben
              </button>
            )}
          </p>
        </form>
        <p>
          <button
            type="button"
            aria-pressed={archived}
            onClick={() => {
              setStatus(archived ? 'active' : 'archived')
              setList(null)
            }}
          >
            {archived ? 'Aktive Boards zeigen' : 'Archivierte Boards zeigen'}
          </button>
        </p>
      </div>

      {error !== null && (
        <p className="notice notice--error" role="alert">
          {error}{' '}
          <button type="button" onClick={load}>
            Erneut laden
          </button>
        </p>
      )}
      {actionError !== null && actionError !== '' && <Notice text={actionError} />}

      {list === null && <p aria-live="polite">Boards werden geladen …</p>}
      {list !== null && list.length === 0 && error === null && (
        <p>
          {archived
            ? 'Es gibt keine archivierten Boards.'
            : term === ''
              ? 'In diesem Arbeitsbereich gibt es noch kein Board. Lege das erste an.'
              : `Kein Board mit "${term}" im Titel.`}
        </p>
      )}
      {list !== null && list.length > 0 && (
        <table className="users">
          <caption className="visually-hidden">
            {archived ? 'Archivierte Boards' : 'Aktive Boards'} in {workspace.name}
          </caption>
          <thead>
            <tr>
              <th scope="col">Titel</th>
              <th scope="col">Owner</th>
              <th scope="col">Stand</th>
              <th scope="col">Geaendert</th>
              <th scope="col">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {list.map((board) => (
              <BoardRow
                key={board.id}
                me={me}
                board={board}
                // Angeboten wird, was die vom Server genannte Rolle traegt. Entschieden wird trotzdem am
                // Endpunkt: die Anzeige ist Bequemlichkeit und keine Grenze.
                editable={workspaceActive && mayChangeBoard(viewerRoleOf(board))}
                manageable={mayManageBoard(viewerRoleOf(board))}
                onOpen={onOpenBoard}
                onShare={(entry) => {
                  setShareBoardId(entry.id)
                }}
                onVersions={setVersionsBoard}
                onChanged={reload}
                onError={setActionError}
              />
            ))}
          </tbody>
        </table>
      )}

      {versionsBoard !== null && (
        <BoardVersions
          key={versionsBoard.id}
          me={me}
          boardId={versionsBoard.id}
          workspaceArchived={!workspaceActive}
          onPreview={(version) => {
            onOpenBoard(versionsBoard, version)
          }}
          onClose={() => {
            setVersionsBoard(null)
          }}
          onChanged={reload}
        />
      )}

      {shareBoardId !== null && (
        <BoardShare
          key={shareBoardId}
          me={me}
          boardId={shareBoardId}
          onClose={() => {
            setShareBoardId(null)
          }}
          onChanged={load}
        />
      )}

      {/* Ein Board anlegen darf jedes Mitglied eines aktiven Arbeitsbereichs; dafuer gibt es noch keine
          Boardrolle, ueber die zu entscheiden waere. */}
      {workspaceActive && !archived && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            setCreating(true)
            setActionError(null)
            createBoard(me.csrfToken, workspace.id, newTitle)
              .then(() => {
                setNewTitle('')
                reload()
              })
              .catch((cause: unknown) => {
                setActionError(messageOf(cause, 'Das Board konnte nicht angelegt werden.'))
              })
              .finally(() => {
                setCreating(false)
              })
          }}
        >
          <div className="field">
            <label htmlFor="board-new-title">Titel des neuen Boards</label>
            <input
              id="board-new-title"
              value={newTitle}
              maxLength={MAX_BOARD_TITLE_LENGTH}
              required
              onChange={(event) => {
                setNewTitle(event.target.value)
              }}
            />
          </div>
          <p>
            <button type="submit" disabled={creating || newTitle.trim().length === 0}>
              Board anlegen
            </button>
          </p>
        </form>
      )}
    </section>
  )
}
