/**
 * Repository-Port des Ordnermoduls.
 *
 * Dasselbe Muster wie in den anderen Modulen: **es gibt keine Objektabfrage ohne Workspacebezug.** Der
 * Bestand wird immer als ganzer Arbeitsbereich gelesen (`listForWorkspace`) - die Invarianten des
 * Fachkerns entscheiden ueber den vollstaendigen Baum, und eine Teilabfrage waere fuer sie nutzlos. Ein
 * Arbeitsbereich fuehrt eine Handvoll Ordner; rekursives SQL ist dafuer weder noetig noch billiger.
 *
 * `find` liefert den Ordner **samt** seinem Arbeitsbereich, damit die Route ihre Berechtigung gegen genau
 * diesen Arbeitsbereich entscheidet und nicht gegen einen mitgeschickten.
 */

import type { WorkspaceId } from '../workspace/model.js'
import type { Folder, FolderId } from './model.js'

/** Was das Aufloesen eines Ordners umgehaengt hat. Reine Zahlen fuer Antwort und Nachweis. */
export type DissolvedFolder = {
  readonly folders: number
  readonly boards: number
}

export interface FolderRepository {
  /** Vollstaendiger Bestand eines Arbeitsbereichs, nach Name sortiert. */
  listForWorkspace(workspaceId: WorkspaceId): Promise<readonly Folder[]>
  /** `null` heisst: existiert nicht. Der Workspacebezug steht im Ergebnis. */
  find(id: FolderId): Promise<Folder | null>
  create(workspaceId: WorkspaceId, parentId: FolderId | null, name: string): Promise<Folder>
  rename(id: FolderId, name: string): Promise<Folder>
  setParent(id: FolderId, parentId: FolderId | null): Promise<Folder>
  /**
   * Loest den Ordner auf: Unterordner und Boards ruecken an seinen Platz, danach faellt er weg.
   *
   * Ein Ordner ist Gliederung und kein Behaelter mit eigenem Lebenszyklus - sein Entfernen darf deshalb
   * nichts loeschen und nichts unsichtbar machen. Laeuft immer in derselben Transaktion, die die
   * Workspacezeile sperrt.
   */
  dissolve(id: FolderId, parentId: FolderId | null): Promise<DissolvedFolder>
}
