/**
 * Repository-Ports des Board-Moduls.
 *
 * Dasselbe Muster wie im Workspace-Modul: **es gibt keine Objektabfrage ohne Workspace- und
 * Berechtigungsbezug.** Ein Board wird nie allein ueber seine Kennung geladen, sondern immer zusammen mit
 * dem Workspace und der Rolle des fragenden Nutzers (`findForUser`). Damit ist es gar nicht erst moeglich,
 * eine geratene Kennung ohne Berechtigungsfilter zu erreichen.
 */

import type { SceneSnapshot } from '../../contracts/scene.js'
import type { UserId } from '../identity/model.js'
import type { Workspace, WorkspaceId, WorkspaceRole } from '../workspace/model.js'
import type { AuditRepository, WorkspaceRepository } from '../workspace/repositories.js'
import type { Board, BoardId, BoardStatus } from './model.js'

/** Board samt Workspace und Rolle des fragenden Nutzers. `role === null` heisst Nichtmitglied. */
export type BoardAccess = {
  readonly board: Board
  readonly workspace: Workspace
  readonly role: WorkspaceRole | null
  readonly ownerDisplayName: string
}

/** Board mit Anzeigenamen seines Owners; die Liste soll keine zweite Abfrage je Zeile brauchen. */
export type BoardListEntry = {
  readonly board: Board
  readonly ownerDisplayName: string
}

export type BoardFilter = {
  readonly status: BoardStatus
  /** Teilstring im Titel, ohne Platzhalterdeutung. Leer heisst: kein Filter. */
  readonly title: string
}

export interface BoardRepository {
  /** Ausschliesslich Boards des angegebenen Workspace. Die Sichtbarkeit des Workspace prueft der Aufrufer. */
  listForWorkspace(workspaceId: WorkspaceId, filter: BoardFilter): Promise<readonly BoardListEntry[]>
  /** Board samt Workspace und eigener Rolle. `null` heisst: existiert nicht. */
  findForUser(id: BoardId, userId: UserId): Promise<BoardAccess | null>
  /**
   * Wie `findForUser`, sperrt die Boardzeile aber bis zum Ende der Transaktion. Jede Aenderung an Board oder
   * Szene laeuft darueber, damit gleichzeitige Speicherungen serialisiert werden und die Versionspruefung
   * nie auf einem veralteten Stand entscheidet. Nur in einer Transaktion gueltig.
   */
  findForUpdate(id: BoardId, userId: UserId): Promise<BoardAccess | null>
  create(workspaceId: WorkspaceId, title: string, ownerId: UserId): Promise<Board>
  rename(id: BoardId, title: string): Promise<Board>
  setStatus(id: BoardId, status: BoardStatus): Promise<Board>
  /** Setzt die aktuelle Szenenversion. Laeuft immer in derselben Transaktion wie `SceneRepository.append`. */
  setSceneVersion(id: BoardId, version: number): Promise<Board>
}

export type SceneVersion = {
  readonly boardId: BoardId
  readonly version: number
  readonly snapshot: SceneSnapshot
  readonly authorId: UserId | null
  readonly createdAt: Date
}

/**
 * Ein gespeicherter Datensatz laesst sich nicht mehr in den Szenenvertrag lesen. Wird als Fehler gemeldet;
 * ein beschaedigter Stand darf nie als leeres Board erscheinen.
 */
export class CorruptSceneError extends Error {
  readonly boardId: BoardId
  readonly version: number

  constructor(boardId: BoardId, version: number) {
    super(`Szenenversion ${String(version)} von Board ${boardId} ist beschaedigt`)
    this.name = 'CorruptSceneError'
    this.boardId = boardId
    this.version = version
  }
}

/** Auf dieselbe Ausgangsversion wurde bereits geschrieben. Die zweite Speicherung ueberschreibt nichts. */
export class SceneConflictError extends Error {
  constructor(cause?: unknown) {
    super('Die Szene wurde inzwischen von einer anderen Speicherung veraendert', { cause })
    this.name = 'SceneConflictError'
  }
}

export interface SceneRepository {
  /** Neuester Stand oder `null`, wenn das Board noch nie gespeichert wurde. */
  findLatest(boardId: BoardId): Promise<SceneVersion | null>
  /**
   * Legt genau die Version `version` an und wirft `SceneConflictError`, wenn es sie schon gibt. Der
   * Aufrufer erhoeht `boards.current_scene_version` in derselben Transaktion.
   */
  append(boardId: BoardId, version: number, snapshot: SceneSnapshot, authorId: UserId): Promise<SceneVersion>
  /** Begrenzt die Historie eines Boards auf die juengsten Versionen. */
  prune(boardId: BoardId, keepNewest: number): Promise<void>
}

/**
 * Metadaten eines Bildassets.
 *
 * **Nahtstelle fuer das folgende Paket.** Schema und Port stehen hier, damit Board- und Workspacebezug von
 * Anfang an Teil des Vertrags sind; Storage-Port, Upload und Abruf liefert das Assetpaket. Es gibt bewusst
 * noch keine PostgreSQL-Umsetzung: ungenutzter Code waere ein Versprechen ohne Nachweis.
 */
export type BoardAsset = {
  readonly id: string
  readonly boardId: BoardId
  readonly workspaceId: WorkspaceId
  /** Kennung der Datei im Szenenvertrag (`BinaryFileRef.id`). */
  readonly fileId: string
  readonly fileName: string | null
  readonly mimeType: string
  readonly byteSize: number
  readonly checksumSha256: string
  readonly storageKey: string
  readonly createdAt: Date
}

export type NewBoardAsset = Omit<BoardAsset, 'id' | 'createdAt'>

export interface BoardAssetRepository {
  listForBoard(boardId: BoardId): Promise<readonly BoardAsset[]>
  findByFileId(boardId: BoardId, fileId: string): Promise<BoardAsset | null>
  record(asset: NewBoardAsset): Promise<BoardAsset>
}

/**
 * Aenderung und zugehoeriges Auditereignis entstehen gemeinsam oder gar nicht. `workspaces` ist Teil des
 * Stores, weil jede Boardaktion zuerst die Sichtbarkeit des Workspace prueft und beides in derselben
 * Transaktion geschehen muss.
 */
export interface BoardStore {
  readonly boards: BoardRepository
  readonly scenes: SceneRepository
  readonly workspaces: WorkspaceRepository
  readonly audit: AuditRepository
  transaction<T>(run: (store: BoardStore) => Promise<T>): Promise<T>
}
