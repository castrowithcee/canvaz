/**
 * Fachliche Boardmodelle.
 *
 * Reiner Domain-Core: keine Datenbank, kein HTTP, kein Excalidraw. Ein Board gehoert genau einem Workspace
 * und hat genau einen fachlichen Owner; beide Bezuege sind Teil des Modells und nicht optional.
 */

import type { FolderId } from '../folder/model.js'
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
  /**
   * Ordner, in dem das Board liegt. `null` heisst: unmittelbar im Arbeitsbereich.
   *
   * Genau einer oder keiner - ein Board in mehreren Ordnern gibt es nicht. Die Zuordnung ist Gliederung
   * und **keine Berechtigung**: wer das Board sehen darf, sieht es unabhaengig von seinem Ordner.
   */
  readonly folderId: FolderId | null
  readonly status: BoardStatus
  /**
   * Zeitpunkt, zu dem das Board in den Papierkorb gelegt wurde. `null` heisst: nicht im Papierkorb.
   *
   * Eine **eigene Achse neben `status`** und kein weiterer Statuswert: `status` sagt, ob das Board
   * veraenderlich ist, `deletedAt` sagt, ob es ueberhaupt noch vorhanden ist. Ein Board im Papierkorb ist
   * fachlich nicht erreichbar - weder in einer Liste noch ueber eine Freigabe noch ueber einen Gastlink -,
   * und ein archiviertes Board behaelt beim Wiederherstellen seinen Archivzustand.
   */
  readonly deletedAt: Date | null
  /** Nummer der zuletzt gespeicherten Szene. `0` heisst: das Board wurde noch nie gespeichert. */
  readonly sceneVersion: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export const MAX_BOARD_TITLE_LENGTH = 120

/**
 * Standardfrist des Papierkorbs in Tagen.
 *
 * Vierzehn Tage sind lang genug, dass ein Irrtum auffaellt - eine Abwesenheit von zwei Wochen ist der
 * uebliche Fall -, und kurz genug, dass ein Arbeitsbereich nicht dauerhaft Boards sammelt, die niemand
 * mehr braucht. Der Wert ist der **Standard**, nicht die Zusage: der Betrieb kann ihn ueber
 * `CANVAZ_TRASH_RETENTION_DAYS` verschieben. Die fachliche Zusage ist die Begrenztheit selbst - eine
 * unbegrenzte Aufbewahrung gibt es nicht, und nach Ablauf hilft ausschliesslich die Sicherung.
 */
export const TRASH_RETENTION_DAYS = 14

const MILLISECONDS_PER_DAY = 86_400_000

/**
 * Zeitpunkt, zu dem die Instanz ein Board im Papierkorb endgueltig entfernt.
 *
 * Eine reine Funktion und die **einzige** Stelle, die aus Loeschzeitpunkt und Frist ein Ende macht: die
 * Anzeige der verbleibenden Frist und der fristgesteuerte Lauf rechnen damit nachweislich gleich.
 */
export function trashPurgeAt(deletedAt: Date, retentionDays: number): Date {
  return new Date(deletedAt.getTime() + retentionDays * MILLISECONDS_PER_DAY)
}

/**
 * Die Gegenrichtung derselben Frist: bis zu welchem Loeschzeitpunkt ist sie zum Zeitpunkt `now` abgelaufen?
 *
 * Der fristgesteuerte Lauf fragt so und nicht Zeile fuer Zeile - eine Abfrage mit einer Grenze statt einer
 * Berechnung je Board. Beide Richtungen teilen sich denselben Tagesfaktor und koennen deshalb nicht
 * auseinanderlaufen.
 */
export function trashDeadline(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * MILLISECONDS_PER_DAY)
}

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
 * Sicht auf die arbeitsbereichsuebergreifende Boardliste des Dashboards.
 *
 * Ein Filter waehlt aus, was ohnehin zugaenglich ist, und **erweitert den Zugriff nie**: die Liste ist
 * bereits auf die Boards des Anfragenden begrenzt, bevor ein Filter ueberhaupt zaehlt.
 *
 * - `owned`: der Anfragende ist Owner (`boards.owner_user_id`).
 * - `shared-by-me`: eigenes Board mit interner Freigabe an eine andere Person oder mit gueltigem Gastlink.
 * - `shared-with-me`: der Zugriff entsteht aus einer Boardfreigabe an ihn, nicht aus seiner Ownerschaft.
 * - `shared-externally`: mindestens ein gueltiger, nicht widerrufener Gastlink.
 */
export type DashboardFilter = 'owned' | 'shared-by-me' | 'shared-with-me' | 'shared-externally'

const DASHBOARD_FILTERS: readonly DashboardFilter[] = ['owned', 'shared-by-me', 'shared-with-me', 'shared-externally']

/** `null` heisst: kein Filter. Ein unbekannter Wert ist kein Fehler, sondern die ungefilterte Liste. */
export function parseDashboardFilter(raw: unknown): DashboardFilter | null {
  return DASHBOARD_FILTERS.find((candidate) => candidate === raw) ?? null
}

/**
 * Aufsetzversion einer Speicherung. Der Client nennt die Version, auf der seine Aenderung beruht; alles
 * andere ist kein gueltiger Speichervorgang.
 */
export function parseBaseVersion(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null
}
