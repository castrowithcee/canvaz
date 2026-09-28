/**
 * Selbstwiederherstellung eines lokalen Passworts ueber eine bestaetigte Wiederherstellungsadresse.
 *
 * Nur mit Postausgang: ohne ihn gibt es die Endpunkte der Sache nach nicht (`404`), und `/api/auth/methods`
 * sagt der Anmeldeseite, dass sie den Weg nicht anbieten soll. Wer darf, entscheidet die Domain
 * (`selfResetTarget`): freigeschaltet durch den Systemadmin, aktiv, mit lokalem Passwort, ohne
 * Systemadminrolle und mit bestaetigter Adresse. Der Systemadmin bekommt nie einen Link.
 *
 * ## Die Anfrage verraet nichts
 *
 * `POST .../password-reset/request` antwortet **vor** jeder kontoabhaengigen Arbeit, immer gleich (`202`)
 * und ohne auf Datenbank oder Postausgang zu warten. Drosselung, Kontosuche, Link und Versand laufen danach
 * im Hintergrund. Die Antwortzeit haengt damit nur an Herkunftspruefung, Ratengrenze und Eingabeformat -
 * alles unabhaengig davon, ob es das Konto gibt, ob es freigeschaltet ist oder ob gleich eine Mail rausgeht.
 * Was geschah, steht nur im Protokoll (`auth.password-reset.issued|skipped|throttled`, `mail.failed`), mit
 * Nutzerkennung und nie mit Adresse oder Link.
 *
 * ## Keine Flut, keine Aussperrung
 *
 * - Je Client die enge Grenze der Anmeldestrecken, je eingegebener Adresse ein eigener Zaehler
 *   (`takePasswordResetAttempt`) mit dem Budget der Anmeldung.
 * - Je Konto hoechstens **ein** offener Ruecksetzungslink: solange einer gilt (15 Minuten), geht keine
 *   weitere Mail. Die Pruefung laeuft unter einer Zeilensperre des Kontos; zwei gleichzeitige Anfragen
 *   ergeben nie zwei Links.
 * - Eine Anfrage aendert weder Passwort noch Sitzung und zaehlt nicht auf das Anmeldebudget.
 *
 * ## Die Einloesung meldet nicht an
 *
 * Ein Ruecksetzungslink setzt genau ein neues Passwort nach der Passwortregel - einmal, auch gleichzeitig
 * eingeloest (Zeilensperre und bedingtes Update wie bei der Einladung). Sie widerruft jede Sitzung, jeden
 * offenen Link und jede offene Einladung des Kontos, schliesst dessen Verbindungen und hebt die
 * Anmeldedrosselung auf. Eine Sitzung entsteht nicht; der Inhaber meldet sich danach mit dem neuen Passwort
 * an. Rolle, Status, Mitgliedschaften und Kontoidentitaet bleiben, wie sie sind.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { PasswordResetRequestResponse, SelfRecoveryResultResponse, SelfRecoveryView } from '../contracts/api.js'
import {
  AUTH_PASSWORD_RESET_REDEEM_PATH,
  AUTH_PASSWORD_RESET_REQUEST_PATH,
  AUTH_RECOVERY_EMAIL_CONFIRM_PATH,
  ME_RECOVERY_EMAIL_PATH,
} from '../contracts/api.js'
import { isInvitationRedeemable, normalizeEmail, parsePassword } from '../domain/identity/local-auth.js'
import type { User } from '../domain/identity/model.js'
import {
  passwordResetExpiry,
  recoveryEmailConfirmExpiry,
  selfRecoveryAllowable,
  selfResetTarget,
} from '../domain/identity/self-recovery.js'
import { resolveClientAddress } from './client-address.js'
import type { AppContext } from './context.js'
import { requireCsrfToken, requireSession } from './guard.js'
import type { Route } from './http.js'
import { readJsonBody, sendError, sendJson } from './http.js'
import {
  createInvitationToken,
  hashInvitationToken,
  passwordResetUrl,
  recoveryEmailConfirmUrl,
} from './invitations.js'
import { describeError } from './log.js'
import {
  clearLoginAttempts,
  takeLoginAttempt,
  takePasswordResetAttempt,
  takeRecoveryEmailAttempt,
} from './login-throttle.js'
import { deliver, recoveryEmailConfirmMail, selfResetDoneMail, selfResetLinkMail } from './mailer.js'
import { hashPassword, verifyPassword } from './password.js'
import { asRequester } from './requester.js'

/**
 * Herkunftspruefung, Ratengrenze und Absenderabwehr (#35) der unangemeldeten Anmeldestrecken
 * (`local-auth-routes.ts`).
 */
export type AuthGuard = (request: IncomingMessage, response: ServerResponse, event: string) => Promise<boolean>

const UNAVAILABLE = 'Diese Instanz bietet keine Ruecksetzung per Mail an. Bitte an die Administration wenden.'
const LINK_INVALID = 'Dieser Link ist ungueltig, abgelaufen oder bereits verbraucht.'

function readString(body: Record<string, unknown> | null, field: string): string | null {
  const value = body?.[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Stand der Selbstwiederherstellung fuer das eigene Profil. `null`, wo es den Weg fuer dieses Konto nicht
 * gibt - auch ohne Postausgang, denn ohne ihn liesse sich keine Adresse bestaetigen.
 */
export async function selfRecoveryViewOf(context: AppContext, user: User): Promise<SelfRecoveryView | null> {
  if (context.mailer === null || user.isSystemAdmin || user.email === null) {
    return null
  }
  const [credential, recovery] = await Promise.all([
    context.identity.localCredentials.findByUserId(user.id),
    context.identity.selfRecovery.find(user.id),
  ])
  if (selfRecoveryAllowable(user, credential !== null) !== 'ok' || recovery?.allowed !== true) {
    return null
  }
  const pending = await context.identity.selfRecovery.findOpenToken(user.id, 'confirm', context.now())
  return { email: recovery.email, pendingEmail: pending?.email ?? null }
}

export function createSelfRecoveryRoutes(context: AppContext, guard: AuthGuard): readonly Route[] {
  const { config, logger } = context

  /**
   * Die kontoabhaengige Haelfte der Anfrage. Laeuft nach der Antwort; ihr Ergebnis steht nur im Protokoll.
   */
  async function issueReset(email: string): Promise<void> {
    const now = context.now()
    if (!(await takePasswordResetAttempt(context.identity, config, email, now))) {
      logger('warn', 'auth.password-reset.throttled', {})
      return
    }
    const user = await context.identity.users.findByEmail(email)
    const credential = user === null ? null : await context.identity.localCredentials.findByUserId(user.id)
    const outcome = await context.identity.transaction(async (store) => {
      const recovery = user === null ? null : await store.selfRecovery.findForUpdate(user.id)
      const target = selfResetTarget(user, credential !== null, recovery)
      if (!target.ok || user === null) {
        return { kind: 'skipped', reason: target.ok ? 'unknown-account' : target.reason } as const
      }
      if ((await store.selfRecovery.findOpenToken(user.id, 'reset', now)) !== null) {
        return { kind: 'skipped', reason: 'link-open' } as const
      }
      const token = createInvitationToken()
      await store.selfRecovery.createToken({
        userId: user.id,
        purpose: 'reset',
        email: target.email,
        tokenHash: hashInvitationToken(token),
        expiresAt: passwordResetExpiry(now),
      })
      return { kind: 'issued', user, to: target.email, token } as const
    })
    if (outcome.kind === 'skipped') {
      logger('info', 'auth.password-reset.skipped', { userId: user?.id ?? null, reason: outcome.reason })
      return
    }
    logger('info', 'auth.password-reset.issued', { userId: outcome.user.id })
    await deliver(
      context.mailer,
      logger,
      'password-reset-link',
      selfResetLinkMail(outcome.to, outcome.user.displayName, passwordResetUrl(config.baseUrl, outcome.token)),
    )
  }

  return [
    {
      method: 'POST',
      path: AUTH_PASSWORD_RESET_REQUEST_PATH,
      handle: async ({ request, response }) => {
        if (!(await guard(request, response, 'password-reset-request'))) {
          return
        }
        if (context.mailer === null) {
          sendError(response, 404, UNAVAILABLE)
          return
        }
        const email = normalizeEmail((await readJsonBody(request))?.['email'])
        if (email === null) {
          sendError(response, 400, 'Eine gueltige E-Mail-Adresse wird erwartet')
          return
        }
        const accepted: PasswordResetRequestResponse = { status: 'accepted' }
        sendJson(response, 202, accepted)
        // Jede Anfrage zaehlt (#35) - unabhaengig davon, ob es das Konto gibt. Wie die kontoabhaengige Arbeit
        // laeuft das nach der Antwort, damit niemand an der Antwortzeit misst, was hier geschieht.
        const clientAddress = resolveClientAddress(request, config.trustedProxy)
        void context.senderDefense.recordFailure(context, clientAddress).catch((error: unknown) => {
          logger('error', 'auth.password-reset.failed', { error: describeError(error) })
        })
        void issueReset(email).catch((error: unknown) => {
          logger('error', 'auth.password-reset.failed', { error: describeError(error) })
        })
      },
    },

    {
      method: 'POST',
      path: AUTH_PASSWORD_RESET_REDEEM_PATH,
      handle: async ({ request, response }) => {
        if (!(await guard(request, response, 'password-reset-redeem'))) {
          return
        }
        const body = await readJsonBody(request)
        const token = readString(body, 'token')
        if (token === null) {
          sendError(response, 400, 'Der Link ist unvollstaendig')
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
          const link = await store.selfRecovery.findTokenByHash(hashInvitationToken(token))
          if (link === null || link.purpose !== 'reset' || !isInvitationRedeemable(link, now)) {
            return { kind: 'invalid' } as const
          }
          const user = await store.users.findById(link.userId)
          const credential = user === null ? null : await store.localCredentials.findByUserId(user.id)
          const recovery = user === null ? null : await store.selfRecovery.findForUpdate(user.id)
          // Dieselbe Regel wie bei der Anfrage, jetzt noch einmal: eine inzwischen entzogene Freischaltung,
          // eine Deaktivierung oder eine neu bestaetigte Adresse entwerten den Link.
          const target = selfResetTarget(user, credential !== null, recovery)
          if (user === null || !target.ok || target.email !== link.email) {
            return { kind: 'invalid' } as const
          }
          // Vor dem Einloesen: ein Passwort aus Name oder Adresse verbraucht den Link nicht.
          const personal = parsePassword(checked.password, user)
          if (!personal.ok) {
            return { kind: 'weak', problem: personal.problem } as const
          }
          if (!(await store.selfRecovery.markTokenRedeemed(link.id, now))) {
            return { kind: 'invalid' } as const
          }
          await store.localCredentials.set(user.id, passwordHash, { mustChangePassword: false })
          await store.sessions.revokeAllForUser(user.id, now)
          await store.selfRecovery.revokeOpenTokens(user.id, now)
          // Eine offene Einladung waere ein zweiter Weg auf dasselbe Konto.
          await store.invitations.revokeOpenForUser(user.id, now)
          await clearLoginAttempts(store, config.sessionSecret, user.email)
          return { kind: 'ok', user, to: target.email } as const
        })
        if (outcome.kind === 'weak') {
          sendError(response, 400, outcome.problem)
          return
        }
        if (outcome.kind === 'invalid') {
          logger('warn', 'auth.password-reset.rejected', { reason: 'not-redeemable' })
          await context.senderDefense.recordFailure(context, resolveClientAddress(request, config.trustedProxy))
          sendError(response, 400, LINK_INVALID)
          return
        }
        context.realtime.closeUser(outcome.user.id)
        logger('info', 'auth.password-reset.redeemed', { userId: outcome.user.id })
        await deliver(
          context.mailer,
          logger,
          'password-reset-done',
          selfResetDoneMail(outcome.to, outcome.user.displayName, config.baseUrl),
        )
        const done: SelfRecoveryResultResponse = { status: 'ok' }
        sendJson(response, 200, done)
      },
    },

    {
      method: 'POST',
      path: AUTH_RECOVERY_EMAIL_CONFIRM_PATH,
      handle: async ({ request, response }) => {
        if (!(await guard(request, response, 'recovery-email-confirm'))) {
          return
        }
        const token = readString(await readJsonBody(request), 'token')
        if (token === null) {
          sendError(response, 400, 'Der Link ist unvollstaendig')
          return
        }
        const now = context.now()
        const outcome = await context.identity.transaction(async (store) => {
          const link = await store.selfRecovery.findTokenByHash(hashInvitationToken(token))
          if (link === null || link.purpose !== 'confirm' || !isInvitationRedeemable(link, now)) {
            return null
          }
          const user = await store.users.findById(link.userId)
          const credential = user === null ? null : await store.localCredentials.findByUserId(user.id)
          const recovery = user === null ? null : await store.selfRecovery.findForUpdate(user.id)
          if (user === null || selfRecoveryAllowable(user, credential !== null) !== 'ok' || recovery?.allowed !== true) {
            return null
          }
          if (!(await store.selfRecovery.markTokenRedeemed(link.id, now))) {
            return null
          }
          await store.selfRecovery.setVerifiedEmail(user.id, link.email, now)
          // Links an die bisherige Adresse und weitere offene Bestaetigungen gelten nicht mehr.
          await store.selfRecovery.revokeOpenTokens(user.id, now)
          return user.id
        })
        if (outcome === null) {
          logger('warn', 'auth.recovery-email.rejected', { reason: 'not-redeemable' })
          await context.senderDefense.recordFailure(context, resolveClientAddress(request, config.trustedProxy))
          sendError(response, 400, LINK_INVALID)
          return
        }
        logger('info', 'auth.recovery-email.verified', { userId: outcome })
        const done: SelfRecoveryResultResponse = { status: 'ok' }
        sendJson(response, 200, done)
      },
    },

    /**
     * Wiederherstellungsadresse setzen oder aendern.
     *
     * Verlangt neben Sitzung und CSRF-Token das aktuelle Passwort: eine liegen gelassene Sitzung allein darf
     * den Rueckweg auf ein Konto nicht umlenken. Die neue Adresse gilt erst nach ihrer Bestaetigung; bis
     * dahin bleibt die bisherige bestaetigte Adresse der Weg.
     */
    {
      method: 'POST',
      path: ME_RECOVERY_EMAIL_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        if (context.mailer === null) {
          sendError(response, 404, UNAVAILABLE)
          return
        }
        const { user } = auth
        const [credential, recovery] = await Promise.all([
          context.identity.localCredentials.findByUserId(user.id),
          context.identity.selfRecovery.find(user.id),
        ])
        if (
          user.email === null ||
          credential === null ||
          selfRecoveryAllowable(user, true) !== 'ok' ||
          recovery?.allowed !== true
        ) {
          sendError(response, 403, 'Die Ruecksetzung per Mail ist fuer dieses Konto nicht freigeschaltet.')
          return
        }
        const body = await readJsonBody(request)
        const currentPassword = readString(body, 'currentPassword')
        const email = normalizeEmail(body?.['email'])
        if (currentPassword === null || email === null) {
          sendError(response, 400, 'Aktuelles Passwort und gueltige E-Mail-Adresse werden erwartet')
          return
        }
        const now = context.now()
        // Auf das Anmeldebudget, denn hier wird ein Passwort geprueft.
        const allowed = await takeLoginAttempt(context.identity, config, user.email, now)
        const valid = await verifyPassword(currentPassword, credential.passwordHash)
        if (!allowed || !valid) {
          logger('warn', 'auth.recovery-email.password-rejected', { userId: user.id, throttled: !allowed })
          sendError(response, 403, 'Das Passwort stimmt nicht, oder es gab zu viele Versuche.')
          return
        }
        await clearLoginAttempts(context.identity, config.sessionSecret, user.email)
        if (!(await takeRecoveryEmailAttempt(context.identity, config, user.id, now))) {
          logger('warn', 'auth.recovery-email.throttled', { userId: user.id })
          response.setHeader('retry-after', '60')
          sendError(response, 429, 'Zu viele Bestaetigungslinks. Bitte spaeter erneut versuchen.')
          return
        }
        const token = createInvitationToken()
        await context.identity.transaction(async (store) => {
          // Nur die zuletzt eingetragene Adresse kann bestaetigt werden.
          await store.selfRecovery.revokeOpenTokens(user.id, now, 'confirm')
          await store.selfRecovery.createToken({
            userId: user.id,
            purpose: 'confirm',
            email,
            tokenHash: hashInvitationToken(token),
            expiresAt: recoveryEmailConfirmExpiry(now),
          })
        })
        logger('info', 'auth.recovery-email.confirmation-sent', { userId: user.id })
        await deliver(
          context.mailer,
          logger,
          'recovery-email-confirm',
          recoveryEmailConfirmMail(email, user.displayName, recoveryEmailConfirmUrl(config.baseUrl, token)),
        )
        const view: SelfRecoveryView = { email: recovery.email, pendingEmail: email }
        sendJson(response, 200, view)
      },
    },
  ]
}
