/**
 * Die Sammlung des gewaehlten Explorerkontexts: Unterordner und Boards genau dieses Knotens.
 *
 * Sie zeigt und **bearbeitet** dort, wo die Objekte stehen. Anlegen geschieht am aktuell gewaehlten Ort;
 * Anlegen und Umbenennen oeffnen einen kurzen Dialog ueber der Liste, Verschieben eine kurze Zielauswahl,
 * Duplizieren dieselbe Zielauswahl mit Titelvorschlag, Entfernen einen Dialog, der seine Folge vorher
 * nennt. Damit gibt es fuer diese Handlungen genau **einen** Ort - weder eine Verwaltungstabelle oberhalb der Liste noch einen
 * Umweg ueber die Einstellungen oder die Detailansicht.
 *
 * Die Liste ist eine kompakte Zeilenliste und keine Tabelle: verglichen werden hier keine Spalten, es wird
 * gesucht und geoeffnet. Die Detailansicht bleibt fuer Freigaben, Versionen und den Wechsel des
 * Arbeitsbereichs erreichbar - als Eintrag im Kontextmenue und nicht als Zwischenstation zum Board.
 *
 * Gefiltert wird ueber dem geladenen Explorerstand (`explorer.tsx`) und nicht mit einer zweiten Abfrage:
 * Baum und Sammlung zeigen so nie zwei verschiedene Staende. Die Archivansicht ist die eine Ausnahme - sie
 * ist eine andere Menge und wird deshalb eigens geholt.
 *
 * Was diese Datei anbietet, leitet sie aus **denselben** Funktionen ab, mit denen der Server entscheidet
 * (`mayChangeBoard`, Ordner ueber die Workspacerolle). Es ist Anzeige und keine Grenze: abgelehnt wird
 * weiterhin am Endpunkt, und jede Ablehnung erscheint hier als Text.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  Copy,
  EllipsisVertical,
  Folder,
  FolderInput,
  FolderPlus,
  Info,
  Pencil,
  Plus,
  RotateCcw,
  Share2,
  SquarePen,
  Trash2,
} from 'lucide-react'

import type { BoardView, FolderView, MeResponse, WorkspaceView } from '../contracts/api.js'
import { BOARD_FOLDER_ROOT } from '../contracts/api.js'
import { MAX_BOARD_TITLE_LENGTH } from '../domain/board/model.js'
import { mayChangeBoard, mayManageBoard } from '../domain/board/policy.js'
import { MAX_FOLDER_NAME_LENGTH } from '../domain/folder/model.js'
import {
  ApiError,
  createBoard,
  createFolder,
  duplicateBoard,
  fetchBoards,
  moveBoardToFolder,
  moveFolder,
  removeFolder,
  renameBoard,
  renameFolder,
} from './api.js'
import type { Explorer } from './explorer.js'
import { boardsOfSelection, childFolders, folderPath, matchesTitle } from './explorer.js'
import { FolderSelect, folderMessageOf } from './folders.js'
import { Dialog, Menu, MenuItem, MenuLinkItem, NameDialog } from './overlays.js'
import { Link, navigate } from './router.js'
import { actionClass, Button, IconButton, Loading, Notice, PageState, useRowSelection } from './ui.js'

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

/** Ein Eintrag der Sammlung. Ordner und Board tragen dieselben drei Handlungen, aber eigene Endpunkte. */
type Target =
  | { readonly kind: 'folder'; readonly folder: FolderView }
  | { readonly kind: 'board'; readonly board: BoardView }

function targetId(target: Target): string {
  return target.kind === 'folder' ? target.folder.id : target.board.id
}

/** Die Kennung des Kontextmenues eines Eintrags - der Ausloeser, der den Fokus zurueckbekommt. */
function menuId(id: string): string {
  return `aktionen-${id}`
}

function targetName(target: Target): string {
  return target.kind === 'folder' ? target.folder.name : target.board.title
}

/**
 * Das Kontextmenue eines Eintrags.
 *
 * In einer Zeile erscheint es mit ihren anderen Aktionen an der ausgewaehlten, gehoverten oder fokussierten
 * Zeile; fuer Tastatur und Hilfsmittel bleibt es immer in der Folge. Die haeufigen Handlungen stehen oben -
 * auch die, die `QuickActions` zusaetzlich an der Zeile zeigt -, das Folgenreiche unten und abgesetzt.
 */
function EntryMenu({
  target,
  editable,
  duplicable = false,
  workspaceId,
  onRename,
  onMove,
  onDuplicate,
  onRemove,
}: {
  readonly target: Target
  readonly editable: boolean
  /** Wahr, wenn aus diesem Board eine Kopie entstehen darf. Fuer Ordner ohne Bedeutung. */
  readonly duplicable?: boolean
  readonly workspaceId: string
  readonly onRename: (target: Target) => void
  readonly onMove: (target: Target) => void
  readonly onDuplicate?: (board: BoardView) => void
  readonly onRemove: (folder: FolderView) => void
}) {
  const name = targetName(target)
  if (!editable && target.kind === 'folder') {
    return null
  }

  return (
    <Menu id={menuId(targetId(target))} label={`Aktionen fuer ${name}`} icon={EllipsisVertical}>
      {editable && (
        <MenuItem
          icon={Pencil}
          onSelect={() => {
            onRename(target)
          }}
        >
          Umbenennen
        </MenuItem>
      )}
      {editable && (
        <MenuItem
          icon={FolderInput}
          onSelect={() => {
            onMove(target)
          }}
        >
          Verschieben …
        </MenuItem>
      )}
      {duplicable && target.kind === 'board' && onDuplicate !== undefined && (
        <MenuItem
          icon={Copy}
          onSelect={() => {
            onDuplicate(target.board)
          }}
        >
          Duplizieren …
        </MenuItem>
      )}
      {target.kind === 'board' && (
        <MenuLinkItem>
          <Link
            className="menu__item"
            role="menuitem"
            route={{
              kind: 'board',
              workspaceId,
              boardId: target.board.id,
              version: null,
              panel: 'uebersicht',
            }}
          >
            <Info size={16} aria-hidden="true" />
            Details, Freigaben und Versionen
          </Link>
        </MenuLinkItem>
      )}
      {editable && target.kind === 'folder' && (
        <MenuItem
          icon={Trash2}
          danger
          onSelect={() => {
            onRemove(target.folder)
          }}
        >
          Entfernen …
        </MenuItem>
      )}
    </Menu>
  )
}

/**
 * Die haeufigen Handlungen eines Eintrags, direkt an der Zeile.
 *
 * Sie erscheinen mit dem Kontextmenue an der ausgewaehlten, gehoverten oder fokussierten Zeile, damit die
 * Liste ruhig bleibt; auf Beruehrung waehlt ein Tipp auf die freie Zeilenflaeche aus (`useRowSelection`).
 * Keine davon gibt es **nur** hier: Umbenennen steht ebenso im Kontextmenue, und die Freigabe fuehrt in
 * denselben Bereich der Informationsleiste wie die Freigabe im Editor.
 */
function QuickActions({
  target,
  editable,
  shareable,
  workspaceId,
  onRename,
}: {
  readonly target: Target
  readonly editable: boolean
  /** Wahr, wenn der Anfragende dieses Board freigeben darf. Fuer Ordner immer falsch. */
  readonly shareable: boolean
  readonly workspaceId: string
  readonly onRename: (target: Target) => void
}) {
  const name = targetName(target)
  return (
    <>
      {editable && (
        <IconButton
          label={`${name} umbenennen`}
          icon={Pencil}
          variant="quiet"
          extraClass="row__quick"
          onClick={() => {
            onRename(target)
          }}
        />
      )}
      {shareable && target.kind === 'board' && (
        <Link
          className={actionClass('quiet', 'icon-button row__quick')}
          title={`${name} freigeben`}
          route={{ kind: 'board', workspaceId, boardId: target.board.id, version: null, panel: 'freigaben' }}
        >
          <Share2 size={18} aria-hidden="true" />
          <span className="visually-hidden">{name} freigeben</span>
        </Link>
      )}
    </>
  )
}

export function Boards({
  me,
  workspace,
  folder,
  explorer,
  onChanged,
}: {
  readonly me: MeResponse
  readonly workspace: WorkspaceView
  /**
   * Gewaehlter Ordner aus der Adresse: `null` alle Boards, `BOARD_FOLDER_ROOT` die ohne Ordner, sonst
   * genau dieser. Es sind dieselben drei Werte wie im Endpunkt.
   */
  readonly folder: string | null
  /** Der gemeinsame Stand der Huelle - dieselbe Quelle, aus der auch die Seitenleiste zeichnet. */
  readonly explorer: Explorer
  /** Meldet eine Aenderung; die Huelle laedt daraufhin Baum und Sammlung gemeinsam neu. */
  readonly onChanged: () => void
}) {
  const [query, setQuery] = useState('')
  const [archive, setArchive] = useState(false)
  const [archived, setArchived] = useState<readonly BoardView[] | null>(null)
  const [creating, setCreating] = useState<'folder' | 'board' | null>(null)
  const [renaming, setRenaming] = useState<Target | null>(null)
  const [moving, setMoving] = useState<Target | null>(null)
  const [duplicating, setDuplicating] = useState<BoardView | null>(null)
  const [removing, setRemoving] = useState<FolderView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  /**
   * Der Ausloeser, der den Fokus zurueckbekommt, sobald eine Verschiebung oder ein Entfernen gelungen ist.
   *
   * Gemerkt wird seine Kennung und nicht sein Knoten: die Liste wird danach neu gezeichnet, und der Eintrag
   * steht womoeglich gar nicht mehr darin. Gesucht wird er deshalb erst, wenn die Liste wieder steht.
   * Anlegen und Umbenennen brauchen das nicht - ihr Dialog gibt den Fokus selbst an den Ausloeser zurueck.
   */
  const restore = useRef<string | null>(null)
  /** Der Ausloeser, der beim naechsten Zeichnen den Fokus bekommt, und der Anstoss dafuer. */
  const wanted = useRef<string | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const rowProps = useRowSelection()

  useEffect(() => {
    const id = wanted.current
    if (id === null) {
      return
    }
    wanted.current = null
    // Ein Bild spaeter: ein sich schliessender Dialog gibt den Fokus selbst zurueck, und das soll nicht
    // gegen diese Rueckgabe laufen. Ein verschobener oder entfernter Eintrag steht nicht mehr in der
    // Liste; dann uebernimmt die Ueberschrift der Sammlung, damit der Fokus nicht am Dokumentanfang landet.
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(id) ?? document.getElementById('explorer-inhalt')
      target?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [focusTick])

  const data = explorer.data
  const folders = data?.folders ?? []
  const workspaceId = workspace.id

  // Die Archivansicht ist eine andere Menge als der Explorerstand und wird deshalb eigens geholt.
  useEffect(() => {
    if (!archive) {
      return
    }
    let ignore = false
    setArchived(null)
    fetchBoards(workspaceId, { status: 'archived', query: '' })
      .then((response) => {
        if (!ignore) {
          setArchived(response.boards)
        }
      })
      .catch(() => {
        if (!ignore) {
          setArchived([])
        }
      })
    return () => {
      ignore = true
    }
  }, [archive, workspaceId])

  const remember = useCallback((id: string) => {
    restore.current = id
  }, [])

  const back = useCallback(() => {
    wanted.current = restore.current
    restore.current = null
    setFocusTick((tick) => tick + 1)
  }, [])

  /** Eine Mutation: waehrenddessen bleibt der bisherige Stand stehen, danach laedt die Huelle neu. */
  const run = useCallback(
    (
      kind: 'folder' | 'board',
      action: Promise<unknown>,
      fallback: string,
      done: (result: unknown) => void,
    ): void => {
      setBusy(true)
      setError(null)
      setInfo(null)
      action
        .then((result: unknown) => {
          done(result)
          onChanged()
        })
        .catch((cause: unknown) => {
          setError(kind === 'folder' ? folderMessageOf(cause, fallback) : messageOf(cause, fallback))
        })
        .finally(() => {
          setBusy(false)
        })
    },
    [onChanged],
  )

  const path = folderPath(folders, folder === BOARD_FOLDER_ROOT ? null : folder)
  const current = path.length === 0 ? null : (path[path.length - 1] ?? null)
  const heading =
    folder === null ? workspace.name : folder === BOARD_FOLDER_ROOT ? 'Boards ohne Ordner' : (current?.name ?? 'Ordner')

  /** Ordner sind Struktur des Arbeitsbereichs: lesen darf jedes Mitglied, formen seine Verwaltung. */
  const manageFolders =
    workspace.status === 'active' &&
    (workspace.role === 'owner' || workspace.role === 'admin' || me.user.isSystemAdmin)
  const editableBoard = (board: BoardView): boolean =>
    workspace.status === 'active' &&
    board.status === 'active' &&
    mayChangeBoard({ kind: 'member', role: board.viewerRole })
  /**
   * Duplizieren heisst: lesen und im selben Arbeitsbereich anlegen. Lesen darf jede Boardrolle, anlegen jedes
   * Mitglied eines aktiven Arbeitsbereichs; eine archivierte Quelle wird nicht kopiert.
   */
  const duplicableBoard = (board: BoardView): boolean => workspace.status === 'active' && board.status === 'active'
  /** Freigeben darf nur, wer das Board verantwortet - dieselbe Frage, die auch der Editor stellt. */
  const shareableBoard = (board: BoardView): boolean =>
    workspace.status === 'active' && mayManageBoard({ kind: 'member', role: board.viewerRole })

  const subfolders = archive
    ? []
    : childFolders(folders, folder === null || folder === BOARD_FOLDER_ROOT ? null : folder)
  const source = archive ? archived : (data?.boards ?? null)
  const boards =
    source === null ? null : boardsOfSelection(source, folder).filter((board) => matchesTitle(board.title, query))
  /**
   * Leerer Bestand und leere Treffermenge sind zwei verschiedene Zustaende.
   *
   * Der Titelfilter gilt den Boards; die Ordner dieses Knotens bleiben deshalb stehen, und "kein Treffer"
   * meint genau die Boards.
   */
  const leer = query === '' && subfolders.length === 0 && boards !== null && boards.length === 0
  const keinTreffer = query !== '' && boards !== null && boards.length === 0

  /** Der Ort, an dem ein neuer Ordner oder ein neues Board entsteht: der gewaehlte Knoten. */
  const place = folder === null || folder === BOARD_FOLDER_ROOT ? null : folder

  // Eine Ordnerkennung, die dieser Baum nicht (mehr) kennt: eine benannte Ansicht statt einer leeren Liste.
  if (data !== null && folder !== null && folder !== BOARD_FOLDER_ROOT && current === null) {
    return (
      <section aria-labelledby="explorer-inhalt">
        <h2 id="explorer-inhalt" className="visually-hidden">
          Diesen Ordner gibt es nicht
        </h2>
        <PageState
          kind="not-found"
          title="Diesen Ordner gibt es nicht (mehr)"
          description="Er wurde entfernt, oder die Adresse gehoert zu einem anderen Arbeitsbereich."
        >
          <Link
            className={actionClass('primary')}
            route={{ kind: 'arbeitsbereich', workspaceId, folder: null }}
          >
            Zu {workspace.name}
          </Link>
        </PageState>
      </section>
    )
  }

  return (
    <section aria-labelledby="explorer-inhalt">
      {path.length > 0 && (
        <nav aria-label="Pfad">
          <ol className="breadcrumb">
            <li>
              <Link route={{ kind: 'arbeitsbereich', workspaceId, folder: null }}>{workspace.name}</Link>
            </li>
            {path.slice(0, -1).map((entry) => (
              <li key={entry.id}>
                <Link route={{ kind: 'arbeitsbereich', workspaceId, folder: entry.id }}>{entry.name}</Link>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="page-head">
        <h2 id="explorer-inhalt" tabIndex={-1}>
          {heading}
          {workspace.status === 'active' ? '' : ' (archiviert)'}
        </h2>
        {/* Ein `div`, kein `p`: das Kontextmenue des Ordners ist ein Element auf Blockebene. */}
        <div className="actions">
          {workspace.status === 'active' && (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setCreating('board')
              }}
            >
              Board anlegen
            </Button>
          )}
          {manageFolders && (
            <Button
              icon={FolderPlus}
              onClick={() => {
                setCreating('folder')
              }}
            >
              Ordner anlegen
            </Button>
          )}
          {current !== null && (
            <EntryMenu
              target={{ kind: 'folder', folder: current }}
              editable={manageFolders}
              workspaceId={workspaceId}
              onRename={setRenaming}
              onMove={setMoving}
              onRemove={setRemoving}
            />
          )}
        </div>
      </div>

      {/* Eine Ablehnung aus einem offenen Dialog steht in diesem Dialog und nicht verdeckt dahinter. */}
      {error !== null && moving === null && removing === null && <Notice text={error} />}
      {info !== null && <Notice kind="success" text={info} />}

      <div className="board-filters">
        <div className="field">
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
        </div>
        {/* Umschaltbare Filter sind Pillen: ihr Zustand steht in `aria-pressed` und ist sichtbar gewaehlt. */}
        <div className="pills" role="group" aria-label="Filter">
          <button
            type="button"
            className="pill"
            aria-pressed={archive}
            onClick={() => {
              setArchive((was) => !was)
            }}
          >
            <Archive size={16} aria-hidden="true" />
            Archivierte Boards anzeigen
          </button>
        </div>
      </div>

      {explorer.error !== null && (
        <Notice>
          <p>{explorer.error}</p>
          <p className="actions">
            <Button icon={RotateCcw} onClick={explorer.reload}>
              Erneut laden
            </Button>
          </p>
        </Notice>
      )}

      {boards === null && <Loading text="Boards werden geladen …" />}

      {!leer && boards !== null && (
        <ul className="rows" aria-busy={explorer.busy || undefined}>
          {subfolders.map((entry) => (
            <li {...rowProps(`ordner-${entry.id}`)} key={entry.id}>
              <Link
                className="row__label"
                route={{ kind: 'arbeitsbereich', workspaceId, folder: entry.id }}
              >
                <Folder size={18} aria-hidden="true" />
                <span>{entry.name}</span>
              </Link>
              <span className="row__meta">Ordner</span>
              <div className="row__actions">
                <QuickActions
                  target={{ kind: 'folder', folder: entry }}
                  editable={manageFolders}
                  shareable={false}
                  workspaceId={workspaceId}
                  onRename={setRenaming}
                />
                <EntryMenu
                  target={{ kind: 'folder', folder: entry }}
                  editable={manageFolders}
                  workspaceId={workspaceId}
                  onRename={setRenaming}
                  onMove={setMoving}
                  onRemove={setRemoving}
                />
              </div>
            </li>
          ))}
          {(boards ?? []).map((board) => (
            <li {...rowProps(board.id)} key={board.id}>
              <Link
                className="row__label"
                route={{ kind: 'board', workspaceId, boardId: board.id, version: null, panel: null }}
              >
                <SquarePen size={18} aria-hidden="true" />
                <span>{board.title}</span>
              </Link>
              <span className="row__meta">
                {board.ownerDisplayName} · {new Date(board.updatedAt).toLocaleDateString('de-DE')}
              </span>
              <div className="row__actions">
                <QuickActions
                  target={{ kind: 'board', board }}
                  editable={editableBoard(board)}
                  shareable={shareableBoard(board)}
                  workspaceId={workspaceId}
                  onRename={setRenaming}
                />
                <EntryMenu
                  target={{ kind: 'board', board }}
                  editable={editableBoard(board)}
                  duplicable={duplicableBoard(board)}
                  workspaceId={workspaceId}
                  onRename={setRenaming}
                  onMove={setMoving}
                  onDuplicate={setDuplicating}
                  onRemove={setRemoving}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {(leer || keinTreffer) && (
        <PageState
          kind={keinTreffer ? 'no-results' : 'empty'}
          title={keinTreffer ? 'Kein Treffer' : 'Hier liegt noch nichts'}
          description={
            keinTreffer
              ? `Kein Board mit "${query}" im Titel.`
              : archive
                ? 'Es gibt keine archivierten Boards.'
                : workspace.status === 'active'
                  ? 'Lege hier das erste Board oder einen Ordner an.'
                  : 'Dieser Arbeitsbereich ist archiviert und unveraenderlich.'
          }
        />
      )}

      <NameDialog
        open={creating !== null}
        title={creating === 'folder' ? 'Ordner anlegen' : 'Board anlegen'}
        label={creating === 'folder' ? `Name des neuen Ordners in ${heading}` : `Titel des neuen Boards in ${heading}`}
        maxLength={creating === 'folder' ? MAX_FOLDER_NAME_LENGTH : MAX_BOARD_TITLE_LENGTH}
        submitLabel={creating === 'folder' ? 'Ordner anlegen' : 'Board anlegen'}
        errorOf={(cause) =>
          creating === 'folder'
            ? folderMessageOf(cause, 'Der Ordner konnte nicht angelegt werden.')
            : messageOf(cause, 'Das Board konnte nicht angelegt werden.')
        }
        onSubmit={(name) =>
          creating === 'folder'
            ? createFolder(me.csrfToken, { workspaceId, name, parentId: place }).then(() => {
                setCreating(null)
                onChanged()
              })
            : createBoard(me.csrfToken, workspaceId, name, place).then((board) => {
                setCreating(null)
                onChanged()
                // Das Anlegen endet dort, wo gearbeitet wird: im Editor des neuen Boards.
                navigate({ kind: 'board', workspaceId, boardId: board.id, version: null, panel: null })
              })
        }
        onClose={() => {
          setCreating(null)
        }}
      />

      <NameDialog
        open={renaming !== null}
        title={renaming === null ? 'Umbenennen' : `${targetName(renaming)} umbenennen`}
        label={renaming?.kind === 'folder' ? 'Neuer Name des Ordners' : 'Neuer Titel des Boards'}
        value={renaming === null ? '' : targetName(renaming)}
        maxLength={renaming?.kind === 'folder' ? MAX_FOLDER_NAME_LENGTH : MAX_BOARD_TITLE_LENGTH}
        submitLabel="Umbenennen"
        errorOf={(cause) =>
          renaming?.kind === 'folder'
            ? folderMessageOf(cause, 'Der Ordner konnte nicht umbenannt werden.')
            : messageOf(cause, 'Das Board konnte nicht umbenannt werden.')
        }
        onSubmit={(name) => {
          const action =
            renaming?.kind === 'folder'
              ? renameFolder(me.csrfToken, { folderId: renaming.folder.id, name })
              : renaming?.kind === 'board'
                ? renameBoard(me.csrfToken, renaming.board.id, name)
                : Promise.resolve()
          return action.then(() => {
            setRenaming(null)
            onChanged()
          })
        }}
        onClose={() => {
          setRenaming(null)
        }}
      />

      <MoveDialog
        target={moving}
        folders={folders}
        busy={busy}
        error={error}
        onClose={() => {
          setMoving(null)
          setError(null)
        }}
        onSubmit={(target, parentId) => {
          run(
            target.kind,
            target.kind === 'folder'
              ? moveFolder(me.csrfToken, { folderId: target.folder.id, parentId })
              : moveBoardToFolder(me.csrfToken, target.board.id, parentId),
            target.kind === 'folder'
              ? 'Der Ordner konnte nicht verschoben werden.'
              : 'Das Board konnte nicht verschoben werden.',
            () => {
              setMoving(null)
              remember(menuId(targetId(target)))
              back()
            },
          )
        }}
      />

      <DuplicateDialog
        board={duplicating}
        folders={folders}
        csrfToken={me.csrfToken}
        onClose={() => {
          setDuplicating(null)
        }}
        onDone={(copy) => {
          setDuplicating(null)
          onChanged()
          // Wie das Anlegen endet das Duplizieren dort, wo gearbeitet wird: im Editor der Kopie.
          navigate({ kind: 'board', workspaceId, boardId: copy.id, version: null, panel: null })
        }}
      />

      <Dialog
        open={removing !== null}
        danger
        title={removing === null ? 'Ordner entfernen' : `${removing.name} entfernen`}
        onClose={() => {
          setRemoving(null)
          setError(null)
        }}
      >
        {removing !== null && (
          <div className="stack">
            {error !== null && <Notice text={error} />}
            <p>
              Unterordner und Boards aus <strong>{removing.name}</strong> ruecken an seinen Platz:{' '}
              {folders.find((entry) => entry.id === removing.parentId)?.name ?? workspace.name}. Kein Board geht
              dabei verloren, und keines wird unsichtbar.
            </p>
            <p className="actions">
              <Button
                variant="danger"
                icon={Trash2}
                busy={busy}
                onClick={() => {
                  const name = removing.name
                  run(
                    'folder',
                    removeFolder(me.csrfToken, removing.id),
                    'Der Ordner konnte nicht entfernt werden.',
                    (result) => {
                      const moved = result as { readonly movedFolders: number; readonly movedBoards: number }
                      setRemoving(null)
                      remember('explorer-inhalt')
                      back()
                      setInfo(
                        `${name} entfernt. ${String(moved.movedFolders)} Unterordner und ${String(moved.movedBoards)} Boards sind an seinen Platz gerueckt.`,
                      )
                    },
                  )
                }}
              >
                Ordner entfernen
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  setRemoving(null)
                  setError(null)
                }}
              >
                Abbrechen
              </Button>
            </p>
          </div>
        )}
      </Dialog>
    </section>
  )
}

/**
 * Zielauswahl einer Verschiebung innerhalb des Arbeitsbereichs.
 *
 * Ein Knoten fuer die ganze Liste: so kehrt der Fokus verlaesslich zu dem Menue zurueck, aus dem der Dialog
 * kam. Der eigene Unterbaum steht nicht zur Wahl - er waere ein Ring. Der Server prueft es trotzdem.
 */
function MoveDialog({
  target,
  folders,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  readonly target: Target | null
  readonly folders: readonly FolderView[]
  readonly busy: boolean
  /** Eine Ablehnung bleibt im Dialog stehen, samt der gewaehlten Zielauswahl. */
  readonly error: string | null
  readonly onClose: () => void
  readonly onSubmit: (target: Target, parentId: string | null) => void
}) {
  const [parentId, setParentId] = useState<string | null>(null)

  // Beim Wechsel des Eintrags beginnt die Auswahl bei seinem heutigen Platz.
  useEffect(() => {
    setParentId(target === null ? null : target.kind === 'folder' ? target.folder.parentId : target.board.folderId)
  }, [target])

  return (
    <Dialog
      open={target !== null}
      title={target === null ? 'Verschieben' : `${targetName(target)} verschieben`}
      onClose={onClose}
    >
      {target !== null && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(target, parentId)
          }}
        >
          <FolderSelect
            id="verschieben-ziel"
            label={`Neuer Ort fuer ${targetName(target)}`}
            folders={folders}
            value={parentId}
            {...(target.kind === 'folder' ? { exclude: target.folder.id } : {})}
            disabled={busy}
            onChange={setParentId}
          />
          {error !== null && <Notice text={error} />}
          <p className="actions">
            <Button variant="primary" icon={FolderInput} type="submit" busy={busy}>
              Verschieben
            </Button>
            <Button variant="quiet" onClick={onClose}>
              Abbrechen
            </Button>
          </p>
        </form>
      )}
    </Dialog>
  )
}

/** Vorschlag fuer den Titel der Kopie. Gekuerzt wird der Originaltitel, nie der Zusatz. */
const COPY_SUFFIX = ' (Kopie)'

function copyTitle(title: string): string {
  return `${title.slice(0, MAX_BOARD_TITLE_LENGTH - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`
}

/**
 * Titel und Zielordner einer Kopie im selben Arbeitsbereich.
 *
 * Der Dialog fuehrt seinen Zustand selbst: eine Ablehnung erscheint hier und nicht hinter der Abdunklung,
 * und solange der Aufruf laeuft, ist die Schaltflaeche gesperrt - ein zweiter Klick legt keine zweite Kopie
 * an. Die Zielauswahl ist dieselbe wie beim Verschieben.
 */
function DuplicateDialog({
  board,
  folders,
  csrfToken,
  onClose,
  onDone,
}: {
  readonly board: BoardView | null
  readonly folders: readonly FolderView[]
  readonly csrfToken: string
  readonly onClose: () => void
  readonly onDone: (copy: BoardView) => void
}) {
  const [title, setTitle] = useState('')
  const [folderId, setFolderId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Jede Quelle beginnt mit dem Vorschlag und ihrem eigenen Ordner.
  useEffect(() => {
    setTitle(board === null ? '' : copyTitle(board.title))
    setFolderId(board?.folderId ?? null)
    setError(null)
  }, [board])

  return (
    <Dialog
      open={board !== null}
      title={board === null ? 'Duplizieren' : `${board.title} duplizieren`}
      onClose={onClose}
    >
      {board !== null && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            if (busy) {
              return
            }
            setBusy(true)
            setError(null)
            duplicateBoard(csrfToken, { boardId: board.id, title: title.trim(), folderId })
              .then(onDone)
              .catch((cause: unknown) => {
                setError(messageOf(cause, 'Das Board konnte nicht dupliziert werden.'))
              })
              .finally(() => {
                setBusy(false)
              })
          }}
        >
          <p>
            Kopiert wird der zuletzt gespeicherte Stand samt Bildern. Freigaben, Gastlinks und der Verlauf bleiben
            am Original; die Kopie gehoert dir.
          </p>
          <span className="field">
            <label htmlFor="duplizieren-titel">Titel der Kopie</label>
            <input
              id="duplizieren-titel"
              value={title}
              maxLength={MAX_BOARD_TITLE_LENGTH}
              required
              disabled={busy}
              onChange={(event) => {
                setTitle(event.target.value)
              }}
            />
          </span>
          <FolderSelect
            id="duplizieren-ziel"
            label="Ort der Kopie"
            folders={folders}
            value={folderId}
            disabled={busy}
            onChange={setFolderId}
          />
          {error !== null && <Notice text={error} />}
          <p className="actions">
            <Button variant="primary" icon={Copy} type="submit" busy={busy} disabled={title.trim().length === 0}>
              Duplizieren
            </Button>
            <Button variant="quiet" disabled={busy} onClick={onClose}>
              Abbrechen
            </Button>
          </p>
        </form>
      )}
    </Dialog>
  )
}
