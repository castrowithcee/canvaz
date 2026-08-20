/**
 * Repository-Ports des Board-Moduls.
 *
 * Dasselbe Muster wie im Workspace-Modul: **es gibt keine Objektabfrage ohne Workspace- und
 * Berechtigungsbezug.** Ein Board wird nie allein ueber seine Kennung geladen, sondern immer zusammen mit
 * dem Workspace und der Rolle des fragenden Nutzers (`findForUser`). Damit ist es gar nicht erst moeglich,
 * eine geratene Kennung ohne Berechtigungsfilter zu erreichen.
 */

import type { SceneSnapshot } from '../../contracts/scene.js'
import type { FolderId } from '../folder/model.js'
import type { FolderRepository } from '../folder/repositories.js'
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
import type { Board, BoardGrantRole, BoardId, BoardRole, BoardStatus, DashboardFilter } from './model.js'

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

/**
 * Eine Zeile des Papierkorbs: das Board mit allem, was seine Zeile zeigt, aus **einer** Abfrage.
 *
 * Der urspruengliche Ordner steht mit Namen dabei, weil die Ansicht ihn nennt und eine zweite Abfrage je
 * Zeile dafuer eine Rundreise je Board waere. Die loeschende Person ist eine Auskunft und keine
 * Berechtigung: **wer wiederherstellen darf, entscheidet weiterhin die Policy** anhand von `boardRole`.
 */
export type TrashedBoardEntry = BoardListEntry & {
  /** Name des Ordners, in dem das Board lag; `null` heisst: unmittelbar im Arbeitsbereich. */
  readonly folderName: string | null
  /** Nie `null`: eine Zeile des Papierkorbs hat immer einen Loeschzeitpunkt. */
  readonly deletedAt: Date
  readonly deletedByUserId: UserId | null
  /** Anzeigename der loeschenden Person; `null`, wenn ihr Konto entfernt wurde. */
  readonly deletedByDisplayName: string | null
}

/** Ein Board, dessen Aufbewahrungsfrist abgelaufen ist. Nur, was der fristgesteuerte Lauf braucht. */
export type ExpiredTrashEntry = {
  readonly boardId: BoardId
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly deletedAt: Date
}

export type BoardFilter = {
  readonly status: BoardStatus
  /** Teilstring im Titel, ohne Platzhalterdeutung. Leer heisst: kein Filter. */
  readonly title: string
  /**
   * Gewaehlter Ordner. `null` heisst: kein Ordnerfilter - die ganze Liste des Arbeitsbereichs.
   * `{ folderId: null }` heisst: ausschliesslich die Boards unmittelbar im Arbeitsbereich.
   *
   * Der Filter waehlt aus, was ohnehin zugaenglich ist, und **erweitert den Zugriff nie**: die Liste ist
   * bereits auf den Arbeitsbereich des Anfragenden begrenzt, bevor ein Ordner ueberhaupt zaehlt.
   */
  readonly folder: { readonly folderId: FolderId | null } | null
}

/**
 * Abfrage der arbeitsbereichsuebergreifenden Dashboardliste.
 *
 * Der Status steht bewusst **nicht** darin: das Dashboard zeigt immer die aktiven Boards. Die Archivansicht
 * ist eine Sicht auf genau einen Arbeitsbereich und bleibt bei `listForWorkspace`.
 */
export type DashboardQuery = {
  /** `null` heisst: alle zugaenglichen Boards. */
  readonly kind: DashboardFilter | null
  /** Teilstring im Titel, ohne Platzhalterdeutung. Leer heisst: kein Filter. Mit `kind` kombinierbar. */
  readonly title: string
  readonly limit: number
}

/**
 * Eine Zeile des Dashboards: das Board mit allem, was seine Zeile braucht, aus **einer** Abfrage.
 *
 * Der Arbeitsbereich und die Mitgliedschaft stehen dabei, weil die Liste uebergreifend ist und jede Zeile
 * aus einem anderen Arbeitsbereich stammen kann; die Freigabemarken sagen nur **ob** geteilt wurde - ein
 * Token oder eine Adresse eines Gastlinks kommt hier nie vor.
 */
export type DashboardBoardEntry = BoardListEntry & {
  readonly workspace: Workspace
  /** Mitgliedschaft des Anfragenden im Arbeitsbereich dieser Zeile. Ohne sie gibt es die Zeile nicht. */
  readonly role: WorkspaceRole
  /** Wahr, wenn dieses Board an mindestens eine andere Person als seinen Owner intern freigegeben ist. */
  readonly sharedInternally: boolean
  /** Wahr, wenn mindestens ein weder widerrufener noch abgelaufener Gastlink darauf zeigt. */
  readonly sharedExternally: boolean
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
   * Aktive Boards **aller** Arbeitsbereiche des Anfragenden, juengste Aenderung zuerst.
   *
   * Die Mitgliedschaft steht als Join in der Abfrage selbst und nicht als nachgelagerter Filter: ein Board
   * ohne Mitgliedschaft im zugehoerigen Arbeitsbereich kommt gar nicht erst in das Ergebnis, gleich welcher
   * Filter gewaehlt ist. `now` entscheidet ueber Ablauf und Widerruf der Gastlinks und wird bei jedem
   * Aufruf frisch geprueft.
   */
  listForDashboard(userId: UserId, query: DashboardQuery, now: Date): Promise<readonly DashboardBoardEntry[]>
  /**
   * Board samt Workspace und eigener Rolle. `null` heisst: existiert nicht - oder, bei einem Gast, sein
   * Zugang gilt nicht (mehr) fuer dieses Board.
   *
   * **Ein Board im Papierkorb liefert dieser Weg nie.** Er ist der einzige Zugang zu einem einzelnen
   * Boarddatensatz - Szene, Bilder, Export, Versionen, Freigaben, Gastbeitritt und Realtime laufen alle
   * darueber -, und deshalb steht die Bedingung genau hier und nicht in jedem Aufrufer.
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
  /** `folderId` legt das neue Board unmittelbar in einen Ordner; `null` in den Arbeitsbereich selbst. */
  create(workspaceId: WorkspaceId, title: string, ownerId: UserId, folderId: FolderId | null): Promise<Board>
  rename(id: BoardId, title: string): Promise<Board>
  setStatus(id: BoardId, status: BoardStatus): Promise<Board>
  /**
   * Uebertraegt die Ownerschaft. `boards.owner_user_id` ist `not null` und traegt genau einen Owner; die
   * Uebertragung ersetzt ihn, statt einen zweiten anzulegen. Laeuft immer unter der Zeilensperre aus
   * `findForUpdate`, damit zwei gleichzeitige Uebertragungen serialisiert sind.
   */
  setOwner(id: BoardId, ownerId: UserId): Promise<Board>
  /**
   * Ordnet das Board einem Ordner zu; `null` legt es unmittelbar in den Arbeitsbereich. Dass der Ordner
   * zum selben Arbeitsbereich gehoert, erzwingt der zusammengesetzte Fremdschluessel - die Zuordnung ueber
   * eine Arbeitsbereichsgrenze hinweg ist gar nicht erst schreibbar.
   */
  setFolder(id: BoardId, folderId: FolderId | null): Promise<Board>
  /** Setzt die aktuelle Szenenversion. Laeuft immer in derselben Transaktion wie `SceneRepository.append`. */
  setSceneVersion(id: BoardId, version: number): Promise<Board>

  /* -- Papierkorb ------------------------------------------------------------------------------------ */

  /**
   * Boards im Papierkorb genau eines Arbeitsbereichs, juengste Loeschung zuerst.
   *
   * `userId` ist wie in `listForWorkspace` Pflicht: die Zeile traegt die eigene Boardrolle des Anfragenden,
   * und ueber sie entscheidet die Policy, wer eine Zeile ueberhaupt sehen und zuruecknehmen darf.
   */
  listTrashed(workspaceId: WorkspaceId, userId: UserId): Promise<readonly TrashedBoardEntry[]>
  /**
   * Wie `findForUpdate`, liefert aber **ausschliesslich** ein Board im Papierkorb.
   *
   * Der Gegenweg zu `findForViewer`/`findForUpdate`, die umgekehrt nie eines liefern. Beide Wege sind
   * getrennt, damit kein Aufrufer versehentlich in den jeweils anderen Zustand greift. Nur in einer
   * Transaktion gueltig.
   */
  findTrashedForUpdate(id: BoardId, userId: UserId): Promise<BoardAccess | null>
  /**
   * Sperrt ein Board im Papierkorb ohne jeden Rollenbezug - der Weg des **fristgesteuerten Laufs**.
   *
   * Er handelt fuer die Instanz und nicht fuer einen Nutzer; eine Rolle waere hier eine Erfindung. Die Frist
   * ist die ganze Berechtigung, und ob sie abgelaufen ist, prueft der Aufrufer unter genau dieser Sperre.
   * `null` heisst: das Board ist nicht (mehr) im Papierkorb. Nur in einer Transaktion gueltig.
   */
  lockTrashed(id: BoardId): Promise<Board | null>
  /** Legt das Board in den Papierkorb. Der Zeitpunkt ist der Beginn der Aufbewahrungsfrist. */
  moveToTrash(id: BoardId, deletedAt: Date, deletedBy: UserId): Promise<Board>
  /**
   * Nimmt das Board aus dem Papierkorb zurueck. Der Archivzustand bleibt dabei unberuehrt - er ist eine
   * eigene Achse und war vor dem Loeschen schon so.
   */
  restoreFromTrash(id: BoardId, folderId: FolderId | null): Promise<Board>
  /**
   * Boards, deren Aufbewahrungsfrist zum genannten Zeitpunkt abgelaufen ist. `limit` begrenzt den Lauf;
   * was nicht hineinpasst, kommt beim naechsten dran.
   */
  listExpiredTrash(deadline: Date, limit: number): Promise<readonly ExpiredTrashEntry[]>
  /**
   * Verschiebt das Board **samt Assets und Freigabelinks** in einen anderen Arbeitsbereich.
   *
   * Beide fuehren den Workspacebezug doppelt und sind darueber an das Board gebunden; sie muessen deshalb
   * in derselben Transaktion mitwandern. Nur in einer Transaktion gueltig.
   */
  setWorkspace(id: BoardId, workspaceId: WorkspaceId, folderId: FolderId | null): Promise<Board>
  /**
   * Entfernt das Board endgueltig.
   *
   * Szenenversionen, Assetdatensaetze, interne Freigaben, Gastlinks und Gastsessions haengen ueber
   * Fremdschluessel mit `on delete cascade` daran und fallen in derselben Anweisung weg - die Datenbank
   * garantiert die Vollstaendigkeit, nicht eine Reihenfolge im Anwendungscode. **Die Bytes im Storage
   * gehoeren nicht dazu**; sie werden nach dem Commit ueber ihre Schluessel entfernt.
   */
  purge(id: BoardId): Promise<void>
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
  /**
   * Entzieht **alle** internen Freigaben eines Boards und liefert ihre Zahl.
   *
   * Der Wechsel des Arbeitsbereichs: eine Freigabe gilt fuer ein Mitglied des bisherigen Arbeitsbereichs
   * und darf im Ziel niemandem etwas geben, das er dort nicht ohnehin haette.
   */
  removeAllForBoard(boardId: BoardId): Promise<number>
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

/**
 * Kopfdaten einer gespeicherten Version fuer die Historie.
 *
 * Bewusst **ohne** den Snapshot: eine Liste von hundert Versionen wuerde sonst hundert vollstaendige Szenen
 * durch den Speicher tragen, obwohl die Ansicht nur Zeitpunkt, Urheber und Umfang zeigt. Wer den Inhalt
 * will, holt genau eine Version ueber `find`.
 */
export type SceneVersionSummary = {
  readonly version: number
  readonly authorId: UserId | null
  /** Anzeigename des Urhebers; `null` bei einem Gast oder einem geloeschten Konto. */
  readonly authorDisplayName: string | null
  readonly createdAt: Date
  /** Zahl der Elemente einschliesslich Tombstones - der Umfang, den diese Version traegt. */
  readonly elementCount: number
  /** Groesse des serialisierten Snapshots in Bytes. */
  readonly byteSize: number
}

export interface SceneRepository {
  /** Neuester Stand oder `null`, wenn das Board noch nie gespeichert wurde. */
  findLatest(boardId: BoardId): Promise<SceneVersion | null>
  /**
   * Genau eine Version. `null` heisst: es gab sie nie oder die Aufbewahrungsgrenze hat sie entfernt - beide
   * Faelle sind fuer den Aufrufer dasselbe, naemlich "nicht mehr da".
   */
  find(boardId: BoardId, version: number): Promise<SceneVersion | null>
  /** Kopfdaten der juengsten Versionen, absteigend. Die Sichtbarkeit des Boards prueft der Aufrufer. */
  listVersions(boardId: BoardId, limit: number): Promise<readonly SceneVersionSummary[]>
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
  /**
   * Speicherschluessel aller Assets eines Boards.
   *
   * Grundlage des endgueltigen Loeschens: die Datenbankzeilen fallen mit dem Board weg, die Bytes hinter dem
   * Storage-Port nicht. Sie werden vor dem Loeschen gelesen und nach dem Commit entfernt.
   */
  listStorageKeys(boardId: BoardId): Promise<readonly string[]>
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
  /**
   * Widerruft alle noch gueltigen Links eines Boards und liefert deren Kennungen.
   *
   * Der Wechsel des Arbeitsbereichs: ein Gastlink zeigt auf ein Board in einem bestimmten Arbeitsbereich,
   * und er soll nicht stillschweigend in einen anderen weiterzeigen. Bereits widerrufene Links bleiben
   * unberuehrt - ihr Zeitpunkt ist der Nachweis, wann der Zugang endete.
   */
  revokeAllForBoard(boardId: BoardId, revokedAt: Date): Promise<readonly BoardShareLinkId[]>
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
  /** Die Ordner des Arbeitsbereichs: eine Zuordnung wird gegen denselben Bestand geprueft, der sie fuehrt. */
  readonly folders: FolderRepository
  readonly audit: AuditRepository
  transaction<T>(run: (store: BoardStore) => Promise<T>): Promise<T>
}
