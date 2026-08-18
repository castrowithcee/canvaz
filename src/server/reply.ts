/**
 * Gemeinsame Bausteine der geschuetzten Routen.
 *
 * **Die Antwort entsteht in der Transaktion, gesendet wird sie erst danach.** Jeder Transaktionsrumpf gibt
 * eine fertige `Reply` zurueck - Erfolg, Ablehnung und Konflikt gleichermassen. Waere sie schon geschrieben,
 * haette ein scheiternder Commit dem Client bereits einen Erfolg quittiert, den es nicht gibt, und der
 * Fehlerpfad koennte ihn wegen `headersSent` nicht mehr korrigieren.
 *
 * Workspace- und Boardrouten teilen sich diese Stelle, damit die Antwortkonvention nicht zweimal
 * beschrieben und dabei auseinanderlaufen kann.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ErrorResponse } from '../contracts/api.js'
import type { AuthenticatedSession } from '../domain/identity/model.js'
import type { AppContext } from './context.js'
import { requireCsrfToken, requireSession } from './guard.js'
import { readJsonBodyLimited, sendError, sendJson } from './http.js'

/** Fertige, noch nicht gesendete Antwort. */
export type Reply = { readonly status: number; readonly body: unknown }

export function ok(status: number, body: unknown): Reply {
  return { status, body }
}

export function fail(status: number, message: string): Reply {
  const body: ErrorResponse = { error: message }
  return { status, body }
}

export function send(response: ServerResponse, reply: Reply): void {
  sendJson(response, reply.status, reply.body)
}

/** Unterscheidet eine fertige Antwort von einem geladenen Datensatz; nur die Antwort traegt einen Status. */
export function isReply<T extends object>(value: Reply | T): value is Reply {
  return 'status' in value
}

/** Reicht fuer jede Verwaltungsanfrage; die Szene bringt ihre eigene, konfigurierte Grenze mit. */
const DEFAULT_BODY_BYTES = 16_384

export type Guarded = {
  readonly auth: AuthenticatedSession
  readonly body: Record<string, unknown>
}

/**
 * Sitzung, CSRF-Token und JSON-Koerper fuer eine zustandsaendernde Route. `maxBytes` begrenzt den Koerper;
 * die Szenenspeicherung setzt ihn hoeher als die kleinen Verwaltungsaufrufe.
 */
export async function guardMutation(
  context: AppContext,
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes?: number,
): Promise<Guarded | null> {
  const auth = await requireSession(context, request, response)
  if (auth === null || !requireCsrfToken(context, request, response, auth)) {
    return null
  }
  const body = await readJsonBodyLimited(request, maxBytes ?? DEFAULT_BODY_BYTES)
  if (!body.ok) {
    if (body.reason === 'too-large') {
      sendError(response, 413, 'Der Anfragekoerper ist zu gross')
    } else {
      sendError(response, 400, 'Ungueltiger Anfragekoerper')
    }
    return null
  }
  return { auth, body: body.body }
}

/**
 * Postgres lehnt eine erfundene Kennung, die keine UUID ist, mit einem Typfehler ab. Fachlich ist sie
 * schlicht unbekannt - und muss dieselbe Antwort bekommen wie eine gueltig geformte fremde Kennung.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function readUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
}
