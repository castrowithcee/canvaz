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
import type {
  AuthenticatedGuest,
  BoardShareLink,
  BoardShareLinkId,
  GuestRole,
  GuestSession,
  GuestSessionId,
} from './guest.js'
import type { Board, BoardGrantRole, BoardId, BoardRole, BoardStatus } from './model.js'

/**
 * Wer ein Board anfragt.
 *
 * Ein interner Nutzer bringt seine Nutzerkennung mit, ein Gast die Kennung seiner Gastsession. Beides sind
 * verschiedene Kennungsraeume und beide fuehren ueber **dieselbe** Abfrage zum Board - dadurch gibt es
 * weiterhin nur einen Weg zu einem Boarddatensatz, und ein Gast kann ihn nicht an der Berechtigung vorbei
 * nehmen.
 */
export type BoardViewer =
  | { readonly kind: 'user'; readonly userId: UserId }
  | { readonly kind: 'guest'; readonly guestSessionId: GuestSessionId }

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
  /**
   * Rolle eines Gastes auf genau diesem Board, aus seinem noch gueltigen Freigabelink. `null` heisst: kein
   * Gast oder kein gueltiger Link mehr. Bei einem internen Nutzer immer `null`, bei einem Gast sind
   * umgekehrt `role` und `boardRole` immer `null` - die beiden Ebenen mischen sich nie.
   */
  readonly guestRole: GuestRole | null
  readonly ownerDisplayName: string
}

/** Board mit Anzeigenamen seines Owners; die Liste soll keine zweite Abfrage je Zeile brauchen. */
export type BoardListEntry = {
  readonly board: Board
  readonly ownerDisplayName: string
  /**
   * Eigene Boardrolle des Anfragenden auf genau dieser Zeile - `null` heisst: keine ausdrueckliche, dann
   * entscheidet die Mitgliedschaft. Sie kommt aus derselben Abfrage wie die Zeile selbst; einzeln
   * nachgeladen waeren es so viele Abfragen wie Boards, und die Liste zeigte Rollen aus einem anderen
   * Zeitpunkt als die Boards.
   */
  readonly boardRole: BoardRole | null
}

export type BoardFilter = {
  readonly status: BoardStatus
  /** Teilstring im Titel, ohne Platzhalterdeutung. Leer heisst: kein Filter. */
  readonly title: string
}

export interface BoardRepository {
  /** Ausschliesslich Boards des angegebenen Workspace. Die Sichtbarkeit des Workspace prueft der Aufrufer. */
  /**
   * Boards eines Arbeitsbereichs samt der eigenen Boardrolle des Anfragenden.
   *
   * `userId` ist bewusst Pflicht und nicht optional: eine Liste ohne Anfragenden koennte keine Rolle nennen,
   * und ein Gast hat gar keine Liste - er kennt genau ein Board.
   */
  listForWorkspace(
    workspaceId: WorkspaceId,
    userId: UserId,
    filter: BoardFilter,
  ): Promise<readonly BoardListEntry[]>
  /**
   * Board samt Workspace und eigener Rolle. `null` heisst: existiert nicht - oder, bei einem Gast, sein
   * Zugang gilt nicht (mehr) fuer dieses Board.
   *
   * `now` entscheidet ueber Ablauf und Widerruf des Gastzugangs. Er wird bei **jedem** Aufruf frisch
   * geprueft und nirgends zwischengespeichert; deshalb wirkt ein Widerruf auch auf eine laengst offene
   * Verbindung, sobald sie das naechste Mal aufloest.
   */
  findForViewer(id: BoardId, viewer: BoardViewer, now: Date): Promise<BoardAccess | null>
  /**
   * Wie `findForViewer`, sperrt die Boardzeile aber bis zum Ende der Transaktion. Jede Aenderung an Board
   * oder Szene laeuft darueber, damit gleichzeitige Speicherungen serialisiert werden und die
   * Versionspruefung nie auf einem veralteten Stand entscheidet. Nur in einer Transaktion gueltig.
   */
  findForUpdate(id: BoardId, viewer: BoardViewer, now: Date): Promise<BoardAccess | null>
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
  /**
   * Urheber der Speicherung. `null` heisst: ein Gast hat sie geschrieben oder der Nutzer wurde inzwischen
   * aus der Datenbank entfernt. Ein Gast ist kein Nutzer und kann in dieser Spalte deshalb nicht stehen.
   */
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
  append(
    boardId: BoardId,
    version: number,
    snapshot: SceneSnapshot,
    authorId: UserId | null,
  ): Promise<SceneVersion>
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

/* ---------------------------------------------------------------------------------------------------- */
/* Oeffentliche Gastfreigaben                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

/** Freigabelink samt Anzeigename seines Erzeugers; die Liste soll keine zweite Abfrage je Zeile brauchen. */
export type BoardShareLinkEntry = BoardShareLink & {
  readonly createdByDisplayName: string | null
  /** Zahl der bisher daraus entstandenen Gastsessions. Reine Kennzahl, ohne Namen und ohne Zeitpunkte. */
  readonly guestCount: number
}

export type NewBoardShareLink = {
  readonly boardId: BoardId
  readonly workspaceId: WorkspaceId
  /** Hash des Tokens. Das Token selbst verlaesst den Server genau einmal, in der Antwort auf die Anlage. */
  readonly tokenHash: string
  readonly role: GuestRole
  readonly createdByUserId: UserId
  readonly expiresAt: Date | null
}

export interface BoardShareLinkRepository {
  /** Ausschliesslich Links genau dieses Boards. Die Berechtigung prueft der Aufrufer. */
  listForBoard(boardId: BoardId): Promise<readonly BoardShareLinkEntry[]>
  /** Link und Board zusammen; es gibt keine Abfrage allein ueber die Linkkennung. */
  find(boardId: BoardId, id: BoardShareLinkId): Promise<BoardShareLink | null>
  /**
   * Loest ein Freigabetoken auf. Liefert **nur** einen Link, der weder widerrufen noch abgelaufen ist -
   * Ablauf und Widerruf stehen in der Abfrage selbst und lassen sich damit nicht umgehen.
   */
  findLiveByTokenHash(tokenHash: string, now: Date): Promise<BoardShareLink | null>
  create(link: NewBoardShareLink): Promise<BoardShareLink>
  /**
   * Widerruft den Link. Idempotent: ein bereits widerrufener Link behaelt seinen Zeitpunkt, damit ein
   * zweiter Aufruf den Nachweis nicht verschiebt.
   */
  revoke(boardId: BoardId, id: BoardShareLinkId, revokedAt: Date): Promise<BoardShareLink | null>
}

export interface GuestSessionRepository {
  /**
   * Loest ein Gastgeheimnis auf. Liefert nur, was **beide** Invarianten erfuellt: lebende Gastsession und
   * lebender Link. Alles andere ist `null` - Ablauf und Widerruf wirken damit sofort und ohne Aufraeumlauf.
   */
  findAuthenticatedByTokenHash(tokenHash: string, now: Date): Promise<AuthenticatedGuest | null>
  create(session: {
    readonly shareLinkId: BoardShareLinkId
    readonly boardId: BoardId
    readonly tokenHash: string
    readonly displayName: string
    readonly expiresAt: Date
  }): Promise<GuestSession>
}

/**
 * Aenderung und zugehoeriges Auditereignis entstehen gemeinsam oder gar nicht. `workspaces` ist Teil des
 * Stores, weil jede Boardaktion zuerst die Sichtbarkeit des Workspace prueft und beides in derselben
 * Transaktion geschehen muss.
 */
export interface BoardStore {
  readonly boards: BoardRepository
  readonly grants: BoardGrantRepository
  readonly shareLinks: BoardShareLinkRepository
  readonly guests: GuestSessionRepository
  readonly scenes: SceneRepository
  readonly assets: BoardAssetRepository
  readonly workspaces: WorkspaceRepository
  readonly audit: AuditRepository
  transaction<T>(run: (store: BoardStore) => Promise<T>): Promise<T>
}
