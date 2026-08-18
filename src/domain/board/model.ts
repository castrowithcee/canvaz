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
 * Laenge der aufbewahrten Szenenhistorie je Board.
 *
 * Jede angenommene Speicherung legt eine neue Zeile an - das ist die Versionspruefung selbst und zugleich
 * die Grundlage der spaeteren Versionshistorie. Ohne Grenze waechst sie unbegrenzt, deshalb faellt beim
 * Anlegen alles heraus, was aelter als die juengsten Versionen ist. Ein fester Wert statt einer
 * Konfiguration: er ist eine fachliche Zusage, keine Betriebsschraube.
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
