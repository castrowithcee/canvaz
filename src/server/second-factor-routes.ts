/**
 * Zweiter Faktor des Systemadmins: Einrichtung, Abfrage und neue Ersatzcodes.
 *
 * Jede Anmeldung - lokal, ueber OIDC, nach Passwortwechsel oder Einloesung - legt eine Sitzung **ohne**
 * Nachweis an (`startSession`). Fuer den Systemadmin ist sie damit eingeschraenkt: die Guards lehnen jeden
 * weiteren Endpunkt und jeden WebSocket-Upgrade ab (`guard.ts`, `realtime.ts`). Diese Endpunkte sind die
 * einzigen, die eine solche Sitzung ausser Profil und Abmeldung bedienen.
 *
 * ## Der Nachweis entsteht an einer neuen Sitzung
 *
 * Ein gueltiger Code setzt den Nachweis nicht an die bestehende Sitzung, sondern ersetzt sie durch eine
 * neue mit Nachweis (neues Cookie, neues CSRF-Token). Ein Sitzungswert aus der Zeit vor dem zweiten Faktor
 * erhaelt so nie Rechte.
 *
 * ## Eine Faktoraenderung verlangt eine frische Bestaetigung
 *
 * Neu einrichten und neue Ersatzcodes verlangen einen aktuellen Code (TOTP oder Ersatzcode) aus einer
 * Sitzung mit Nachweis. Beides widerruft **alle** Sitzungen des Kontos und setzt eine neue; der Inhaber
 * bekommt eine Mitteilung, soweit ein Postausgang eingerichtet ist. Entfernen kann den Faktor allein die
 * Einloesung einer Betreiber-Wiederherstellung (`local-auth-routes.ts`) - einen oeffentlichen oder per Mail
 * ausloesbaren Weg gibt es nicht.
 *
 * ## Drosselung und Wiederholung
 *
 * Jede Codepruefung bucht vorher einen Versuch auf das Konto (`takeSecondFactorAttempt`, dieselbe
 * Datenbankgrenze wie die Anmeldung, eigener Zaehler). Ein TOTP-Code gilt fuer genau einen Zeitschritt und
 * wird danach abgelehnt; ein Ersatzcode genau einmal. Beides entscheidet die Datenbank atomar.
 *
 * Kein Geheimnis, kein Code und kein Ersatzcode erscheint in einem Protokoll oder einer Mail.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  SecondFactorBackupCodesResponse,
  SecondFactorEnrollResponse,
  SecondFactorVerifyResponse,
} from '../contracts/api.js'
import {
  AUTH_SECOND_FACTOR_BACKUP_CODES_PATH,
  AUTH_SECOND_FACTOR_CONFIRM_PATH,
  AUTH_SECOND_FACTOR_ENROLL_PATH,
  AUTH_SECOND_FACTOR_VERIFY_PATH,
} from '../contracts/api.js'
import type { SignedInSession, User, UserId } from '../domain/identity/model.js'
import { requiresSecondFactor } from '../domain/identity/model.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import { hasActiveTotp, isEnrollmentOpen } from '../domain/identity/second-factor.js'
import type { AppContext } from './context.js'
import { requireCsrfToken, requireSignedIn } from './guard.js'
import type { Route } from './http.js'
import { readJsonBody, sendError, sendJson } from './http.js'
import { clearSecondFactorAttempts, takeSecondFactorAttempt } from './login-throttle.js'
import type { SecondFactorChange } from './mailer.js'
import { deliver, secondFactorChangedMail } from './mailer.js'
import { asRequester } from './requester.js'
import type { SecondFactorInput } from './second-factor.js'
import {
  createBackupCodes,
  createTotpSecret,
  hashBackupCode,
  hashIssuedBackupCodes,
  matchTotpCode,
  openSecret,
  parseSecondFactorInput,
  sealSecret,
  totpUri,
} from './second-factor.js'
import { setSessionCookie, startSession } from './session.js'

/** Eine Antwort fuer falsch, bereits verwendet und unbekannt: die Unterscheidung hilft nur einem Rater. */
const CODE_REJECTED = 'Der Code stimmt nicht oder wurde bereits verwendet.'
const CODE_EXPECTED = 'Bitte den sechsstelligen Code aus der App oder einen Ersatzcode eingeben.'
const TOTP_EXPECTED = 'Bitte den sechsstelligen Code aus der App eingeben.'
const UNREADABLE =
  'Der zweite Faktor laesst sich gerade nicht pruefen. Bitte den Betrieb der Instanz verstaendigen.'

type CheckOutcome = 'ok' | 'invalid' | 'unreadable'

export function createSecondFactorRoutes(context: AppContext): readonly Route[] {
  const { config, logger } = context
  const key = config.mfaEncryptionKey

  /**
   * Gemeinsamer Vorlauf: Sitzung nach dem ersten Faktor, CSRF-Token und Faktorpflicht. Ein Konto ohne
   * Pflicht hat hier nichts zu tun - es gibt fuer andere Rollen bewusst keinen zweiten Faktor.
   */
  async function requireAdminSession(request: IncomingMessage, response: ServerResponse): Promise<SignedInSession | null> {
    const auth = await requireSignedIn(context, request, response)
    if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
      return null
    }
    if (!requiresSecondFactor(auth.user)) {
      logger('warn', 'authorization.denied', { userId: auth.user.id, required: 'system-admin' })
      sendError(response, 403, 'Keine Berechtigung')
      return null
    }
    return auth
  }

  /** Bucht einen Versuch. `false` heisst: gedrosselt, die Anfrage ist beantwortet. */
  async function takeAttempt(userId: UserId, response: ServerResponse, now: Date): Promise<boolean> {
    if (await takeSecondFactorAttempt(context.identity, config, userId, now)) {
      return true
    }
    logger('warn', 'auth.second-factor.throttled', { userId })
    response.setHeader('retry-after', String(config.authAccountWindowMinutes * 60))
    sendError(response, 429, 'Zu viele Versuche. Bitte spaeter erneut versuchen.')
    return false
  }

  /** Prueft eine Eingabe gegen den aktiven Faktor und verbraucht Zeitschritt oder Ersatzcode. */
  async function checkActiveFactor(userId: UserId, input: SecondFactorInput, now: Date): Promise<CheckOutcome> {
    if (input.kind === 'backup-code') {
      const used = await context.identity.secondFactors.useBackupCode(userId, hashBackupCode(key, input.normalized), now)
      return used ? 'ok' : 'invalid'
    }
    const factor = await context.identity.secondFactors.findTotp(userId)
    if (!hasActiveTotp(factor)) {
      return 'invalid'
    }
    const secret = openSecret(key, userId, factor.secretSealed)
    if (secret === null) {
      return 'unreadable'
    }
    const step = matchTotpCode(secret, input.code, now)
    if (step === null) {
      return 'invalid'
    }
    return (await context.identity.secondFactors.useTotpStep(userId, step)) ? 'ok' : 'invalid'
  }

  /**
   * Die frische Bestaetigung: Code lesen, Versuch buchen, pruefen. `true` heisst: bestaetigt; sonst ist die
   * Anfrage bereits beantwortet.
   */
  async function confirmWithCurrentFactor(userId: UserId, raw: unknown, response: ServerResponse, now: Date): Promise<boolean> {
    const input = parseSecondFactorInput(raw)
    if (input === null) {
      sendError(response, 400, CODE_EXPECTED)
      return false
    }
    if (!(await takeAttempt(userId, response, now))) {
      return false
    }
    const outcome = await checkActiveFactor(userId, input, now)
    if (outcome === 'unreadable') {
      logger('error', 'auth.second-factor.unreadable', { userId })
      sendError(response, 500, UNREADABLE)
      return false
    }
    if (outcome === 'invalid') {
      logger('warn', 'auth.second-factor.failed', { userId, method: input.kind })
      sendError(response, 400, CODE_REJECTED)
      return false
    }
    await clearSecondFactorAttempts(context.identity, config.sessionSecret, userId)
    logger('info', 'auth.second-factor.verified', { userId, method: input.kind })
    return true
  }

  /** Alle Sitzungen des Kontos enden, eine neue mit Nachweis beginnt. Nur innerhalb einer Transaktion. */
  async function replaceAllSessions(store: IdentityStore, userId: UserId, now: Date): Promise<string> {
    await store.sessions.revokeAllForUser(userId, now)
    const { token } = await startSession(store, config, userId, now, { secondFactorVerifiedAt: now })
    return token
  }

  /** Nachlauf jeder Faktoraenderung: Verbindungen schliessen, Cookie setzen, Inhaber benachrichtigen. */
  async function finishChange(user: User, token: string, change: SecondFactorChange, response: ServerResponse): Promise<void> {
    context.realtime.closeUser(user.id)
    setSessionCookie(response, config, token)
    logger('info', 'auth.second-factor.changed', { userId: user.id, change })
    if (user.email !== null) {
      await deliver(
        context.mailer,
        logger,
        'second-factor-changed',
        secondFactorChangedMail(user.email, user.displayName, change, config.baseUrl),
      )
    }
  }

  return [
    {
      method: 'POST',
      path: AUTH_SECOND_FACTOR_ENROLL_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireAdminSession(request, response)
        if (auth === null) {
          return
        }
        const body = await readJsonBody(request)
        const now = context.now()
        const userId = auth.user.id
        const replacing = hasActiveTotp(await context.identity.secondFactors.findTotp(userId))
        if (replacing) {
          // Wer schon einen Faktor hat, wechselt ihn nur aus einer Sitzung mit Nachweis und mit einem
          // aktuellen Code - nie aus einer Sitzung, die nur das Passwort kennt.
          if (auth.secondFactorPending) {
            sendError(response, 403, 'Bitte zuerst mit dem vorhandenen zweiten Faktor anmelden.')
            return
          }
          if (!(await confirmWithCurrentFactor(userId, body?.['code'], response, now))) {
            return
          }
        }
        const secret = createTotpSecret()
        await context.identity.secondFactors.beginTotp(userId, sealSecret(key, userId, secret), now)
        logger('info', 'auth.second-factor.enrollment.started', { userId, replacing })
        const result: SecondFactorEnrollResponse = {
          secret,
          otpauthUri: totpUri(secret, auth.user.email ?? auth.user.displayName),
        }
        sendJson(response, 200, result)
      },
    },

    {
      method: 'POST',
      path: AUTH_SECOND_FACTOR_CONFIRM_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireAdminSession(request, response)
        if (auth === null) {
          return
        }
        const now = context.now()
        const userId = auth.user.id
        const factor = await context.identity.secondFactors.findTotp(userId)
        if (!isEnrollmentOpen(factor, now)) {
          sendError(response, 409, 'Keine offene Einrichtung. Bitte die Einrichtung neu beginnen.')
          return
        }
        // Eine offene Einrichtung neben einem aktiven Faktor stammt aus einer Sitzung mit Nachweis; eine
        // Sitzung ohne ihn schliesst sie nicht ab.
        if (hasActiveTotp(factor) && auth.secondFactorPending) {
          sendError(response, 403, 'Bitte zuerst mit dem vorhandenen zweiten Faktor anmelden.')
          return
        }
        const input = parseSecondFactorInput((await readJsonBody(request))?.['code'])
        if (input?.kind !== 'totp') {
          sendError(response, 400, TOTP_EXPECTED)
          return
        }
        if (!(await takeAttempt(userId, response, now))) {
          return
        }
        const secret = openSecret(key, userId, factor.pendingSealed)
        if (secret === null) {
          logger('error', 'auth.second-factor.unreadable', { userId })
          sendError(response, 500, UNREADABLE)
          return
        }
        const step = matchTotpCode(secret, input.code, now)
        if (step === null) {
          logger('warn', 'auth.second-factor.failed', { userId, method: 'enrollment' })
          sendError(response, 400, CODE_REJECTED)
          return
        }
        const backupCodes = createBackupCodes()
        const token = await context.identity.transaction(async (store) => {
          // Einmalig: eine inzwischen ersetzte oder gleichzeitig bestaetigte Einrichtung aendert nichts.
          if (!(await store.secondFactors.activateTotp(userId, factor.pendingSealed, step, now))) {
            return null
          }
          await store.secondFactors.replaceBackupCodes(userId, hashIssuedBackupCodes(key, backupCodes))
          return replaceAllSessions(store, userId, now)
        })
        if (token === null) {
          sendError(response, 409, 'Die Einrichtung wurde inzwischen ersetzt. Bitte neu beginnen.')
          return
        }
        await clearSecondFactorAttempts(context.identity, config.sessionSecret, userId)
        await finishChange(auth.user, token, 'enrolled', response)
        const result: SecondFactorBackupCodesResponse = { backupCodes }
        sendJson(response, 200, result)
      },
    },

    {
      method: 'POST',
      path: AUTH_SECOND_FACTOR_VERIFY_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireAdminSession(request, response)
        if (auth === null) {
          return
        }
        if (!auth.secondFactorPending) {
          sendError(response, 409, 'Diese Sitzung hat den zweiten Faktor bereits bestaetigt.')
          return
        }
        const userId = auth.user.id
        if (!hasActiveTotp(await context.identity.secondFactors.findTotp(userId))) {
          sendError(response, 409, 'Fuer dieses Konto ist noch kein zweiter Faktor eingerichtet.')
          return
        }
        const now = context.now()
        if (!(await confirmWithCurrentFactor(userId, (await readJsonBody(request))?.['code'], response, now))) {
          return
        }
        // Nur diese Sitzung wird ersetzt: andere Geraete mit Nachweis bleiben angemeldet.
        const token = await context.identity.transaction(async (store) => {
          await store.sessions.revoke(auth.session.id, now)
          const { token: next } = await startSession(store, config, userId, now, { secondFactorVerifiedAt: now })
          return next
        })
        context.realtime.closeSession(auth.session.id)
        setSessionCookie(response, config, token)
        const result: SecondFactorVerifyResponse = {
          backupCodesRemaining: await context.identity.secondFactors.countUnusedBackupCodes(userId),
        }
        sendJson(response, 200, result)
      },
    },

    {
      method: 'POST',
      path: AUTH_SECOND_FACTOR_BACKUP_CODES_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireAdminSession(request, response)
        if (auth === null) {
          return
        }
        if (auth.secondFactorPending) {
          sendError(response, 403, 'Bitte zuerst mit dem zweiten Faktor anmelden.')
          return
        }
        const userId = auth.user.id
        if (!hasActiveTotp(await context.identity.secondFactors.findTotp(userId))) {
          sendError(response, 409, 'Fuer dieses Konto ist noch kein zweiter Faktor eingerichtet.')
          return
        }
        const now = context.now()
        if (!(await confirmWithCurrentFactor(userId, (await readJsonBody(request))?.['code'], response, now))) {
          return
        }
        const backupCodes = createBackupCodes()
        const token = await context.identity.transaction(async (store) => {
          await store.secondFactors.replaceBackupCodes(userId, hashIssuedBackupCodes(key, backupCodes))
          return replaceAllSessions(store, userId, now)
        })
        await finishChange(auth.user, token, 'backup-codes', response)
        const result: SecondFactorBackupCodesResponse = { backupCodes }
        sendJson(response, 200, result)
      },
    },
  ]
}
