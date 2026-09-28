/**
 * Ordner eines Arbeitsbereichs: die gemeinsamen Hilfen ueber dem flachen Endpunkt.
 *
 * Die Ordnung ist **Darstellung und keine Berechtigung**. Ein Ordner nennt nie, wer welches Board sehen
 * darf; das entscheidet weiterhin der Server. Was die Oberflaeche ausblendet, ist Bequemlichkeit - jede
 * Aktion wird serverseitig entschieden und jede Ablehnung als Text gezeigt.
 *
 * Hier steht ausschliesslich, was Baum **und** Inhaltsflaeche teilen: die Uebersetzung einer Ablehnung, die
 * Reihenfolge des Baumes und die Zielauswahl einer Verschiebung. Der Explorer selbst steht in
 * `explorer.tsx`, seine Sammlung in `boards.tsx`.
 *
 * Bewusst ohne Ziehen und Ablegen: verschoben wird ueber ein Auswahlfeld. Das ist mit Tastatur und
 * Hilfsmitteln bedienbar und braucht kein Zeigegeraet.
 */

import type { FolderView } from '../contracts/api.js'
import { ApiError } from './api.js'

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
  return '  '.repeat(depth)
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
