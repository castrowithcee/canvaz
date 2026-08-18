/**
 * Geteilte HTTP-Vertraege zwischen Server und SPA.
 *
 * Beide Seiten importieren dieselben Typen und Pfade, damit eine Umbenennung im Typecheck auffaellt statt
 * zur Laufzeit.
 */

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
