/**
 * Fachliche Boardmodelle.
 *
 * Reiner Domain-Core: keine Datenbank, kein HTTP, kein Excalidraw. Ein Board gehoert genau einem Workspace
 * und hat genau einen fachlichen Owner; beide Bezuege sind Teil des Modells und nicht optional.
 */

import type { UserId } from '../identity/model.js'
import type { WorkspaceId } from '../workspace/model.js'

export type BoardId = string

/** Archiviert heisst: lesbar, aber unveraenderlich. Nur das Entarchivieren selbst bleibt moeglich. */
export type BoardStatus = 'active' | 'archived'

/**
 * Rolle eines internen Nutzers auf genau einem Board.
 *
 * Eine eigene Ebene unterhalb der Workspace-Mitgliedschaft: `viewer` liest, `editor` liest und speichert,
 * `owner` verwaltet zusaetzlich die Freigaben und uebertraegt die Ownerschaft. Sie wirkt **zusaetzlich** zur
 * Mitgliedschaft und nie an ihr vorbei - wer den Arbeitsbereich nicht sehen darf, sieht auch kein Board
 * darin, gleich welche Boardrolle in der Datenbank steht.
 */
export type BoardRole = 'owner' | 'editor' | 'viewer'

/**
 * Die delegierbaren Boardrollen - also alles ausser der Ownerschaft.
 *
 * Die Ownerschaft ist keine Freigabe, sondern die Spalte `boards.owner_user_id`. Sie wird uebertragen und
 * nicht vergeben; dadurch hat ein Board immer genau einen Owner, ohne dass die Anwendung zaehlen muss.
 */
export type BoardGrantRole = Exclude<BoardRole, 'owner'>

export const BOARD_GRANT_ROLES: readonly BoardGrantRole[] = ['editor', 'viewer']

export function parseBoardGrantRole(raw: unknown): BoardGrantRole | null {
  return BOARD_GRANT_ROLES.find((candidate) => candidate === raw) ?? null
}

/**
 * Effektive Boardrolle eines Nutzers aus den beiden Quellen, die es dafuer gibt.
 *
 * Der fachliche Owner steht in `boards.owner_user_id` und schlaegt jede Freigabezeile; alles andere kommt
 * aus `board_grants`. `null` heisst: keine eigene Boardrolle - dann entscheidet allein die Mitgliedschaft.
 */
export function resolveBoardRole(
  ownerId: UserId,
  userId: UserId,
  granted: BoardGrantRole | null,
): BoardRole | null {
  return ownerId === userId ? 'owner' : granted
}

export type Board = {
  readonly id: BoardId
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly ownerId: UserId
  readonly status: BoardStatus
  /** Nummer der zuletzt gespeicherten Szene. `0` heisst: das Board wurde noch nie gespeichert. */
  readonly sceneVersion: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export const MAX_BOARD_TITLE_LENGTH = 120

/**
 * Standardlaenge der aufbewahrten Szenenhistorie je Board.
 *
 * Jede angenommene Speicherung legt eine neue Zeile an - das ist die Versionspruefung selbst und zugleich
 * die Grundlage der Versionshistorie. Ohne Grenze waechst sie unbegrenzt, deshalb faellt beim Anlegen alles
 * heraus, was aelter als die juengsten Versionen ist.
 *
 * Der Wert ist der **Standard**, nicht die Zusage: der Betrieb kann ihn ueber
 * `CANVAZ_SCENE_VERSION_RETENTION` anpassen, weil er zwischen Rueckweg und Speicherbedarf abwaegt. Die
 * fachliche Zusage ist die Begrenztheit selbst, nicht die Zahl - eine unbegrenzte Historie gibt es nicht.
 */
export const SCENE_VERSION_RETENTION = 100

/** `null` bedeutet: leer oder zu lang. Die gleiche Regel gilt fuer Anlage und Umbenennung. */
export function normalizeBoardTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const title = raw.trim().replace(/\s+/g, ' ')
  return title.length === 0 || title.length > MAX_BOARD_TITLE_LENGTH ? null : title
}

export function parseBoardStatus(raw: unknown): BoardStatus | null {
  return raw === 'active' || raw === 'archived' ? raw : null
}

/**
 * Aufsetzversion einer Speicherung. Der Client nennt die Version, auf der seine Aenderung beruht; alles
 * andere ist kein gueltiger Speichervorgang.
 */
export function parseBaseVersion(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null
}
