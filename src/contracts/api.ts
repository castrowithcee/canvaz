/**
 * Geteilte HTTP-Vertraege zwischen Server und SPA.
 *
 * Beide Seiten importieren dieselben Typen und Pfade, damit eine Umbenennung im Typecheck auffaellt statt
 * zur Laufzeit.
 */

export const API_BASE_PATH = '/api'

export type HealthResponse = {
  readonly status: 'ok'
  readonly database: 'ok'
}

export type ErrorResponse = {
  readonly error: string
}
