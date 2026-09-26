/**
 * Geteilte HTTP-Vertraege zwischen Server und SPA.
 *
 * Beide Seiten importieren dieselben Typen und Pfade, damit eine Umbenennung im Typecheck auffaellt statt
 * zur Laufzeit.
 */

import type { BinaryFileRef, SceneSnapshot } from './scene.js'

export const API_BASE_PATH = '/api'

/** Einstieg der externen Anmeldung. Existiert nur mit konfiguriertem Identity Provider. */
export const AUTH_LOGIN_PATH = `${API_BASE_PATH}/auth/login`
export const AUTH_LOGOUT_PATH = `${API_BASE_PATH}/auth/logout`
/** Oeffentlich: welche Anmeldewege diese Instanz tatsaechlich hat. */
export const AUTH_METHODS_PATH = `${API_BASE_PATH}/auth/methods`
/** Lokale Anmeldung mit Adresse und Passwort. */
export const AUTH_LOCAL_LOGIN_PATH = `${API_BASE_PATH}/auth/local/login`
/** Passwortwechsel mit dem bisherigen Passwort - auch der erzwungene nach einem Initialpasswort. */
export const AUTH_LOCAL_PASSWORD_PATH = `${API_BASE_PATH}/auth/local/password`
/** Einloesen eines Einladungslinks: der Empfaenger setzt sein Passwort selbst. */
export const AUTH_INVITATION_REDEEM_PATH = `${API_BASE_PATH}/auth/invitation/redeem`
export const ME_PATH = `${API_BASE_PATH}/me`
/** Eigenes Erscheinungsbild aendern. Gelesen wird es mit dem Profil (`MeResponse.appearance`). */
export const ME_APPEARANCE_PATH = `${API_BASE_PATH}/me/appearance`
export const ADMIN_USERS_PATH = `${API_BASE_PATH}/admin/users`
export const ADMIN_USER_STATUS_PATH = `${API_BASE_PATH}/admin/users/status`
/** Kontoanlage durch den Systemadmin: Initialpasswort oder Einladungslink. */
export const ADMIN_USER_CREATE_PATH = `${API_BASE_PATH}/admin/users/create`
/** Administrative Ruecksetzung auf ein neues Initialpasswort. */
export const ADMIN_USER_PASSWORD_PATH = `${API_BASE_PATH}/admin/users/password`
/** Neue Einladung fuer ein vorhandenes Konto - zugleich der zweite Weg der Ruecksetzung. */
export const ADMIN_USER_INVITATION_PATH = `${API_BASE_PATH}/admin/users/invitation`
export const ADMIN_USER_INVITATION_REVOKE_PATH = `${API_BASE_PATH}/admin/users/invitation/revoke`
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
  /**
   * Die externe Anmeldung laesst sich keinem Konto zuordnen: die Adresse gehoert zu einem Profil, das
   * bereits ueber eine andere externe Identitaet erreichbar ist. Bewusst vage - der Anfragende ist an
   * dieser Stelle nicht der Inhaber des Kontos.
   */
  | 'konto-nicht-zuordenbar'
  | 'unbekannt'

/**
 * Pfad der Einloeseansicht in der SPA.
 *
 * Der Einladungswert steht wie beim Gastlink im **Fragment** (`/einladung#<token>`) und nie in der
 * Abfragezeichenfolge: ein Fragment sendet der Browser nicht mit und es landet damit weder in einem
 * Serverprotokoll noch in einem Referrer.
 */
export const INVITE_APP_PATH = '/einladung'

/** Untergrenze eines Passworts. Sie steht im Vertrag, damit die Oberflaeche sie nennen kann, statt zu raten. */
export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 200

/** Welche Anmeldewege diese Instanz anbietet. Der lokale Weg gibt es immer, der externe ist zugeschaltet. */
export type AuthMethodsResponse = {
  readonly local: true
  readonly oidc: boolean
}

export type LocalLoginRequest = {
  readonly email: string
  readonly password: string
}

/**
 * Ergebnis einer lokalen Anmeldung.
 *
 * `password-change-required` heisst: das Passwort stimmt, aber es ist ein Initialpasswort oder eine
 * Ruecksetzung. **Es entsteht dabei keine Sitzung** - der Wechsel geht ihr voraus, und ohne ihn ist nichts
 * erreichbar. Das ist die Durchsetzung selbst und nicht ihre Anzeige.
 */
export type LocalLoginResponse = {
  readonly status: 'ok' | 'password-change-required'
}

/**
 * Passwortwechsel. Er verlangt immer das bisherige Passwort und braucht deshalb keine Sitzung: derselbe
 * Endpunkt traegt den erzwungenen ersten Wechsel und den freiwilligen spaeteren.
 */
export type ChangePasswordRequest = {
  readonly email: string
  readonly currentPassword: string
  readonly newPassword: string
}

export type RedeemInvitationRequest = {
  readonly token: string
  readonly password: string
}

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
  /** Das eigene Erscheinungsbild; ohne gespeicherte Wahl `DEFAULT_APPEARANCE`. */
  readonly appearance: AppearanceView
}

/**
 * Farbschema der Produktschale. `system` folgt der Vorgabe des Betriebssystems und auch deren spaeterer
 * Aenderung; `light` und `dark` legen es fest.
 */
export const COLOR_SCHEMES = ['system', 'light', 'dark'] as const
export type ColorScheme = (typeof COLOR_SCHEMES)[number]

/**
 * Die waehlbaren Akzentfarben. Bewusst eine feste, kleine Palette und keine freie Eingabe: jede Farbe ist in
 * Hell und Dunkel auf Kontrast geprueft (Werte in `web/styles.css`). `violett` ist die bisherige
 * Canvaz-Farbe.
 */
export const ACCENT_COLORS = ['violett', 'blau', 'petrol', 'fuchsia', 'graphit'] as const
export type AccentColor = (typeof ACCENT_COLORS)[number]

/** Persoenliches Erscheinungsbild. Gilt nur fuer die Produktschale, nie fuer Boardinhalte. */
export type AppearanceView = {
  readonly colorScheme: ColorScheme
  readonly accent: AccentColor
}

/** Ohne gespeicherte Wahl: der Systemvorgabe folgen, bisherige Akzentfarbe - das Verhalten vor der Wahl. */
export const DEFAULT_APPEARANCE: AppearanceView = { colorScheme: 'system', accent: 'violett' }

/** Prueft einen Wert gegen die feste Aufzaehlung. `null` heisst: kein gueltiges Erscheinungsbild. */
export function parseAppearance(value: unknown): AppearanceView | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { colorScheme, accent } = value as { colorScheme?: unknown; accent?: unknown }
  const scheme = COLOR_SCHEMES.find((candidate) => candidate === colorScheme)
  const color = ACCENT_COLORS.find((candidate) => candidate === accent)
  return scheme === undefined || color === undefined ? null : { colorScheme: scheme, accent: color }
}

/**
 * Nutzerzeile der Systemadministration.
 *
 * Zusaetzlich zum Profil steht hier, **wie** das Konto erreichbar ist: ob es ein lokales Passwort hat und ob
 * eine Einladung offen ist. Nie steht hier ein Passwort, ein Hash oder ein Einladungswert.
 */
export type AdminUserView = UserView & {
  readonly hasPassword: boolean
  /** ISO-8601 der offenen Einladung; `null` heisst: keine offene Einladung. */
  readonly invitationExpiresAt: string | null
}

export type AdminUsersResponse = {
  readonly users: readonly AdminUserView[]
}

/**
 * Kontoanlage durch den Systemadmin.
 *
 * Genau einer der beiden Wege: mit `initialPassword` bekommt das Konto ein Initialpasswort, das beim ersten
 * Anmelden gewechselt werden muss; ohne entsteht ein befristeter Einladungslink. Beides wird ausserhalb der
 * Anwendung uebergeben - die Instanz versendet nichts.
 */
export type CreateUserRequest = {
  readonly displayName: string
  readonly email: string
  readonly initialPassword?: string
}

/**
 * Antwort der Anlage.
 *
 * `invitationUrl` traegt den Einladungswert und ist die **einzige** Stelle, an der er je erscheint; er wird
 * nur als Hash gespeichert und ist danach nicht wieder abrufbar. Ein Initialpasswort steht hier nie: es kam
 * vom Systemadmin und kommt nicht zurueck.
 */
export type CreateUserResponse = {
  readonly user: UserView
  readonly invitationUrl: string | null
}

export type ResetPasswordRequest = {
  readonly userId: string
  readonly password: string
}

export type CreateInvitationRequest = {
  readonly userId: string
}

export type CreateInvitationResponse = {
  readonly user: UserView
  readonly invitationUrl: string
}

export type RevokeInvitationRequest = {
  readonly userId: string
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
/* Ordner                                                                                                */
/* ---------------------------------------------------------------------------------------------------- */

/**
 * Ordnerbaum eines Arbeitsbereichs (GET) und Anlegen eines Ordners (POST).
 *
 * Ordner sind **Struktur des Arbeitsbereichs**: lesen darf sie jedes Mitglied, formen darf sie seine
 * Verwaltung. Sie tragen keine Rechte - welches Board jemand sieht, entscheiden weiterhin Mitgliedschaft
 * und Boardrolle. Ein Gast hat keinen Baum: er kennt genau ein Board.
 */
export const FOLDERS_PATH = `${API_BASE_PATH}/folders`
export const FOLDER_RENAME_PATH = `${API_BASE_PATH}/folders/rename`
export const FOLDER_MOVE_PATH = `${API_BASE_PATH}/folders/move`
export const FOLDER_REMOVE_PATH = `${API_BASE_PATH}/folders/remove`

/**
 * Ein Ordner des Baumes. Der Baum kommt als **flache Liste** mit Elternbezug, nach Name sortiert; die
 * Oberflaeche setzt ihn daraus zusammen. Eine verschachtelte Antwort waere dieselbe Information in einer
 * Form, die sich schlechter filtern und schlechter vergleichen laesst.
 */
export type FolderView = {
  readonly id: string
  readonly workspaceId: string
  /** `null` heisst: unmittelbar im Arbeitsbereich. */
  readonly parentId: string | null
  readonly name: string
  /** ISO-8601. */
  readonly createdAt: string
  readonly updatedAt: string
}

export type FoldersResponse = {
  readonly workspace: WorkspaceView
  /** Vollstaendiger Baum des Arbeitsbereichs, sortiert nach Name und dann nach Kennung. */
  readonly folders: readonly FolderView[]
}

export type CreateFolderRequest = {
  readonly workspaceId: string
  readonly name: string
  /** `null` legt den Ordner unmittelbar in den Arbeitsbereich. */
  readonly parentId: string | null
}

export type RenameFolderRequest = {
  readonly folderId: string
  readonly name: string
}

export type MoveFolderRequest = {
  readonly folderId: string
  readonly parentId: string | null
}

export type RemoveFolderRequest = {
  readonly folderId: string
}

/**
 * Ergebnis des Entfernens.
 *
 * Ein Ordner wird **aufgeloest, nicht ausgeraeumt**: seine Unterordner und Boards ruecken an seinen Platz.
 * Die beiden Zahlen sagen, wie viel dabei umgehaengt wurde - kein Board geht verloren, und keines wird
 * unsichtbar.
 */
export type RemoveFolderResponse = {
  readonly folderId: string
  /** Neuer Platz des Inhalts: der Elternordner des entfernten Ordners, `null` der Arbeitsbereich selbst. */
  readonly parentId: string | null
  readonly movedFolders: number
  readonly movedBoards: number
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

/**
 * Ordnerfilter der Boardliste. Fehlt der Parameter, zeigt die Liste **alle** Boards des Arbeitsbereichs -
 * das ist der Stand vor den Ordnern und bleibt es. `BOARD_FOLDER_ROOT` waehlt die Boards unmittelbar im
 * Arbeitsbereich, jede andere Kennung genau diesen einen Ordner (ohne seine Unterordner).
 */
export const BOARD_FOLDER_PARAM = 'folderId'

/** Der Arbeitsbereich selbst als Ordnerwahl. Keine Kennung, deshalb ein Wort statt einer UUID. */
export const BOARD_FOLDER_ROOT = 'root'

/** Board in einen Ordner legen oder aus ihm loesen. */
export const BOARD_FOLDER_PATH = `${API_BASE_PATH}/boards/folder`

export type MoveBoardRequest = {
  readonly boardId: string
  /** `null` legt das Board unmittelbar in den Arbeitsbereich. */
  readonly folderId: string | null
}

/**
 * Board in einen **anderen Arbeitsbereich** verschieben (POST).
 *
 * Eine andere Aktion als die Ordnerablage und deshalb ein eigener Pfad: das Board verlaesst seinen
 * bisherigen Arbeitsbereich. Der Anfragende braucht die Bestandsverantwortung in der **Quelle** (Board-Owner
 * oder Verwaltung des Arbeitsbereichs) und eine Mitgliedschaft im **Ziel**, die dort ein Board anlegen darf.
 *
 * **Freigaben und Gastlinks wandern nicht mit**: interne Freigaben werden entzogen, gueltige Gastlinks
 * widerrufen. Sie gehoeren zu Personen und Empfaengern des bisherigen Arbeitsbereichs; stillschweigend
 * weiterzugelten hiesse, dass ein Wechsel Zugriff verschiebt, ohne dass jemand es entscheidet.
 */
export const BOARD_WORKSPACE_PATH = `${API_BASE_PATH}/boards/workspace`

export type MoveBoardToWorkspaceRequest = {
  readonly boardId: string
  /** Ziel-Arbeitsbereich. Muss ein anderer sein als der bisherige. */
  readonly workspaceId: string
  /** Ordner im Ziel; fehlt er oder ist er `null`, liegt das Board unmittelbar im Arbeitsbereich. */
  readonly folderId?: string | null
}

/**
 * Board innerhalb seines Arbeitsbereichs duplizieren (POST, Antwort `BoardView` der Kopie mit 201).
 *
 * Kopiert wird der **zuletzt gespeicherte** Stand samt aller darin genannten Bilder; die Kopie bekommt eine
 * eigene Kennung, eigene Assetdatensaetze und eigene Bytes und gehoert dem Anfragenden. Freigaben, Gastlinks,
 * Versionsverlauf und Archivzustand bleiben am Original - die Kopie beginnt aktiv mit genau einer Version.
 * Verlangt `board:read` auf der Quelle und `board:create` in deren Arbeitsbereich.
 */
export const BOARD_DUPLICATE_PATH = `${API_BASE_PATH}/boards/duplicate`

export type DuplicateBoardRequest = {
  readonly boardId: string
  readonly title: string
  /** Ordner der Kopie im selben Arbeitsbereich; fehlt er oder ist er `null`, liegt sie unmittelbar darin. */
  readonly folderId?: string | null
}

export type BoardStatusView = 'active' | 'archived'

export type BoardView = {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly status: BoardStatusView
  readonly ownerUserId: string
  readonly ownerDisplayName: string
  /**
   * Ordner, in dem das Board liegt; `null` heisst: unmittelbar im Arbeitsbereich.
   *
   * Reine Ablage. Sie sagt **nichts** ueber die Berechtigung: wer das Board sehen darf, sieht es in jedem
   * Ordner, und wer es nicht darf, erfaehrt auch ueber den Ordner nichts von ihm.
   */
  readonly folderId: string | null
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
  /** Ordner des neuen Boards; fehlt er oder ist er `null`, liegt es unmittelbar im Arbeitsbereich. */
  readonly folderId?: string | null
}

/* ---------------------------------------------------------------------------------------------------- */
/* Dashboard                                                                                             */
/* ---------------------------------------------------------------------------------------------------- */

/**
 * Arbeitsbereichsuebergreifende Boardliste (GET), sortiert nach letzter Aenderung.
 *
 * Verlangt eine **interne** Sitzung: ein Gast kennt genau ein Board und hat kein Dashboard. Die Liste ist
 * serverseitig autorisiert und enthaelt ausschliesslich Boards, auf die der Anfragende tatsaechlich Zugriff
 * hat; archivierte Boards stehen nicht darin.
 */
export const BOARD_DASHBOARD_PATH = `${API_BASE_PATH}/boards/dashboard`

/**
 * Aktiver Filter der Dashboardliste. Fehlt der Parameter oder ist er unbekannt, gilt die ungefilterte
 * Liste. Der Titelfilter ist derselbe `BOARD_QUERY_PARAM` wie in der Boardliste; beide sind kombinierbar.
 */
export const DASHBOARD_FILTER_PARAM = 'filter'

/**
 * Hoechstzahl der Eintraege. Das Dashboard ist der Einstieg in die juengste Arbeit und kein Verzeichnis;
 * wer alles eines Arbeitsbereichs sucht, findet es in dessen Boardliste.
 */
export const DASHBOARD_LIMIT = 50

/**
 * Die vier Sichten auf dieselbe Liste. Ein Filter **erweitert den Zugriff nie** - er waehlt aus, was ohnehin
 * schon zugaenglich ist.
 */
export type DashboardFilterView =
  /** Der Anfragende ist Owner des Boards. */
  | 'owned'
  /** Eigenes Board mit interner Freigabe an eine andere Person oder mit gueltigem Gastlink. */
  | 'shared-by-me'
  /** Der Zugriff entsteht aus einer Boardfreigabe an ihn, nicht aus seiner Ownerschaft. */
  | 'shared-with-me'
  /** Mindestens ein gueltiger, nicht widerrufener Gastlink. */
  | 'shared-externally'

/** Reihenfolge der Filter in der Oberflaeche; zugleich die zulaessigen Werte des Parameters. */
export const DASHBOARD_FILTERS: readonly DashboardFilterView[] = [
  'owned',
  'shared-by-me',
  'shared-with-me',
  'shared-externally',
]

/**
 * Woher der Zugriff auf genau diesen Eintrag stammt. Steht in **jeder** Zeile, auch in der ungefilterten
 * Liste - die Zuordnung soll ohne Filter lesbar bleiben.
 */
export type BoardAccessOriginView =
  /** Ownerschaft am Board selbst (`boards.owner_user_id`). */
  | 'owner'
  /** Eine interne Boardfreigabe an den Anfragenden. */
  | 'grant'
  /** Kein eigener Boardbezug: der Zugriff kommt allein aus der Mitgliedschaft im Arbeitsbereich. */
  | 'workspace'

/**
 * Eine Zeile des Dashboards.
 *
 * Zusaetzlich zur Boardsicht der Name des Arbeitsbereichs (die Liste ist uebergreifend) und der
 * Freigabezustand. **Weder Token noch Adresse eines Gastlinks stehen hier** - nur, dass eine externe
 * Freigabe besteht.
 */
export type DashboardBoardView = BoardView & {
  readonly workspaceName: string
  readonly accessOrigin: BoardAccessOriginView
  /** Wahr, wenn dieses Board an mindestens eine andere Person intern freigegeben ist. */
  readonly sharedInternally: boolean
  /** Wahr, wenn mindestens ein gueltiger, nicht widerrufener Gastlink besteht. */
  readonly sharedExternally: boolean
}

export type DashboardResponse = {
  /** Absteigend nach letzter Aenderung, auf `DASHBOARD_LIMIT` begrenzt. */
  readonly boards: readonly DashboardBoardView[]
}

export type RenameBoardRequest = {
  readonly boardId: string
  readonly title: string
}

export type SetBoardStatusRequest = {
  readonly boardId: string
  readonly status: BoardStatusView
}

/* ---------------------------------------------------------------------------------------------------- */
/* Papierkorb                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

/**
 * Papierkorb eines Arbeitsbereichs (GET) und Loeschen eines Boards in den Papierkorb (POST).
 *
 * Ein Board im Papierkorb ist **fachlich nicht mehr vorhanden**: es steht in keiner Boardliste, in keinem
 * Dashboard und in keiner Suche, es laesst sich nicht mehr oeffnen, seine Bilder, Versionen und Exporte sind
 * unerreichbar, und jeder interne wie externe Freigabezugriff endet sofort - auch ein noch gueltiger
 * Gastlink fuehrt nicht mehr dorthin. Offene Verbindungen des Boards werden im selben Moment geschlossen.
 *
 * Es bleibt fuer die Dauer der Aufbewahrungsfrist wiederherstellbar. Danach entfernt die Instanz es ohne
 * Zutun endgueltig; ab diesem Punkt hilft ausschliesslich die Sicherung.
 */
export const BOARD_TRASH_PATH = `${API_BASE_PATH}/boards/trash`
/** Wiederherstellen aus dem Papierkorb (POST). Nimmt eine Auswahl und traegt damit den Einzelfall mit. */
export const BOARD_TRASH_RESTORE_PATH = `${API_BASE_PATH}/boards/trash/restore`
/** Sofortiges endgueltiges Loeschen aus dem Papierkorb (POST). Ebenfalls fuer eine Auswahl. */
export const BOARD_TRASH_PURGE_PATH = `${API_BASE_PATH}/boards/trash/purge`

/**
 * Hoechstzahl der Boards einer Auswahl.
 *
 * Der Papierkorb eines Arbeitsbereichs ist kein Verzeichnis; eine Auswahl darueber hinaus ist keine Handlung
 * eines Menschen mehr, sondern ein Skript - und das soll die Grenze nennen statt sie zu erfahren.
 */
export const MAX_TRASH_SELECTION = 100

export type TrashBoardRequest = {
  readonly boardId: string
}

/**
 * Eine Zeile des Papierkorbs.
 *
 * Bewusst **keine** `BoardView`: die traegt die eigene Rolle aus der Policy, und ein Board im Papierkorb hat
 * fachlich keine mehr. Was hier steht, ist genau das, was die Ansicht zeigt - Titel, urspruenglicher Ordner,
 * loeschende Person, Zeitpunkt und verbleibende Frist.
 */
export type BoardTrashEntryView = {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly ownerUserId: string
  readonly ownerDisplayName: string
  /** Urspruenglicher Ordner; `null` heisst: es lag unmittelbar im Arbeitsbereich. */
  readonly folderId: string | null
  readonly folderName: string | null
  /** `null` heisst: das Konto der loeschenden Person wurde inzwischen entfernt. */
  readonly deletedByUserId: string | null
  readonly deletedByDisplayName: string | null
  /** ISO-8601, Beginn der Aufbewahrungsfrist. */
  readonly deletedAt: string
  /** ISO-8601, Ende der Aufbewahrungsfrist. Die verbleibende Frist ist der Abstand zu jetzt. */
  readonly purgeAt: string
  /** Archivzustand vor dem Loeschen. Er bleibt erhalten und gilt nach dem Wiederherstellen weiter. */
  readonly status: BoardStatusView
}

/**
 * Papierkorb genau eines Arbeitsbereichs.
 *
 * Die Liste ist **serverseitig gefiltert**: sie enthaelt ausschliesslich Boards, die der Anfragende auch
 * wiederherstellen und endgueltig loeschen darf. Wer die Bestandsverantwortung nicht traegt, bekommt eine
 * leere Liste und auf jede Aktion eine Ablehnung.
 */
export type BoardTrashResponse = {
  readonly workspace: WorkspaceView
  /** Absteigend, zuletzt geloeschtes zuerst. */
  readonly boards: readonly BoardTrashEntryView[]
  /** Aufbewahrungsfrist dieser Instanz in Tagen. Der Standard sind 14 Tage. */
  readonly retentionDays: number
}

/** Wiederherstellen und endgueltiges Loeschen nehmen dieselbe Auswahl: ein Board ist die Auswahl mit einem. */
export type TrashSelectionRequest = {
  readonly boardIds: readonly string[]
}

/**
 * Ergebnis je gewaehltem Board.
 *
 * Eine Auswahl ist **kein Alles-oder-nichts**: ein Board, das inzwischen endgueltig entfernt wurde oder das
 * der Anfragende nicht verantwortet, laesst die uebrigen unberuehrt. Die Antwort nennt deshalb je Kennung
 * ein eigenes Ergebnis, und der Gesamtstatus ist immer 200.
 */
export type TrashActionResultView = {
  readonly boardId: string
  readonly ok: boolean
  /** Grund der Ablehnung im Klartext; `null` bei Erfolg. */
  readonly error: string | null
}

export type TrashSelectionResponse = {
  readonly results: readonly TrashActionResultView[]
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
