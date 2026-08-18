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
