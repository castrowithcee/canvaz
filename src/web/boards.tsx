/**
 * Boardbibliothek eines Arbeitsbereichs.
 *
 * Liste, Titelsuche, Anlegen und eine getrennte Archivansicht. Die Zeile selbst traegt **keine** Aktion
 * mehr: umbenennen, ablegen, archivieren, freigeben, verschieben und loeschen stehen gemeinsam in der
 * Detailansicht des Boards (`board-details.tsx`), auf die Titel und Zeile verweisen. Damit gibt es genau
 * einen Ort je Board statt einer Zeile, die alles zugleich sein muss.
 *
 * Bewusst ohne UI-Framework und ohne Dialoge: Formulare stehen im Fluss der Seite, damit es keine Fokusfalle
 * und keine eigene Escape-Behandlung braucht.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { BoardStatusView, BoardView, FolderView, MeResponse, WorkspaceView } from '../contracts/api.js'
import { BOARD_FOLDER_ROOT } from '../contracts/api.js'
import { MAX_BOARD_TITLE_LENGTH } from '../domain/board/model.js'
import { ApiError, createBoard, fetchBoards, fetchFolders } from './api.js'
import { Folders } from './folders.js'
import { Link } from './router.js'

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

function Notice({ text }: { readonly text: string }) {
  return (
    <p className="notice notice--error" role="alert">
      {text}
    </p>
  )
}

export function Boards({
  me,
  workspace,
  folder,
  onListChanged,
}: {
  readonly me: MeResponse
  readonly workspace: WorkspaceView
  /**
   * Gewaehlter Ordner aus der Adresse: `null` alle Boards, `BOARD_FOLDER_ROOT` die ohne Ordner, sonst
   * genau dieser. Gefiltert wird serverseitig - dieser Wert geht unveraendert an den Endpunkt.
   */
  readonly folder: string | null
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
  /** Ordner des Arbeitsbereichs: Ziele der Ablage, Vorlage des Baumes und Beschriftung der Zeilen. */
  const [folders, setFolders] = useState<readonly FolderView[]>([])

  const workspaceId = workspace.id
  // Ref statt Abhaengigkeit: der Rueckruf darf das Laden nicht neu ausloesen - das waere eine Schleife.
  const onChangedRef = useRef(onListChanged)
  onChangedRef.current = onListChanged

  const load = useCallback(() => {
    setError(null)
    fetchBoards(workspaceId, { status, query: term, folder })
      .then((response) => {
        setList(response.boards)
      })
      .catch((cause: unknown) => {
        setList([])
        setError(messageOf(cause, 'Die Boards konnten nicht geladen werden.'))
      })
  }, [workspaceId, status, term, folder])

  useEffect(load, [load])

  // Eigener Ladevorgang: der Baum haengt nicht am Status- und nicht am Titelfilter der Liste, und die
  // Ordner bleiben stehen, waehrend die Boardliste wechselt.
  const loadFolders = useCallback(() => {
    fetchFolders(workspaceId)
      .then((response) => {
        setFolders(response.folders)
      })
      .catch(() => {
        setFolders([])
      })
  }, [workspaceId])

  useEffect(loadFolders, [loadFolders])

  /** Nach einer Aenderung: neu laden und die Huelle benachrichtigen, damit ihre Seitenleiste mitzieht. */
  const reload = useCallback(() => {
    load()
    loadFolders()
    onChangedRef.current?.()
  }, [load, loadFolders])

  /** Der Ordner, in den ein neues Board faellt: der gewaehlte, sonst der Arbeitsbereich selbst. */
  const targetFolderId = folder === null || folder === BOARD_FOLDER_ROOT ? null : folder
  const folderName = folders.find((entry) => entry.id === folder)?.name ?? null

  const archived = status === 'archived'
  /** Ein archivierter Arbeitsbereich ist vollstaendig unveraenderlich - unabhaengig von jeder Boardrolle. */
  const workspaceActive = workspace.status === 'active'

  return (
    <section aria-labelledby="boards-heading">
      <Folders me={me} workspace={workspace} folders={folders} active={folder} onChanged={reload} />

      <h4 id="boards-heading">
        {folder === null
          ? 'Alle Boards'
          : folder === BOARD_FOLDER_ROOT
            ? 'Boards ohne Ordner'
            : `Boards in ${folderName ?? 'diesem Ordner'}`}
      </h4>

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
            : term !== ''
              ? `Kein Board mit "${term}" im Titel.`
              : folder === null
                ? 'In diesem Arbeitsbereich gibt es noch kein Board. Lege das erste an.'
                : 'Hier liegt noch kein Board.'}
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
              <th scope="col">Ordner</th>
              <th scope="col">Owner</th>
              <th scope="col">Stand</th>
              <th scope="col">Geaendert</th>
              <th scope="col">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {list.map((board) => (
              <tr key={board.id}>
                <td>
                  <Link route={{ kind: 'boarddetails', workspaceId: workspace.id, boardId: board.id }}>
                    {board.title}
                  </Link>
                </td>
                <td>{folders.find((entry) => entry.id === board.folderId)?.name ?? 'Arbeitsbereich'}</td>
                <td>{board.ownerDisplayName}</td>
                <td>{board.sceneVersion === 0 ? 'noch leer' : `Version ${String(board.sceneVersion)}`}</td>
                <td>{new Date(board.updatedAt).toLocaleDateString('de-DE')}</td>
                <td>
                  <Link
                    className="button"
                    route={{ kind: 'board', workspaceId: workspace.id, boardId: board.id, version: null }}
                  >
                    {board.title} oeffnen
                  </Link>{' '}
                  <Link route={{ kind: 'boarddetails', workspaceId: workspace.id, boardId: board.id }}>
                    Details von {board.title}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
            createBoard(me.csrfToken, workspace.id, newTitle, targetFolderId)
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
