/**
 * Ordner eines Arbeitsbereichs: Baum in der Seitenleiste und Verwaltung neben der Boardliste.
 *
 * Die Ordnung ist **Darstellung und keine Berechtigung**. Der Baum nennt ausschliesslich Ordner und nie
 * ihren Inhalt; was jemand an Boards sieht, entscheidet weiterhin der Server. Was diese Datei ausblendet,
 * ist Bequemlichkeit - jede Aktion wird serverseitig entschieden und jede Ablehnung hier als Text gezeigt.
 *
 * Bewusst ohne Ziehen und Ablegen: verschoben wird ueber ein Auswahlfeld. Das ist mit Tastatur und
 * Hilfsmitteln bedienbar und braucht kein Zeigegeraet.
 */

import { useState } from 'react'

import type { FolderView, MeResponse, WorkspaceView } from '../contracts/api.js'
import { BOARD_FOLDER_ROOT } from '../contracts/api.js'
import { MAX_FOLDER_NAME_LENGTH } from '../domain/folder/model.js'
import { ApiError, createFolder, moveFolder, removeFolder, renameFolder } from './api.js'
import { Link } from './router.js'
import { Empty, Notice } from './ui.js'

/** Uebersetzt eine Serverantwort in einen Satz. 404 und 403 bekommen bewusst eigene Texte. */
export function folderMessageOf(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) {
    return fallback
  }
  if (cause.status === 404) {
    return 'Diesen Ordner gibt es nicht (mehr).'
  }
  if (cause.status === 403) {
    return `Dafuer fehlt dir die Berechtigung. ${cause.message}`
  }
  return cause.message
}

/** Ein Ordner mit seiner Ebene. Die flache Liste des Endpunkts wird hier einmal zum Baum geordnet. */
export type FolderEntry = {
  readonly folder: FolderView
  /** 0 heisst: unmittelbar im Arbeitsbereich. */
  readonly depth: number
}

/**
 * Ordnet die flache Liste in die Reihenfolge des Baumes: jeder Ordner unmittelbar vor seinen Unterordnern.
 *
 * Die Sortierung innerhalb einer Ebene kommt vom Server (Name, dann Kennung) und wird hier nicht neu
 * erfunden - sonst zeigte die Seitenleiste eine andere Reihenfolge als die Antwort.
 */
export function orderFolders(folders: readonly FolderView[]): readonly FolderEntry[] {
  const entries: FolderEntry[] = []
  const walk = (parentId: string | null, depth: number): void => {
    for (const folder of folders.filter((candidate) => candidate.parentId === parentId)) {
      entries.push({ folder, depth })
      walk(folder.id, depth + 1)
    }
  }
  walk(null, 0)
  return entries
}

/** Der Ordner selbst und alles darunter - die Ziele, die fuer eine Verschiebung ausscheiden. */
function withDescendants(folders: readonly FolderView[], id: string): ReadonlySet<string> {
  const found = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const folder of folders) {
      if (folder.parentId !== null && found.has(folder.parentId) && !found.has(folder.id)) {
        found.add(folder.id)
        grew = true
      }
    }
  }
  return found
}

/** Einrueckung im Auswahlfeld: ein `option` traegt keine Struktur, nur Text. */
function indent(depth: number): string {
  return '  '.repeat(depth)
}

/**
 * Auswahlfeld fuer einen Ordner. Der leere Wert steht fuer den Arbeitsbereich selbst.
 *
 * `exclude` nimmt einen Ordner samt seinem Unterbaum aus den Zielen - eine Verschiebung dorthin waere ein
 * Ring. Der Server lehnt sie ohnehin ab; die Auswahl bietet sie gar nicht erst an.
 */
export function FolderSelect({
  id,
  label,
  folders,
  value,
  exclude,
  disabled,
  onChange,
}: {
  readonly id: string
  readonly label: string
  readonly folders: readonly FolderView[]
  readonly value: string | null
  readonly exclude?: string
  readonly disabled?: boolean
  readonly onChange: (folderId: string | null) => void
}) {
  const gesperrt = exclude === undefined ? new Set<string>() : withDescendants(folders, exclude)
  return (
    <span className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled === true}
        onChange={(event) => {
          onChange(event.target.value === '' ? null : event.target.value)
        }}
      >
        <option value="">Arbeitsbereich (kein Ordner)</option>
        {orderFolders(folders)
          .filter((entry) => !gesperrt.has(entry.folder.id))
          .map((entry) => (
            <option key={entry.folder.id} value={entry.folder.id}>
              {indent(entry.depth)}
              {entry.folder.name}
            </option>
          ))}
      </select>
    </span>
  )
}

/**
 * Ordnerbaum der Seitenleiste.
 *
 * Drei Arten von Zielen: alle Boards des Arbeitsbereichs, die ohne Ordner und je ein Ordner. Es sind
 * dieselben drei Werte, die auch der Endpunkt kennt.
 */
export function FolderTree({
  workspaceId,
  folders,
  active,
}: {
  readonly workspaceId: string
  readonly folders: readonly FolderView[]
  /** Gewaehlter Ordner: `null` alle, `BOARD_FOLDER_ROOT` die ohne Ordner, sonst eine Kennung. */
  readonly active: string | null
}) {
  return (
    <ul className="sidebar__list">
      <li>
        <Link route={{ kind: 'arbeitsbereich', workspaceId, folder: null }} current={active === null}>
          Alle Boards
        </Link>
      </li>
      <li>
        <Link
          route={{ kind: 'arbeitsbereich', workspaceId, folder: BOARD_FOLDER_ROOT }}
          current={active === BOARD_FOLDER_ROOT}
        >
          Ohne Ordner
        </Link>
      </li>
      {orderFolders(folders).map((entry) => (
        <li key={entry.folder.id} style={{ paddingLeft: `${String(entry.depth)}rem` }}>
          <Link
            route={{ kind: 'arbeitsbereich', workspaceId, folder: entry.folder.id }}
            current={active === entry.folder.id}
          >
            {entry.folder.name}
          </Link>
        </li>
      ))}
    </ul>
  )
}

function FolderRow({
  me,
  entry,
  folders,
  onChanged,
  onError,
}: {
  readonly me: MeResponse
  readonly entry: FolderEntry
  readonly folders: readonly FolderView[]
  readonly onChanged: () => void
  readonly onError: (message: string) => void
}) {
  const { folder } = entry
  const [name, setName] = useState(folder.name)
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)

  function run(action: Promise<unknown>, fallback: string): void {
    setBusy(true)
    onError('')
    action
      .then(() => {
        setRenaming(false)
        onChanged()
      })
      .catch((cause: unknown) => {
        onError(folderMessageOf(cause, fallback))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <tr>
      <td style={{ paddingLeft: `${String(entry.depth)}rem` }}>
        {renaming ? (
          <form
            className="field"
            onSubmit={(event) => {
              event.preventDefault()
              run(
                renameFolder(me.csrfToken, { folderId: folder.id, name }),
                'Der Ordner konnte nicht umbenannt werden.',
              )
            }}
          >
            <label htmlFor={`folder-name-${folder.id}`}>Neuer Name fuer {folder.name}</label>
            <input
              id={`folder-name-${folder.id}`}
              value={name}
              maxLength={MAX_FOLDER_NAME_LENGTH}
              required
              autoFocus
              onChange={(event) => {
                setName(event.target.value)
              }}
            />
            <p className="actions">
              <button className="button--primary" type="submit" disabled={busy || name.trim().length === 0}>
                Namen speichern
              </button>
              <button
                type="button"
                onClick={() => {
                  setName(folder.name)
                  setRenaming(false)
                }}
              >
                Umbenennen abbrechen
              </button>
            </p>
          </form>
        ) : (
          folder.name
        )}
      </td>
      <td>
        <FolderSelect
          id={`folder-parent-${folder.id}`}
          label={`Ordner ueber ${folder.name}`}
          folders={folders}
          value={folder.parentId}
          exclude={folder.id}
          disabled={busy}
          onChange={(parentId) => {
            run(
              moveFolder(me.csrfToken, { folderId: folder.id, parentId }),
              'Der Ordner konnte nicht verschoben werden.',
            )
          }}
        />
      </td>
      <td>
        {!renaming && (
          <span className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRenaming(true)
              }}
            >
              {folder.name} umbenennen
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                run(removeFolder(me.csrfToken, folder.id), 'Der Ordner konnte nicht entfernt werden.')
              }}
            >
              {folder.name} entfernen
            </button>
          </span>
        )}
      </td>
    </tr>
  )
}

/**
 * Verwaltung der Ordner: anlegen, umbenennen, verschachteln und entfernen.
 *
 * Angeboten wird sie nur der Verwaltung des Arbeitsbereichs - Ordner sind seine Struktur. Das ist die
 * Anzeige derselben Regel, die der Server durchsetzt, und keine zweite Entscheidung.
 */
export function Folders({
  me,
  workspace,
  folders,
  active,
  onChanged,
}: {
  readonly me: MeResponse
  readonly workspace: WorkspaceView
  readonly folders: readonly FolderView[]
  /** Gewaehlter Ordner; er ist der Vorschlag fuer den Platz eines neuen. */
  readonly active: string | null
  readonly onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [parentId, setParentId] = useState<string | null>(
    active === null || active === BOARD_FOLDER_ROOT ? null : active,
  )
  const [creating, setCreating] = useState(false)

  const canManage = workspace.role === 'owner' || workspace.role === 'admin' || me.user.isSystemAdmin
  const editable = canManage && workspace.status === 'active'

  return (
    <section aria-labelledby="folders-heading">
      <h4 id="folders-heading">Ordner</h4>

      {error !== null && error !== '' && <Notice text={error} />}

      {folders.length === 0 ? (
        <Empty text="Noch kein Ordner. Alle Boards liegen unmittelbar im Arbeitsbereich." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Ordner in {workspace.name}</caption>
            <thead>
              <tr>
                <th scope="col">Ordner</th>
                <th scope="col">Liegt in</th>
                <th scope="col">Aktion</th>
              </tr>
            </thead>
            <tbody>
              {orderFolders(folders).map((entry) =>
                editable ? (
                  <FolderRow
                    key={entry.folder.id}
                    me={me}
                    entry={entry}
                    folders={folders}
                    onChanged={onChanged}
                    onError={setError}
                  />
                ) : (
                  <tr key={entry.folder.id}>
                    <td style={{ paddingLeft: `${String(entry.depth)}rem` }}>{entry.folder.name}</td>
                    <td>
                      {folders.find((candidate) => candidate.id === entry.folder.parentId)?.name ??
                        'Arbeitsbereich'}
                    </td>
                    <td>—</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {editable && (
        <form
          className="stack card"
          onSubmit={(event) => {
            event.preventDefault()
            setCreating(true)
            setError(null)
            createFolder(me.csrfToken, { workspaceId: workspace.id, name: newName, parentId })
              .then(() => {
                setNewName('')
                onChanged()
              })
              .catch((cause: unknown) => {
                setError(folderMessageOf(cause, 'Der Ordner konnte nicht angelegt werden.'))
              })
              .finally(() => {
                setCreating(false)
              })
          }}
        >
          <div className="field">
            <label htmlFor="folder-new-name">Name des neuen Ordners</label>
            <input
              id="folder-new-name"
              value={newName}
              maxLength={MAX_FOLDER_NAME_LENGTH}
              required
              onChange={(event) => {
                setNewName(event.target.value)
              }}
            />
          </div>
          <FolderSelect
            id="folder-new-parent"
            label="Neuer Ordner liegt in"
            folders={folders}
            value={parentId}
            onChange={setParentId}
          />
          <p>
            <button className="button--primary" type="submit" disabled={creating || newName.trim().length === 0}>
              Ordner anlegen
            </button>
          </p>
        </form>
      )}
    </section>
  )
}
