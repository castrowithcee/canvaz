/**
 * Arbeitsbereich-Explorer: **ein** geladener Stand fuer Seitenleiste und Inhaltsflaeche.
 *
 * Bisher lud die Seitenleiste ihren Baum und ihre Boards, und die Inhaltsflaeche daneben noch einmal ihre
 * eigenen. Nach einer Aenderung zeigten beide fuer einen Moment verschiedene Baeume. Diese Datei loest das
 * auf: `useExplorer` laedt Ordner und aktive Boards des Arbeitsbereichs **gemeinsam**, die Huelle haelt
 * diesen Stand, und Baum wie Sammlung leiten ihre Sicht daraus ab. Ein globaler Store waere dafuer eine
 * Ebene zu viel - es ist der Zustand genau einer Ansicht.
 *
 * Waehrend einer Aktualisierung bleibt der bisherige Stand stehen (`busy` statt `null`). Nur der Wechsel
 * des Arbeitsbereichs beginnt wirklich neu; dann steht ein Platzhalter statt eines fremden Baumes.
 *
 * Die Ableitungen darunter sind reine Rechnung und tragen **dieselben drei Werte** wie der Endpunkt: keine
 * Ordnerwahl heisst alle Boards des Arbeitsbereichs, `BOARD_FOLDER_ROOT` die ohne Ordner, eine Kennung
 * genau diesen einen Ordner. Der Baum ist Navigation und keine Berechtigung: welche Boards die Antwort
 * ueberhaupt enthaelt, entscheidet weiterhin der Server.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, RotateCcw, SquarePen } from 'lucide-react'

import type { BoardView, FolderView, WorkspaceView } from '../contracts/api.js'
import { BOARD_FOLDER_ROOT } from '../contracts/api.js'
import { ApiError, fetchBoards, fetchFolders } from './api.js'
import { Link } from './router.js'
import { Button, Notice, Skeleton } from './ui.js'

/* ----------------------------------------------------------------- Daten */

/** Der gemeinsame Stand: der ganze Ordnerbaum und alle aktiven Boards des Arbeitsbereichs. */
export type ExplorerData = {
  readonly folders: readonly FolderView[]
  readonly boards: readonly BoardView[]
}

export type Explorer = {
  /** `null` heisst: fuer diesen Arbeitsbereich ist noch nichts geladen. */
  readonly data: ExplorerData | null
  /** Eine Aktualisierung laeuft. Der bisherige Stand bleibt dabei sichtbar. */
  readonly busy: boolean
  readonly error: string | null
  readonly reload: () => void
}

export function useExplorer(workspaceId: string | null): Explorer {
  const [data, setData] = useState<ExplorerData | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Nur die juengste Anfrage darf schreiben; eine ueberholte Antwort wuerde sonst zurueckspringen. */
  const ticket = useRef(0)

  const load = useCallback(() => {
    const own = ticket.current + 1
    ticket.current = own
    if (workspaceId === null) {
      setData({ folders: [], boards: [] })
      setError(null)
      setBusy(false)
      return
    }
    setBusy(true)
    setError(null)
    Promise.all([fetchFolders(workspaceId), fetchBoards(workspaceId, { status: 'active', query: '' })])
      .then(([tree, list]) => {
        if (ticket.current !== own) {
          return
        }
        setData({ folders: tree.folders, boards: list.boards })
      })
      .catch((cause: unknown) => {
        if (ticket.current !== own) {
          return
        }
        setError(
          cause instanceof ApiError ? cause.message : 'Ordner und Boards konnten nicht geladen werden.',
        )
      })
      .finally(() => {
        if (ticket.current === own) {
          setBusy(false)
        }
      })
  }, [workspaceId])

  // `load` aendert sich genau dann, wenn der Arbeitsbereich wechselt - und nur dann beginnt der Baum neu.
  useEffect(() => {
    setData(null)
    load()
  }, [load])

  return { data, busy, error, reload: load }
}

/* ------------------------------------------------------------ Ableitungen */

/** Die unmittelbaren Unterordner eines Knotens, in der Reihenfolge der Antwort. */
export function childFolders(folders: readonly FolderView[], parentId: string | null): readonly FolderView[] {
  return folders.filter((folder) => folder.parentId === parentId)
}

/**
 * Die Boards einer Auswahl - dieselben drei Werte wie der Endpunkt.
 *
 * qatlas-dev: gefiltert wird ueber der bereits geladenen Liste statt mit einer zweiten Abfrage. Der Baum
 * braucht ohnehin alle aktiven Boards des Arbeitsbereichs; eine eigene Abfrage je Ordner waere ein zweiter
 * Stand. Sobald ein Arbeitsbereich mehr Boards traegt, als eine Antwort tragen soll, bekommt der Endpunkt
 * eine Seitenweise - dann filtert wieder er.
 */
export function boardsOfSelection(boards: readonly BoardView[], selection: string | null): readonly BoardView[] {
  if (selection === null) {
    return boards
  }
  if (selection === BOARD_FOLDER_ROOT) {
    return boards.filter((board) => board.folderId === null)
  }
  return boards.filter((board) => board.folderId === selection)
}

/** Der Weg vom Arbeitsbereich bis zum Ordner, aussen zuerst. Leer heisst: der Arbeitsbereich selbst. */
export function folderPath(folders: readonly FolderView[], folderId: string | null): readonly FolderView[] {
  const path: FolderView[] = []
  let current = folderId
  while (current !== null && path.length <= folders.length) {
    const folder = folders.find((candidate) => candidate.id === current)
    if (folder === undefined) {
      break
    }
    path.unshift(folder)
    current = folder.parentId
  }
  return path
}

/** Titelfilter wie im Endpunkt: eine Teilzeichenkette ohne Ruecksicht auf Gross- und Kleinschreibung. */
export function matchesTitle(title: string, term: string): boolean {
  return term === '' || title.toLowerCase().includes(term.toLowerCase())
}

/* ------------------------------------------------------------------ Baum */

/** Hat dieser Knoten ueberhaupt etwas unter sich? Ohne Inhalt gibt es auch nichts aufzuklappen. */
function hasChildren(data: ExplorerData, folderId: string): boolean {
  return (
    childFolders(data.folders, folderId).length > 0 || boardsOfSelection(data.boards, folderId).length > 0
  )
}

/** Der Ordner selbst und alle seine Vorfahren - der Weg, der zur Auswahl offen stehen muss. */
function pathIds(folders: readonly FolderView[], folderId: string | null): readonly string[] {
  return folderPath(folders, folderId).map((folder) => folder.id)
}

function BoardRow({
  workspaceId,
  board,
  open,
}: {
  readonly workspaceId: string
  readonly board: BoardView
  readonly open: boolean
}) {
  return (
    <li className="tree__item">
      <div className="tree__row">
        <span className="tree__twisty tree__twisty--leer" aria-hidden="true" />
        <Link
          className="tree__label"
          route={{ kind: 'board', workspaceId, boardId: board.id, version: null }}
          current={open}
        >
          <SquarePen size={16} aria-hidden="true" />
          <span className="tree__name">{board.title}</span>
        </Link>
      </div>
    </li>
  )
}

function FolderNode({
  workspaceId,
  data,
  folder,
  selection,
  openBoardId,
  expanded,
  onToggle,
}: {
  readonly workspaceId: string
  readonly data: ExplorerData
  readonly folder: FolderView
  readonly selection: string | null
  readonly openBoardId: string | null
  readonly expanded: ReadonlySet<string>
  readonly onToggle: (folderId: string) => void
}) {
  const childrenId = useId()
  const open = expanded.has(folder.id)
  const gefuellt = hasChildren(data, folder.id)

  return (
    <li className="tree__item">
      <div className="tree__row">
        {gefuellt ? (
          <button
            type="button"
            className="tree__twisty"
            aria-expanded={open}
            aria-controls={open ? childrenId : undefined}
            aria-label={open ? `${folder.name} zuklappen` : `${folder.name} aufklappen`}
            onClick={() => {
              onToggle(folder.id)
            }}
          >
            {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          </button>
        ) : (
          <span className="tree__twisty tree__twisty--leer" aria-hidden="true" />
        )}
        <Link
          className="tree__label"
          route={{ kind: 'arbeitsbereich', workspaceId, folder: folder.id }}
          current={selection === folder.id}
        >
          {open ? <FolderOpen size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
          <span className="tree__name">{folder.name}</span>
        </Link>
      </div>
      {open && (
        <ul className="tree__children" id={childrenId}>
          <Nodes
            workspaceId={workspaceId}
            data={data}
            parentId={folder.id}
            selection={selection}
            openBoardId={openBoardId}
            expanded={expanded}
            onToggle={onToggle}
          />
        </ul>
      )}
    </li>
  )
}

/** Unterordner und danach die Boards genau dieses Knotens. Beide Reihenfolgen kommen vom Server. */
function Nodes({
  workspaceId,
  data,
  parentId,
  selection,
  openBoardId,
  expanded,
  onToggle,
}: {
  readonly workspaceId: string
  readonly data: ExplorerData
  readonly parentId: string | null
  readonly selection: string | null
  readonly openBoardId: string | null
  readonly expanded: ReadonlySet<string>
  readonly onToggle: (folderId: string) => void
}) {
  return (
    <>
      {childFolders(data.folders, parentId).map((folder) => (
        <FolderNode
          key={folder.id}
          workspaceId={workspaceId}
          data={data}
          folder={folder}
          selection={selection}
          openBoardId={openBoardId}
          expanded={expanded}
          onToggle={onToggle}
        />
      ))}
      {boardsOfSelection(data.boards, parentId ?? BOARD_FOLDER_ROOT).map((board) => (
        <BoardRow key={board.id} workspaceId={workspaceId} board={board} open={board.id === openBoardId} />
      ))}
    </>
  )
}

/**
 * Der Baum der Seitenleiste: verschachtelte Ordner mit ihren Boards.
 *
 * Auswahl und Aufklappen sind **getrennt**: das Label ist ein Link und navigiert, der Schalter davor klappt
 * nur den Unterbaum auf. Verwendet werden verschachtelte Listen und keine ARIA-Baumrolle - die verlangt
 * eine vollstaendige Baumtastatur, die hier niemand braucht: Links und Schalter sind schon in der
 * Tabulatorfolge.
 */
export function ExplorerTree({
  workspace,
  explorer,
  selection,
  openBoardId,
}: {
  readonly workspace: WorkspaceView
  readonly explorer: Explorer
  /** Gewaehlter Ordner: `null` alle, `BOARD_FOLDER_ROOT` die ohne Ordner, sonst eine Kennung. */
  readonly selection: string | null
  /** Das gerade geoeffnete Board, falls die Adresse eines nennt. */
  readonly openBoardId: string | null
}) {
  const { data, busy, error, reload } = explorer
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  // Der Weg zur Auswahl steht offen; alles andere bleibt so, wie der Nutzer es gelassen hat.
  const folders = data?.folders ?? []
  useEffect(() => {
    const path = pathIds(folders, selection)
    if (path.length === 0) {
      return
    }
    setExpanded((was) => {
      if (path.every((id) => was.has(id))) {
        return was
      }
      return new Set([...was, ...path])
    })
  }, [folders, selection])

  const toggle = useCallback((folderId: string) => {
    setExpanded((was) => {
      const next = new Set(was)
      if (!next.delete(folderId)) {
        next.add(folderId)
      }
      return next
    })
  }, [])

  if (data === null) {
    return (
      <ul className="tree" aria-busy="true">
        <li className="visually-hidden" aria-live="polite">
          Ordner und Boards werden geladen …
        </li>
        {[0, 1, 2].map((row) => (
          <li key={row} className="skeleton-row" aria-hidden="true">
            <Skeleton />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <>
      {error !== null && (
        <Notice>
          <p>{error}</p>
          <p className="actions">
            <Button icon={RotateCcw} onClick={reload}>
              Erneut laden
            </Button>
          </p>
        </Notice>
      )}
      <ul className="tree" aria-busy={busy || undefined}>
        <li className="tree__item">
          <div className="tree__row">
            <span className="tree__twisty tree__twisty--leer" aria-hidden="true" />
            <Link
              className="tree__label"
              route={{ kind: 'arbeitsbereich', workspaceId: workspace.id, folder: null }}
              current={selection === null}
            >
              <Folder size={16} aria-hidden="true" />
              <span className="tree__name">Alle Boards</span>
            </Link>
          </div>
        </li>
        <Nodes
          workspaceId={workspace.id}
          data={data}
          parentId={null}
          selection={selection}
          openBoardId={openBoardId}
          expanded={expanded}
          onToggle={toggle}
        />
      </ul>
      {data.folders.length === 0 && data.boards.length === 0 && (
        <p className="hint">Noch kein Ordner und kein Board.</p>
      )}
    </>
  )
}
