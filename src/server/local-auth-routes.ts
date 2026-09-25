/**
 * Lokale Anmeldung, Passwortwechsel und Einloesen einer Einladung.
 *
 * Die drei Endpunkte, die **ohne** Sitzung erreichbar sind und trotzdem eine anlegen. Sie verhalten sich wie
 * der Beitritt eines Gastes und folgen denselben Regeln:
 *
 * - **Kein CSRF-Token**, weil es noch keine Sitzung gibt, an die es gebunden waere - dafuer dieselbe
 *   Herkunftspruefung wie der WebSocket-Upgrade. Eine fremde Herkunft kann damit niemandem unbemerkt eine
 *   Sitzung in den Browser setzen.
 * - **Eine eigene, enge Ratengrenze** zusaetzlich zur allgemeinen: hier wird geraten, nicht gebraucht.
 * - **Keine Auskunft ueber Konten.** Eine falsche Adresse und ein falsches Passwort ergeben dieselbe
 *   Antwort, und beide kosten dieselbe Rechenzeit - auch ohne Konto wird ein Hash geprueft.
 *
 * Ein Passwort und ein Einladungswert erscheinen in keiner Antwort, in keiner Protokollzeile und in keinem
 * Auditereignis; gespeichert wird ausschliesslich ein Hash.
 *
 * ## Der erzwungene Wechsel ist eine Grenze, keine Anzeige
 *
 * Nach einem Initialpasswort oder einer Ruecksetzung antwortet die Anmeldung mit
 * `password-change-required` und legt **keine Sitzung** an. Es gibt damit keinen Zustand, in dem jemand mit
 * einem administrativ vergebenen Passwort arbeiten koennte; der Wechsel ist der einzige Weg weiter, und er
 * verlangt dasselbe Passwort noch einmal.
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { LocalLoginResponse } from '../contracts/api.js'
import { AUTH_INVITATION_REDEEM_PATH, AUTH_LOCAL_LOGIN_PATH, AUTH_LOCAL_PASSWORD_PATH } from '../contracts/api.js'
import { isInvitationRedeemable, normalizeEmail, parsePassword } from '../domain/identity/local-auth.js'
import type { User, UserId } from '../domain/identity/model.js'
import { isUserActive } from '../domain/identity/model.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import type { AppContext } from './context.js'
import type { Route } from './http.js'
import { readJsonBody, sendError, sendJson } from './http.js'
import { hashInvitationToken } from './invitations.js'
import { hashPassword, isSamePassword, verifyPassword } from './password.js'
import { clientKey, createRateLimiter } from './rate-limit.js'
import { setSessionCookie, startSession } from './session.js'

/**
 * Vergleichswert fuer eine Anmeldung ohne Konto.
 *
 * Ohne ihn waere die Antwortzeit die Auskunft, die die Antwort verweigert: eine unbekannte Adresse waere
 * sofort abgelehnt, eine bekannte erst nach der Hashberechnung. Das Geheimnis dahinter ist zufaellig und
 * verlaesst den Prozess nie.
 */
let dummy: Promise<string> | null = null

function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString('base64url'))
  return dummy
}

function readString(body: Record<string, unknown> | null, field: string): string | null {
  const value = body?.[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Konto und Anmeldedaten in einem Schritt; beide werden immer gemeinsam gebraucht. */
async function findLocalAccount(
  store: IdentityStore,
  email: string,
): Promise<{ readonly user: User; readonly passwordHash: string; readonly mustChangePassword: boolean } | null> {
  const user = await store.users.findByEmail(email)
  if (user === null) {
    return null
  }
  const credential = await store.localCredentials.findByUserId(user.id)
  if (credential === null) {
    return null
  }
  return { user, passwordHash: credential.passwordHash, mustChangePassword: credential.mustChangePassword }
}

export function createLocalAuthRoutes(context: AppContext): readonly Route[] {
  const { config, logger } = context
  const allowedOrigin = new URL(config.baseUrl).origin
  const attempts = createRateLimiter({ perMinute: config.authRateLimitPerMinute })

  /**
   * Dieselbe Regel wie beim Beitritt eines Gastes: ein fehlender `Origin` wird angenommen, weil ein Browser
   * ihn bei einem POST immer sendet - eine Anfrage ohne den Header stammt also nicht aus einem Browser.
   */
  function hasAllowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    return origin === undefined || origin === allowedOrigin
  }

  /** Gemeinsamer Vorlauf der drei Endpunkte. `false` heisst: die Anfrage ist bereits beantwortet. */
  function guard(request: IncomingMessage, response: ServerResponse, event: string): boolean {
    if (!hasAllowedOrigin(request)) {
      logger('warn', 'auth.local.foreign-origin', { event })
      sendError(response, 403, 'Fremde Herkunft')
      return false
    }
    if (!attempts.take(clientKey(request, config.trustedProxy))) {
      logger('warn', 'auth.local.rate.exceeded', { event })
      response.setHeader('retry-after', '60')
      sendError(response, 429, 'Zu viele Anmeldeversuche. Bitte spaeter erneut versuchen.')
      return false
    }
    return true
  }

  /**
   * Setzt eine frische Sitzung und widerruft dabei jede bestehende desselben Nutzers.
   *
   * Nach einem Passwortwechsel und nach einer Einloesung ist das keine Bequemlichkeit, sondern der Punkt:
   * wer das alte Passwort kannte, verliert damit auch jede Sitzung, die er sich damit geholt hat.
   */
  async function replaceSessions(store: IdentityStore, userId: UserId, now: Date): Promise<string> {
    await store.sessions.revokeAllForUser(userId, now)
    const { token } = await startSession(store, config, userId, now)
    return token
  }

  return [
    {
      method: 'POST',
      path: AUTH_LOCAL_LOGIN_PATH,
      handle: async ({ request, response }) => {
        if (!guard(request, response, 'login')) {
          return
        }
        const body = await readJsonBody(request)
        const email = normalizeEmail(body?.['email'])
        const password = readString(body, 'password')
        if (email === null || password === null) {
          sendError(response, 400, 'Adresse und Passwort werden erwartet')
          return
        }
        const account = await findLocalAccount(context.identity, email)
        // Auch ohne Konto wird geprueft: die Antwortzeit soll nichts verraten.
        const valid = await verifyPassword(password, account?.passwordHash ?? (await dummyPasswordHash()))
        if (account === null || !valid) {
          logger('warn', 'auth.local.login.failed', { userId: account?.user.id ?? null })
          sendError(response, 401, 'Adresse oder Passwort stimmt nicht')
          return
        }
        if (!isUserActive(account.user)) {
          logger('warn', 'auth.local.login.denied', { userId: account.user.id, reason: 'user-deactivated' })
          sendError(response, 403, 'Dieses Konto ist deaktiviert. Bitte an die Systemadministration wenden.')
          return
        }
        if (account.mustChangePassword) {
          // Ausdruecklich ohne Sitzung: der Wechsel geht ihr voraus.
          logger('info', 'auth.local.login.change-required', { userId: account.user.id })
          const pending: LocalLoginResponse = { status: 'password-change-required' }
          sendJson(response, 200, pending)
          return
        }
        const now = context.now()
        const { token } = await startSession(context.identity, config, account.user.id, now)
        setSessionCookie(response, config, token)
        logger('info', 'auth.login.succeeded', { userId: account.user.id, method: 'local' })
        const ok: LocalLoginResponse = { status: 'ok' }
        sendJson(response, 200, ok)
      },
    },

    {
      method: 'POST',
      path: AUTH_LOCAL_PASSWORD_PATH,
      handle: async ({ request, response }) => {
        if (!guard(request, response, 'password-change')) {
          return
        }
        const body = await readJsonBody(request)
        const email = normalizeEmail(body?.['email'])
        const currentPassword = readString(body, 'currentPassword')
        if (email === null || currentPassword === null) {
          sendError(response, 400, 'Adresse und bisheriges Passwort werden erwartet')
          return
        }
        const checked = parsePassword(body?.['newPassword'])
        if (!checked.ok) {
          sendError(response, 400, checked.problem)
          return
        }
        const newPassword = checked.password
        // Verglichen wird so, wie das Verfahren vergleicht: ein NFKC-gleiches Passwort ergibt denselben
        // Hash und waere sonst ein Wechsel, der den erzwungenen Wechsel aufhebt, ohne etwas zu aendern.
        if (isSamePassword(newPassword, currentPassword)) {
          sendError(response, 400, 'Das neue Passwort muss sich vom bisherigen unterscheiden')
          return
        }
        const account = await findLocalAccount(context.identity, email)
        const valid = await verifyPassword(currentPassword, account?.passwordHash ?? (await dummyPasswordHash()))
        if (account === null || !valid) {
          logger('warn', 'auth.local.password.failed', { userId: account?.user.id ?? null })
          sendError(response, 401, 'Adresse oder Passwort stimmt nicht')
          return
        }
        if (!isUserActive(account.user)) {
          logger('warn', 'auth.local.password.denied', { userId: account.user.id, reason: 'user-deactivated' })
          sendError(response, 403, 'Dieses Konto ist deaktiviert. Bitte an die Systemadministration wenden.')
          return
        }
        const passwordHash = await hashPassword(newPassword)
        const now = context.now()
        const token = await context.identity.transaction(async (store) => {
          await store.localCredentials.set(account.user.id, passwordHash, { mustChangePassword: false })
          return replaceSessions(store, account.user.id, now)
        })
        // Die widerrufenen Sitzungen nehmen ihre offenen Verbindungen mit.
        context.realtime.closeUser(account.user.id)
        setSessionCookie(response, config, token)
        logger('info', 'auth.local.password.changed', { userId: account.user.id })
        const ok: LocalLoginResponse = { status: 'ok' }
        sendJson(response, 200, ok)
      },
    },

    {
      method: 'POST',
      path: AUTH_INVITATION_REDEEM_PATH,
      handle: async ({ request, response }) => {
        if (!guard(request, response, 'invitation-redeem')) {
          return
        }
        const body = await readJsonBody(request)
        const token = readString(body, 'token')
        if (token === null) {
          sendError(response, 400, 'Der Einladungslink ist unvollstaendig')
          return
        }
        const checked = parsePassword(body?.['password'])
        if (!checked.ok) {
          sendError(response, 400, checked.problem)
          return
        }
        // Vor der Transaktion: die Hashberechnung dauert und hat in einer offenen Sperre nichts zu suchen.
        const passwordHash = await hashPassword(checked.password)
        const now = context.now()
        const outcome = await context.identity.transaction(async (store) => {
          const invitation = await store.invitations.findByTokenHash(hashInvitationToken(token))
          if (invitation === null || !isInvitationRedeemable(invitation, now)) {
            return { kind: 'invalid' } as const
          }
          const user = await store.users.findById(invitation.userId)
          if (user === null || !isUserActive(user)) {
            return { kind: 'deactivated' } as const
          }
          // Einmalverwendung: gewinnt ein gleichzeitiger Vorgang das Rennen, aendert dieser nichts.
          if (!(await store.invitations.markRedeemed(invitation.id, now))) {
            return { kind: 'invalid' } as const
          }
          await store.localCredentials.set(user.id, passwordHash, { mustChangePassword: false })
          const sessionToken = await replaceSessions(store, user.id, now)
          return { kind: 'ok', userId: user.id, purpose: invitation.purpose, token: sessionToken } as const
        })
        if (outcome.kind === 'invalid') {
          logger('warn', 'auth.invitation.rejected', { reason: 'not-redeemable' })
          sendError(response, 400, 'Dieser Link ist ungueltig, abgelaufen oder bereits verbraucht.')
          return
        }
        if (outcome.kind === 'deactivated') {
          logger('warn', 'auth.invitation.rejected', { reason: 'user-deactivated' })
          sendError(response, 403, 'Dieses Konto ist deaktiviert. Bitte an die Systemadministration wenden.')
          return
        }
        context.realtime.closeUser(outcome.userId)
        setSessionCookie(response, config, outcome.token)
        // Der Zweck unterscheidet im Protokoll eine Wiederherstellung per Betreiberbefehl von einer Einladung.
        logger('info', 'auth.invitation.redeemed', { userId: outcome.userId, purpose: outcome.purpose })
        const ok: LocalLoginResponse = { status: 'ok' }
        sendJson(response, 200, ok)
      },
    },
  ]
}
