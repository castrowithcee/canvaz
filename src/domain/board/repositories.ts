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
import type { Board, BoardGrantRole, BoardId, BoardRole, BoardStatus } from './model.js'

/**
 * Board samt Workspace und beiden Rollen des fragenden Nutzers. `role === null` heisst Nichtmitglied,
 * `boardRole === null` heisst: keine eigene Boardrolle. Beide werden zusammen mit dem Board geladen, damit
 * eine Entscheidung nie auf zwei getrennten Abfragen und damit auf zwei Zeitpunkten beruht.
 */
export type BoardAccess = {
  readonly board: Board
  readonly workspace: Workspace
  readonly role: WorkspaceRole | null
  readonly boardRole: BoardRole | null
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
  /**
   * Uebertraegt die Ownerschaft. `boards.owner_user_id` ist `not null` und traegt genau einen Owner; die
   * Uebertragung ersetzt ihn, statt einen zweiten anzulegen. Laeuft immer unter der Zeilensperre aus
   * `findForUpdate`, damit zwei gleichzeitige Uebertragungen serialisiert sind.
   */
  setOwner(id: BoardId, ownerId: UserId): Promise<Board>
  /** Setzt die aktuelle Szenenversion. Laeuft immer in derselben Transaktion wie `SceneRepository.append`. */
  setSceneVersion(id: BoardId, version: number): Promise<Board>
}

/**
 * Eine interne Boardfreigabe.
 *
 * Der Workspacebezug steht mit im Vertrag, damit eine Freigabe ohne Workspacegrenze gar nicht erst
 * formulierbar ist - dasselbe Muster wie beim Assetdatensatz.
 */
export type BoardGrant = {
  readonly boardId: BoardId
  readonly workspaceId: WorkspaceId
  readonly userId: UserId
  readonly role: BoardGrantRole
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Freigabe samt Profilangaben fuer die Freigabeliste; sie soll keine zweite Abfrage je Zeile brauchen. */
export type BoardGrantEntry = BoardGrant & {
  readonly displayName: string
  readonly email: string | null
}

export interface BoardGrantRepository {
  /** Ausschliesslich Freigaben genau dieses Boards. Die Sichtbarkeit des Boards prueft der Aufrufer. */
  listForBoard(boardId: BoardId): Promise<readonly BoardGrantEntry[]>
  /** Board und Nutzer zusammen; es gibt keine Abfrage allein ueber die Nutzerkennung. */
  find(boardId: BoardId, userId: UserId): Promise<BoardGrant | null>
  /** Legt die Freigabe an. Wirft `BoardGrantConflictError`, wenn es sie schon gibt. */
  add(boardId: BoardId, workspaceId: WorkspaceId, userId: UserId, role: BoardGrantRole): Promise<BoardGrant>
  setRole(boardId: BoardId, userId: UserId, role: BoardGrantRole): Promise<BoardGrant>
  remove(boardId: BoardId, userId: UserId): Promise<void>
}

/** Die Freigabe besteht bereits (gleichzeitige Freigabe an denselben Nutzer). */
export class BoardGrantConflictError extends Error {
  constructor(cause: unknown) {
    super('Die Freigabe besteht bereits', { cause })
    this.name = 'BoardGrantConflictError'
  }
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
 * **Die Datenbank ist die Wahrheit ueber ein Asset, der Storage-Port kennt nur Bytes.** MIME-Typ, Groesse,
 * Pruefsumme und Speicherschluessel stehen hier; Board- und Workspacebezug sind Teil des Vertrags, damit
 * ein Abruf ohne Workspacegrenze gar nicht erst formulierbar ist.
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
  /**
   * Ausschliesslich innerhalb genau dieses Boards. Eine geratene Dateikennung erreicht damit nie ein
   * fremdes Asset, auch wenn sie zufaellig anderswo existiert.
   */
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
  readonly grants: BoardGrantRepository
  readonly scenes: SceneRepository
  readonly assets: BoardAssetRepository
  readonly workspaces: WorkspaceRepository
  readonly audit: AuditRepository
  transaction<T>(run: (store: BoardStore) => Promise<T>): Promise<T>
}
