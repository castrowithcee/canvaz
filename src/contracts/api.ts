/**
 * Geteilte HTTP-Vertraege zwischen Server und SPA.
 *
 * Beide Seiten importieren dieselben Typen und Pfade, damit eine Umbenennung im Typecheck auffaellt statt
 * zur Laufzeit.
 */

import type { BinaryFileRef, SceneSnapshot } from './scene.js'

export const API_BASE_PATH = '/api'

export const AUTH_LOGIN_PATH = `${API_BASE_PATH}/auth/login`
export const AUTH_LOGOUT_PATH = `${API_BASE_PATH}/auth/logout`
export const ME_PATH = `${API_BASE_PATH}/me`
export const ADMIN_USERS_PATH = `${API_BASE_PATH}/admin/users`
export const ADMIN_USER_STATUS_PATH = `${API_BASE_PATH}/admin/users/status`
export const REALTIME_PATH = `${API_BASE_PATH}/realtime`

export const WORKSPACES_PATH = `${API_BASE_PATH}/workspaces`
export const WORKSPACE_RENAME_PATH = `${API_BASE_PATH}/workspaces/rename`
export const WORKSPACE_STATUS_PATH = `${API_BASE_PATH}/workspaces/status`
export const WORKSPACE_MEMBERS_PATH = `${API_BASE_PATH}/workspaces/members`
export const WORKSPACE_MEMBER_ADD_PATH = `${API_BASE_PATH}/workspaces/members/add`
export const WORKSPACE_MEMBER_ROLE_PATH = `${API_BASE_PATH}/workspaces/members/role`
export const WORKSPACE_MEMBER_REMOVE_PATH = `${API_BASE_PATH}/workspaces/members/remove`
export const WORKSPACE_MEMBER_CANDIDATES_PATH = `${API_BASE_PATH}/workspaces/members/candidates`

/** Kennung des Workspace als Query-Parameter der lesenden Workspaceendpunkte. */
export const WORKSPACE_ID_PARAM = 'workspaceId'

/**
 * Suchbegriff der Nutzersuche fuer die Aufnahme. Ohne ihn gibt es keine Treffer: das interne Verzeichnis
 * ist keine Auskunft fuer jeden Angemeldeten, sondern nur eine Bestaetigung fuer den, der den Gesuchten
 * bereits kennt.
 */
export const WORKSPACE_MEMBER_QUERY_PARAM = 'q'

/** Kuerzere Eingaben werden abgewiesen, statt zu suchen. */
export const WORKSPACE_MEMBER_QUERY_MIN_LENGTH = 3

/** Hoechstzahl der Treffer. Auch mehrdeutige Namen ergeben nie eine Liste, sondern eine Handvoll Zeilen. */
export const WORKSPACE_MEMBER_MAX_CANDIDATES = 5

/**
 * Header des CSRF-Tokens. Ein Angreifer von einer fremden Herkunft kann ihn nicht setzen, ohne dass der
 * Browser vorher einen Preflight gegen diese Instanz stellt.
 */
export const CSRF_HEADER = 'x-canvaz-csrf'

export type HealthResponse = {
  readonly status: 'ok'
  readonly database: 'ok'
}

/**
 * Antwort der Bereitschaftspruefung.
 *
 * Getrennt von `HealthResponse`, weil beide verschiedene Fragen beantworten: `health` sagt, dass der Prozess
 * lebt und die Datenbank antwortet; `ready` sagt, dass diese Instanz Verkehr annehmen darf - also dass
 * zusaetzlich der konfigurierte Assetspeicher erreichbar und beschreibbar ist. Der Reverse Proxy fragt
 * `ready` und haelt Verkehr zurueck, solange die Antwort nicht 200 ist.
 */
export type ReadyResponse = {
  readonly status: 'ready' | 'unready'
  readonly database: 'ok' | 'error'
  readonly storage: 'ok' | 'error'
}

export type ErrorResponse = {
  readonly error: string
}

/**
 * Fehlerlage der Anmeldung. Der Callback haengt den Code als Query-Parameter an die Startseite; die SPA
 * uebersetzt ihn in einen Text. Details bleiben im Serverlog, damit die Anzeige nichts ueber den Provider
 * oder fremde Konten verraet.
 */
export const LOGIN_ERROR_PARAM = 'login_error'

export type LoginErrorCode =
  /** Der Nutzer hat die Anmeldung beim Provider abgebrochen oder ihr widersprochen. */
  | 'abgebrochen'
  /** Der Provider war nicht erreichbar oder hat unerwartet geantwortet. */
  | 'provider-fehler'
  /** Der transiente Flow-Zustand fehlt oder ist abgelaufen; die Anmeldung muss neu beginnen. */
  | 'flow-abgelaufen'
  /** State, Nonce oder ID-Token haben die Pruefung nicht bestanden. */
  | 'ungueltige-antwort'
  /** Der Autorisierungscode war ungueltig, abgelaufen oder bereits eingeloest. */
  | 'code-ungueltig'
  /** Das Konto existiert, ist aber deaktiviert. */
  | 'nutzer-deaktiviert'
  | 'unbekannt'

export type UserStatusView = 'active' | 'deactivated'

export type UserView = {
  readonly id: string
  readonly displayName: string
  readonly email: string | null
  readonly status: UserStatusView
  readonly isSystemAdmin: boolean
  /** ISO-8601. */
  readonly createdAt: string
  readonly updatedAt: string
}

export type MeResponse = {
  readonly user: UserView
  /** An die Session gebundenes Token fuer zustandsaendernde Anfragen. */
  readonly csrfToken: string
}

export type AdminUsersResponse = {
  readonly users: readonly UserView[]
}

export type SetUserStatusRequest = {
  readonly userId: string
  readonly status: UserStatusView
}

export type LogoutResponse = {
  /** Abmeldung beim Provider, falls der Issuer sie anbietet. Sonst `null`. */
  readonly endSessionUrl: string | null
}

export type WorkspaceStatusView = 'active' | 'archived'
export type WorkspaceRoleView = 'owner' | 'admin' | 'member'

export type WorkspaceView = {
  readonly id: string
  readonly name: string
  readonly status: WorkspaceStatusView
  /** Eigene Rolle. `null` heisst: sichtbar aus Systemadministration, aber keine Mitgliedschaft. */
  readonly role: WorkspaceRoleView | null
  /** ISO-8601. */
  readonly createdAt: string
  readonly updatedAt: string
}

export type WorkspaceMemberView = {
  readonly userId: string
  readonly displayName: string
  readonly email: string | null
  readonly role: WorkspaceRoleView
  /** ISO-8601, Beitritt. */
  readonly joinedAt: string
}

/**
 * Treffer der Nutzersuche: nur, was die Aufnahme braucht.
 *
 * `email` ist ausschliesslich dann gesetzt, wenn genau nach dieser Adresse gesucht wurde - dann kennt der
 * Suchende sie ohnehin schon. Ein ueber den Anzeigenamen gefundener Nutzer gibt seine Adresse nicht preis.
 */
export type DirectoryUserView = {
  readonly id: string
  readonly displayName: string
  readonly email: string | null
}

export type WorkspacesResponse = {
  readonly workspaces: readonly WorkspaceView[]
}

export type WorkspaceMembersResponse = {
  readonly workspace: WorkspaceView
  readonly members: readonly WorkspaceMemberView[]
}

export type WorkspaceCandidatesResponse = {
  readonly users: readonly DirectoryUserView[]
}

export type CreateWorkspaceRequest = {
  readonly name: string
}

export type RenameWorkspaceRequest = {
  readonly workspaceId: string
  readonly name: string
}

export type SetWorkspaceStatusRequest = {
  readonly workspaceId: string
  readonly status: WorkspaceStatusView
}

export type AddWorkspaceMemberRequest = {
  readonly workspaceId: string
  readonly userId: string
  readonly role: WorkspaceRoleView
}

export type ChangeWorkspaceMemberRoleRequest = AddWorkspaceMemberRequest

export type RemoveWorkspaceMemberRequest = {
  readonly workspaceId: string
  readonly userId: string
}

/** Antwort auf eine Rollenaenderung oder ein Entfernen. `role === null` heisst: nicht mehr Mitglied. */
export type WorkspaceMemberChangeResponse = {
  readonly userId: string
  readonly role: WorkspaceRoleView | null
}

/* ---------------------------------------------------------------------------------------------------- */
/* Boards und Szenen                                                                                     */
/* ---------------------------------------------------------------------------------------------------- */

export const BOARDS_PATH = `${API_BASE_PATH}/boards`
export const BOARD_RENAME_PATH = `${API_BASE_PATH}/boards/rename`
export const BOARD_STATUS_PATH = `${API_BASE_PATH}/boards/status`
/** Laden (GET) und Speichern (POST) der Szene eines Boards. */
export const BOARD_SCENE_PATH = `${API_BASE_PATH}/boards/scene`

/** Interne Freigaben eines Boards: lesen (GET), anlegen, aendern und entziehen (POST). */
export const BOARD_GRANTS_PATH = `${API_BASE_PATH}/boards/grants`
export const BOARD_GRANT_ADD_PATH = `${API_BASE_PATH}/boards/grants/add`
export const BOARD_GRANT_ROLE_PATH = `${API_BASE_PATH}/boards/grants/role`
export const BOARD_GRANT_REMOVE_PATH = `${API_BASE_PATH}/boards/grants/remove`
/** Uebertragung der Ownerschaft. Eigener Pfad, weil die Ownerschaft keine Freigabe ist. */
export const BOARD_OWNER_PATH = `${API_BASE_PATH}/boards/owner`

/** Kennung des Boards als Query-Parameter der lesenden Boardendpunkte. */
export const BOARD_ID_PARAM = 'boardId'
/** Titelfilter der Boardliste. Ein Teilstring ohne Platzhalterdeutung; leer heisst: kein Filter. */
export const BOARD_QUERY_PARAM = 'q'
/** Aktive Liste oder Archivansicht. Fehlt der Parameter, gilt `active`. */
export const BOARD_STATUS_PARAM = 'status'

export type BoardStatusView = 'active' | 'archived'

export type BoardView = {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly status: BoardStatusView
  readonly ownerUserId: string
  readonly ownerDisplayName: string
  /**
   * Effektive Rolle des Anfragenden auf genau diesem Board.
   *
   * Sie kommt aus derselben Policy, die auch jede Aktion entscheidet, und ist damit keine zweite Wahrheit:
   * eine Oberflaeche kann daran ablesen, was sie ueberhaupt anbieten soll, ohne die Regeln nachzubauen. Sie
   * ist trotzdem **keine Grenze** - abgelehnt wird weiterhin am Endpunkt.
   *
   * Der Archivzustand geht nicht ein; er steht in `status` und im Zustand des Arbeitsbereichs.
   */
  readonly viewerRole: BoardRoleView
  /** Nummer der zuletzt gespeicherten Szene. `0` heisst: noch nie gespeichert. */
  readonly sceneVersion: number
  /** ISO-8601. */
  readonly createdAt: string
  readonly updatedAt: string
}

export type BoardsResponse = {
  readonly workspace: WorkspaceView
  readonly boards: readonly BoardView[]
}

export type CreateBoardRequest = {
  readonly workspaceId: string
  readonly title: string
}

export type RenameBoardRequest = {
  readonly boardId: string
  readonly title: string
}

export type SetBoardStatusRequest = {
  readonly boardId: string
  readonly status: BoardStatusView
}

/**
 * Geoeffnetes Board samt Szene. `version` ist die Ausgangsversion der naechsten Speicherung; bei einem noch
 * nie gespeicherten Board ist sie `0` und `scene` der leere Ausgangsstand.
 *
 * `viewer` unterscheidet die beiden Antwortformen desselben Endpunkts. Es ist bewusst ein
 * **Unterscheidungsmerkmal** und kein Zusatzfeld: wer `SceneResponse` verarbeitet, muss darauf verzweigen
 * und kommt an die Boardsicht sonst gar nicht heran. Ein spaeterer Aufrufer kann den Unterschied damit
 * nicht versehentlich uebergehen und aus einer Gastantwort Felder lesen, die es dort nicht gibt.
 */
export type BoardSceneResponse = {
  readonly viewer: 'member'
  readonly board: BoardView
  readonly version: number
  readonly scene: SceneSnapshot
}

/**
 * Dieselbe Szene fuer einen Gast - mit der reduzierten Boardsicht.
 *
 * **Kein Workspacebezug, keine Ownerkennung, kein Owner-Anzeigename.** Ein Gast hat einen Link auf genau
 * ein Board bekommen; wem es gehoert, in welchem Arbeitsbereich es liegt und welche internen Kennungen
 * daran haengen, ist nicht Teil dieser Freigabe.
 */
export type GuestBoardSceneResponse = {
  readonly viewer: 'guest'
  readonly board: GuestBoardView
  readonly version: number
  readonly scene: SceneSnapshot
}

/** Was `GET /api/boards/scene` liefert. Welche der beiden Formen, entscheidet die Art der Sitzung. */
export type SceneResponse = BoardSceneResponse | GuestBoardSceneResponse

export type SaveSceneRequest = {
  readonly boardId: string
  /** Version, auf der diese Speicherung aufsetzt. */
  readonly baseVersion: number
  readonly scene: SceneSnapshot
}

export type SaveSceneResponse = {
  readonly version: number
  /** ISO-8601, serverseitiger Zeitpunkt der Speicherung. */
  readonly savedAt: string
}

/**
 * Antwort auf eine Speicherung, die auf einer ueberholten Version aufsetzt (409). Die aktuelle Version steht
 * dabei, damit die Oberflaeche den Abstand benennen kann, ohne zu raten.
 */
export type SceneConflictResponse = ErrorResponse & {
  readonly currentVersion: number
}

/* ---------------------------------------------------------------------------------------------------- */
/* Versionsverlauf, Export und Import                                                                    */
/* ---------------------------------------------------------------------------------------------------- */

/** Versionshistorie eines Boards (GET). Verlangt eine interne Sitzung und `board:read`. */
export const BOARD_VERSIONS_PATH = `${API_BASE_PATH}/boards/versions`
/** Read-only-Vorschau genau einer Version (GET). */
export const BOARD_VERSION_SCENE_PATH = `${API_BASE_PATH}/boards/versions/scene`
/** Wiederherstellung als neue Version (POST). Verlangt `scene:restore`. */
export const BOARD_VERSION_RESTORE_PATH = `${API_BASE_PATH}/boards/versions/restore`

/** Export eines Boards als `.excalidraw`-Datei (GET). Verlangt `board:read`. */
export const BOARD_EXPORT_PATH = `${API_BASE_PATH}/boards/export`
/** Import einer `.excalidraw`-Datei als neuer Stand (POST). Verlangt `scene:write`. */
export const BOARD_IMPORT_PATH = `${API_BASE_PATH}/boards/import`

/** Nummer der gewuenschten Version als Query-Parameter der Vorschau. */
export const BOARD_VERSION_PARAM = 'version'

/**
 * Kopfdaten einer gespeicherten Version.
 *
 * Bewusst ohne die Szene: die Liste zeigt Zeitpunkt, Urheber und Umfang. Wer den Inhalt sehen will, oeffnet
 * die Vorschau genau einer Version.
 */
export type BoardSceneVersionView = {
  readonly version: number
  /** Anzeigename des Urhebers; `null` heisst: ein Gast oder ein nicht mehr vorhandenes Konto. */
  readonly authorDisplayName: string | null
  /** ISO-8601. */
  readonly createdAt: string
  /** Zahl der Elemente einschliesslich geloeschter - der Umfang, den diese Version traegt. */
  readonly elementCount: number
  readonly byteSize: number
}

export type BoardVersionsResponse = {
  readonly board: BoardView
  /** Absteigend, juengste zuerst. */
  readonly versions: readonly BoardSceneVersionView[]
  /** Wie viele Staende je Board aufbewahrt werden. Aeltere fallen bei der naechsten Speicherung heraus. */
  readonly retention: number
  /**
   * Ob die eigene Rolle wiederherstellen darf - aus derselben Policy, die auch der Endpunkt befragt. Wie
   * `viewerRole` ist das Bequemlichkeit und keine Grenze: abgelehnt wird weiterhin am Endpunkt.
   */
  readonly mayRestore: boolean
}

/** Eine einzelne Version zum Ansehen. Sie wird nie zum aktuellen Stand, solange niemand sie wiederherstellt. */
export type BoardVersionSceneResponse = {
  readonly board: BoardView
  readonly version: number
  readonly scene: SceneSnapshot
}

/**
 * Wiederherstellung eines frueheren Standes.
 *
 * `baseVersion` ist der Stand, den der Anfragende gesehen hat. Weicht er vom aktuellen ab, hat inzwischen
 * jemand anderes gespeichert - dann antwortet der Server mit **409**, statt einen unerkannt neueren Stand
 * zu ueberschreiben. Erst ein zweiter Aufruf mit der genannten aktuellen Version ist die Bestaetigung.
 */
export type RestoreBoardVersionRequest = {
  readonly boardId: string
  readonly version: number
  readonly baseVersion: number
}

export type RestoreBoardVersionResponse = {
  /** Die **neue** Version. Eine Wiederherstellung loescht nichts, sondern legt einen neuen Stand an. */
  readonly version: number
  readonly restoredFrom: number
  /** ISO-8601. */
  readonly savedAt: string
}

/**
 * Import einer `.excalidraw`-Datei als neuer Stand.
 *
 * `file` ist der unveraenderte Inhalt der Datei. Er wird vollstaendig geprueft, bevor irgendetwas davon
 * gespeichert wird; `baseVersion` schuetzt wie bei der Speicherung vor dem Ueberschreiben eines neueren
 * Standes.
 */
export type ImportBoardSceneRequest = {
  readonly boardId: string
  readonly baseVersion: number
  readonly file: unknown
}

export type ImportBoardSceneResponse = {
  readonly version: number
  /** ISO-8601. */
  readonly savedAt: string
  readonly importedElements: number
  readonly importedFiles: number
}

/* ---------------------------------------------------------------------------------------------------- */
/* Interne Boardfreigaben                                                                                */
/* ---------------------------------------------------------------------------------------------------- */

export type BoardRoleView = 'owner' | 'editor' | 'viewer'

/**
 * Die vergebbaren Boardrollen. `owner` fehlt bewusst: die Ownerschaft wird uebertragen und nicht vergeben,
 * damit ein Board immer genau einen Owner hat.
 */
export type BoardGrantRoleView = Exclude<BoardRoleView, 'owner'>

export type BoardGrantView = {
  readonly userId: string
  readonly displayName: string
  readonly email: string | null
  readonly role: BoardGrantRoleView
  /** ISO-8601, Zeitpunkt der Freigabe. */
  readonly grantedAt: string
}

/**
 * Freigabeliste eines Boards. Der Owner steht nicht darin, sondern in `board.ownerUserId` - er ist keine
 * Freigabe, sondern der Verantwortliche.
 */
export type BoardGrantsResponse = {
  readonly board: BoardView
  readonly grants: readonly BoardGrantView[]
}

export type ShareBoardRequest = {
  readonly boardId: string
  readonly userId: string
  readonly role: BoardGrantRoleView
}

export type ChangeBoardGrantRoleRequest = ShareBoardRequest

export type RevokeBoardGrantRequest = {
  readonly boardId: string
  readonly userId: string
}

/** Antwort auf eine Freigabe, Rollenaenderung oder einen Entzug. `role === null` heisst: keine Freigabe mehr. */
export type BoardGrantChangeResponse = {
  readonly userId: string
  readonly role: BoardGrantRoleView | null
}

export type TransferBoardOwnershipRequest = {
  readonly boardId: string
  readonly userId: string
}

/* ---------------------------------------------------------------------------------------------------- */
/* Oeffentliche Gastfreigaben                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

/** Freigabelinks eines Boards: lesen (GET), anlegen und widerrufen (POST). Alle drei `grant:manage`. */
export const BOARD_SHARE_LINKS_PATH = `${API_BASE_PATH}/boards/share-links`
export const BOARD_SHARE_LINK_CREATE_PATH = `${API_BASE_PATH}/boards/share-links/create`
export const BOARD_SHARE_LINK_REVOKE_PATH = `${API_BASE_PATH}/boards/share-links/revoke`

/** Beitritt ueber einen Freigabelink. Der einzige Endpunkt der Boardebene ohne jede Sitzung. */
export const BOARD_GUEST_JOIN_PATH = `${API_BASE_PATH}/boards/guest/join`
/** Eigener Gastzugang: Board, Rolle und CSRF-Token. Die Entsprechung von `/api/me` fuer einen Gast. */
export const BOARD_GUEST_SESSION_PATH = `${API_BASE_PATH}/boards/guest/session`

/**
 * Pfad der Gastansicht in der SPA.
 *
 * Das Token steht im **Fragment** der geteilten Adresse (`/gast#<token>`) und nie in der
 * Abfragezeichenfolge: ein Fragment wird vom Browser nicht mitgesendet und landet damit weder in einem
 * Serverprotokoll noch in einem Referrer noch in einem Zwischenspeicher.
 */
export const GUEST_APP_PATH = '/gast'

export type GuestRoleView = 'guest-viewer' | 'guest-editor'

export type BoardShareLinkView = {
  readonly id: string
  readonly role: GuestRoleView
  /** Anzeigename des Erzeugers; `null`, wenn sein Konto nicht mehr existiert. */
  readonly createdByDisplayName: string | null
  /** ISO-8601. */
  readonly createdAt: string
  /** ISO-8601 oder `null`: dieser Link laeuft nicht von selbst ab. */
  readonly expiresAt: string | null
  /** ISO-8601 oder `null`. Ein widerrufener Link bleibt sichtbar, damit der Nachweis lesbar bleibt. */
  readonly revokedAt: string | null
  /** Zahl der bisher beigetretenen Gaeste. Ohne Namen und ohne Zeitpunkte. */
  readonly guestCount: number
}

export type BoardShareLinksResponse = {
  readonly board: BoardView
  readonly links: readonly BoardShareLinkView[]
}

export type CreateBoardShareLinkRequest = {
  readonly boardId: string
  /** Fehlt die Rolle, gilt `guest-viewer`. Schreibrecht ist immer eine ausdrueckliche Entscheidung. */
  readonly role?: GuestRoleView
  /** Lebensdauer in Stunden. Fehlt sie, laeuft der Link nicht von selbst ab. */
  readonly expiresInHours?: number
}

/**
 * Antwort auf die Anlage.
 *
 * `url` enthaelt das Klartexttoken und ist die **einzige** Stelle, an der es je erscheint. Es wird nirgends
 * gespeichert, nirgends protokolliert und laesst sich danach nicht noch einmal abrufen; ein verlorener Link
 * wird widerrufen und neu angelegt.
 */
export type CreateBoardShareLinkResponse = {
  readonly link: BoardShareLinkView
  readonly url: string
}

export type RevokeBoardShareLinkRequest = {
  readonly boardId: string
  readonly shareLinkId: string
}

export type JoinBoardAsGuestRequest = {
  readonly token: string
  readonly displayName: string
}

/**
 * Gueltiger Gastzugang.
 *
 * Bewusst ohne jede Angabe zum Arbeitsbereich, zu Mitgliedern oder zu anderen Boards: ein Gast erfaehrt
 * genau das, was er zum Arbeiten an diesem einen Board braucht.
 */
export type GuestSessionResponse = {
  readonly board: GuestBoardView
  readonly role: GuestRoleView
  /** Selbst gewaehlter Anzeigename; er erscheint im Teilnehmerfeld der Mitbearbeiter. */
  readonly displayName: string
  /** An die Gastsession gebundenes Token fuer zustandsaendernde Anfragen. */
  readonly csrfToken: string
  /** ISO-8601, Ende der Gastsession. Sie ueberlebt ihren Link nie. */
  readonly expiresAt: string
}

/** Was ein Gast von einem Board sieht: der Inhalt, den er bearbeitet, und sonst nichts. */
export type GuestBoardView = {
  readonly id: string
  readonly title: string
  readonly status: BoardStatusView
  /**
   * Effektive Rolle des Anfragenden auf diesem Board - dieselbe Aussage wie `viewerRole` der `BoardView`,
   * nur im Vokabular der Gastrollen. Damit steht sie in **beiden** Antwortformen an derselben Stelle, und
   * wer die Antwort verarbeitet, braucht dafuer keine Fallunterscheidung.
   *
   * Sie verraet nichts Internes: es ist die Rolle seines eigenen Links, die er beim Beitritt ohnehin
   * erfahren hat (`GuestSessionResponse.role`).
   */
  readonly viewerRole: GuestRoleView
  /** Nummer der zuletzt gespeicherten Szene. `0` heisst: noch nie gespeichert. */
  readonly sceneVersion: number
}

/* ---------------------------------------------------------------------------------------------------- */
/* Bildassets                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

/**
 * Hochladen (POST) und Abrufen (GET) einer Bilddatei eines Boards.
 *
 * Beim Upload stehen Board, Dateikennung und Dateiname in der Abfragezeichenfolge und die Bytes im
 * Anfragekoerper - roh, nicht als JSON und nicht als Formular. Damit gibt es keine Base64-Aufblaehung und
 * keinen Parser fuer mehrteilige Koerper.
 */
export const BOARD_ASSETS_PATH = `${API_BASE_PATH}/boards/assets`

/** Kennung der Datei im Szenenvertrag (`BinaryFileRef.id`), vom Editor vergeben. */
export const ASSET_FILE_ID_PARAM = 'fileId'
/** Urspruenglicher Dateiname. Rein beschreibend; er bestimmt weder Typ noch Speicherort. */
export const ASSET_FILE_NAME_PARAM = 'fileName'

export const MAX_ASSET_FILE_ID_LENGTH = 255
export const MAX_ASSET_FILE_NAME_LENGTH = 255

/**
 * Antwort eines angenommenen Uploads. `file` geht unveraendert in `SceneSnapshot.files` - der Client denkt
 * sich weder Groesse noch Speicherschluessel selbst aus.
 */
export type UploadBoardAssetResponse = {
  readonly file: BinaryFileRef
}
