/**
 * Fachliche Ordnermodelle.
 *
 * Reiner Domain-Core: keine Datenbank, kein HTTP. Ein Ordner gehoert genau einem Arbeitsbereich und hat
 * hoechstens einen uebergeordneten Ordner desselben Arbeitsbereichs. Er ist **Gliederung und keine
 * Berechtigung**: welches Board jemand sehen darf, entscheiden weiterhin Mitgliedschaft und Boardrolle;
 * ein Ordner aendert daran nichts und traegt selbst keine Rechte.
 *
 * Die vier Invarianten - kein Zyklus, kein Ordner ueber Arbeitsbereichsgrenzen, eindeutiger Name je
 * Elternknoten und begrenzte Tiefe - stehen in **einer** Funktion (`checkFolderPlacement`). Anlegen,
 * Umbenennen und Verschieben sind derselbe Vorgang mit anderen Ausgangswerten, und eine zweite Fassung
 * waere genau die Stelle, an der eine der vier Regeln eines Tages abweicht.
 */

import type { WorkspaceId } from '../workspace/model.js'

export type FolderId = string

export type Folder = {
  readonly id: FolderId
  readonly workspaceId: WorkspaceId
  /** `null` heisst: der Ordner liegt unmittelbar im Arbeitsbereich. */
  readonly parentId: FolderId | null
  readonly name: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export const MAX_FOLDER_NAME_LENGTH = 80

/**
 * Hoechste zulaessige Schachtelung, gezaehlt ab dem Arbeitsbereich: ein Ordner unmittelbar im
 * Arbeitsbereich liegt auf Ebene 1.
 *
 * Die Grenze ist fachlich und nicht technisch: eine Gliederung, die tiefer als eine Handvoll Ebenen geht,
 * findet niemand mehr wieder - genau das Problem, das Ordner loesen sollen. Sie begrenzt zugleich die
 * Seitenleiste, die den Baum vollstaendig zeigt.
 */
export const MAX_FOLDER_DEPTH = 5

/** `null` bedeutet: leer oder zu lang. Die gleiche Regel gilt fuer Anlage und Umbenennung. */
export function normalizeFolderName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const name = raw.trim().replace(/\s+/g, ' ')
  return name.length === 0 || name.length > MAX_FOLDER_NAME_LENGTH ? null : name
}

/** Die vier Invarianten des Fachkerns, jede mit eigenem Grund. */
export type FolderViolation =
  /** Der Elternordner gehoert einem anderen Arbeitsbereich - oder es gibt ihn dort gar nicht. */
  | 'fremder-arbeitsbereich'
  /** Der Ordner soll unter sich selbst oder unter einen seiner Nachfahren wandern. */
  | 'zyklus'
  /** Ein Geschwisterordner traegt denselben Namen. */
  | 'name-doppelt'
  /** Die Schachtelung uebersteigt `MAX_FOLDER_DEPTH` - auch dann, wenn erst der Unterbaum sie sprengt. */
  | 'zu-tief'

/**
 * Der geplante Platz eines Ordners. `id === null` steht fuer eine Anlage - da gibt es den Ordner noch
 * nicht, und weder Zyklus noch Unterbaum koennen ihn betreffen.
 */
export type FolderPlacement = {
  readonly id: FolderId | null
  readonly workspaceId: WorkspaceId
  readonly parentId: FolderId | null
  readonly name: string
}

/** Kette vom Ordner aufwaerts, ohne ihn selbst. Bricht ab, sobald sie laenger als der Bestand waere. */
function ancestorsOf(byId: ReadonlyMap<FolderId, Folder>, start: FolderId | null): readonly FolderId[] {
  const chain: FolderId[] = []
  let current = start
  while (current !== null && chain.length <= byId.size) {
    chain.push(current)
    current = byId.get(current)?.parentId ?? null
  }
  return chain
}

/** Hoehe des Unterbaums: ein Ordner ohne Unterordner hat die Hoehe 1. */
function subtreeHeight(folders: readonly Folder[], id: FolderId | null): number {
  if (id === null) {
    return 1
  }
  const children = folders.filter((folder) => folder.parentId === id)
  return children.length === 0 ? 1 : 1 + Math.max(...children.map((child) => subtreeHeight(folders, child.id)))
}

/**
 * Prueft den geplanten Platz gegen alle vier Invarianten. `null` heisst: zulaessig.
 *
 * `folders` ist der vollstaendige Bestand des betroffenen Arbeitsbereichs, gelesen in **derselben**
 * Transaktion, in der geschrieben wird. Ohne das entschiede die Funktion auf einem veralteten Stand - und
 * zwei gleichzeitige Verschiebungen koennten gemeinsam einen Zyklus bauen, den jede fuer sich nicht sieht.
 *
 * Die Reihenfolge ist bewusst: erst der Arbeitsbereich, dann der Zyklus - eine Tiefe laesst sich in einem
 * Ring gar nicht berechnen -, dann die Tiefe, zuletzt der Name.
 */
export function checkFolderPlacement(
  folders: readonly Folder[],
  placement: FolderPlacement,
): FolderViolation | null {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))

  const self = placement.id === null ? null : byId.get(placement.id)
  if (self !== undefined && self !== null && self.workspaceId !== placement.workspaceId) {
    return 'fremder-arbeitsbereich'
  }
  if (placement.parentId !== null) {
    const parent = byId.get(placement.parentId)
    if (parent === undefined || parent.workspaceId !== placement.workspaceId) {
      return 'fremder-arbeitsbereich'
    }
  }

  if (placement.id !== null) {
    if (placement.parentId === placement.id) {
      return 'zyklus'
    }
    if (ancestorsOf(byId, placement.parentId).includes(placement.id)) {
      return 'zyklus'
    }
  }

  // Ebene des neuen Platzes plus die Hoehe des mitwandernden Unterbaums. Ein Ordner darf deshalb nicht
  // dorthin, wo zwar er selbst noch passte, seine Unterordner aber nicht mehr.
  const level = placement.parentId === null ? 1 : ancestorsOf(byId, placement.parentId).length + 1
  if (level + subtreeHeight(folders, placement.id) - 1 > MAX_FOLDER_DEPTH) {
    return 'zu-tief'
  }

  const name = placement.name.trim().toLowerCase()
  const doppelt = folders.some(
    (folder) =>
      folder.id !== placement.id &&
      folder.workspaceId === placement.workspaceId &&
      folder.parentId === placement.parentId &&
      folder.name.trim().toLowerCase() === name,
  )
  return doppelt ? 'name-doppelt' : null
}
