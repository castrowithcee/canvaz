/**
 * Systemadministration: Konten und ihr Zugang.
 *
 * Serverseitig geprueft und standardmaessig verweigernd: jede Route dieses Moduls verlangt eine Sitzung und
 * `isSystemAdmin` des angemeldeten Nutzers, zustandsaendernde zusaetzlich das an die Sitzung gebundene
 * CSRF-Token. Die Oberflaeche entscheidet nichts davon.
 *
 * Hier entstehen **alle** internen Konten: es gibt keine Selbstregistrierung. Der Systemadmin waehlt bei der
 * Anlage einen von zwei Wegen der Uebergabe:
 *
 * 1. **Initialpasswort** - er vergibt es und uebermittelt es ausserhalb der Anwendung. Es steht in keiner
 *    Antwort und in keinem Protokoll; gespeichert wird nur sein Hash, und der erste Anmeldeversuch fuehrt
 *    zwingend ueber den Wechsel.
 * 2. **Einladungslink** - befristet, genau einmal einloesbar, jederzeit widerrufbar. Der Einladungswert
 *    erscheint genau einmal in der Anlageantwort und ist danach nicht wieder abrufbar; ein verlorener Link
 *    wird widerrufen und neu erzeugt.
 *
 * Die Instanz versendet nichts: Mailversand ist ausdruecklich nicht Teil des Produkts.
 *
 * Deaktivieren widerruft alle Sitzungen des betroffenen Nutzers und schliesst seine offenen WebSockets; es
 * wirkt damit auf **beide** Anmeldewege sofort. Ein Systemadmin kann sich selbst nicht deaktivieren, sonst
 * waere eine Instanz ohne Administration erzeugbar.
 */

import type {
  AdminUserView,
  AdminUsersResponse,
  CreateInvitationResponse,
  CreateUserResponse,
  SetUserStatusRequest,
  UserStatusView,
} from '../contracts/api.js'
import {
  ADMIN_USER_CREATE_PATH,
  ADMIN_USER_INVITATION_PATH,
  ADMIN_USER_INVITATION_REVOKE_PATH,
  ADMIN_USER_PASSWORD_PATH,
  ADMIN_USER_STATUS_PATH,
  ADMIN_USERS_PATH,
} from '../contracts/api.js'
import type { UserInvitation } from '../domain/identity/local-auth.js'
import { invitationExpiry, normalizeDisplayName, normalizeEmail, parsePassword } from '../domain/identity/local-auth.js'
import type { User, UserId } from '../domain/identity/model.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import { IdentityConflictError } from '../domain/identity/repositories.js'
import type { AppContext } from './context.js'
import { requireCsrfToken, requireSession, requireSystemAdmin, toUserView } from './guard.js'
import type { Route } from './http.js'
import { readJsonBody, sendError, sendJson } from './http.js'
import { createInvitationToken, hashInvitationToken, invitationUrl } from './invitations.js'
import { deliver, invitationMail, passwordResetMail } from './mailer.js'
import { hashPassword } from './password.js'
import { asRequester } from './requester.js'

const STATUSES: readonly UserStatusView[] = ['active', 'deactivated']

function parseStatusRequest(body: Record<string, unknown> | null): SetUserStatusRequest | null {
  if (body === null) {
    return null
  }
  const userId = body['userId']
  const status = body['status']
  if (typeof userId !== 'string' || userId.length === 0) {
    return null
  }
  const parsed = STATUSES.find((candidate) => candidate === status)
  return parsed === undefined ? null : { userId, status: parsed }
}

function readUserId(body: Record<string, unknown> | null): UserId | null {
  const userId = body?.['userId']
  return typeof userId === 'string' && userId.length > 0 ? userId : null
}

export function createAdminRoutes(context: AppContext): readonly Route[] {
  const { config, logger } = context

  /**
   * Erzeugt eine Einladung und ersetzt dabei jede offene desselben Nutzers.
   *
   * Der Widerruf gehoert in dieselbe Transaktion: sonst gaebe es einen Moment mit zwei gueltigen Links, und
   * der aeltere waere genau der, den jemand anderes noch haben koennte.
   */
  async function issueInvitation(
    store: IdentityStore,
    userId: UserId,
    actorId: UserId,
    now: Date,
  ): Promise<{ readonly token: string; readonly invitation: UserInvitation }> {
    const token = createInvitationToken()
    await store.invitations.revokeOpenForUser(userId, now)
    const invitation = await store.invitations.create({
      userId,
      tokenHash: hashInvitationToken(token),
      createdByUserId: actorId,
      expiresAt: invitationExpiry(now),
    })
    return { token, invitation }
  }

  return [
    /**
     * Nutzerliste samt Anmeldeweg.
     *
     * Beide Zusatzangaben kommen aus je einer Abfrage ueber alle Zeilen statt aus einer je Nutzer: die
     * Instanz fuehrt Dutzende Konten, nicht Tausende, und ein Verbund je Zeile waere hier nur Aufwand.
     */
    {
      method: 'GET',
      path: ADMIN_USERS_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireSystemAdmin(context, response, auth)) {
          return
        }
        const now = context.now()
        const [users, withPassword, openInvitations] = await Promise.all([
          context.identity.users.list(),
          context.identity.localCredentials.listUserIds(),
          context.identity.invitations.listOpen(now),
        ])
        const passwords = new Set(withPassword)
        const invitations = new Map(openInvitations.map((invitation) => [invitation.userId, invitation]))
        const body: AdminUsersResponse = {
          users: users.map((user): AdminUserView => {
            const invitation = invitations.get(user.id)
            return {
              ...toUserView(user),
              hasPassword: passwords.has(user.id),
              invitationExpiresAt: invitation?.expiresAt.toISOString() ?? null,
            }
          }),
        }
        sendJson(response, 200, body)
      },
    },

    /**
     * Kontoanlage.
     *
     * Adresse und Anzeigename sind Pflicht: die Adresse ist der lokale Anmeldename und zugleich das, woran
     * eine spaetere externe Anmeldung dasselbe Profil erkennt. Rechte vergibt die Anlage keine: die
     * Systemadminrolle traegt allein das Bootstrap-Konto, und es gibt keinen Endpunkt, der sie weitergibt.
     */
    {
      method: 'POST',
      path: ADMIN_USER_CREATE_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        if (!requireSystemAdmin(context, response, auth)) {
          return
        }
        const body = await readJsonBody(request)
        const displayName = normalizeDisplayName(body?.['displayName'])
        const email = normalizeEmail(body?.['email'])
        if (displayName === null || email === null) {
          sendError(response, 400, 'Anzeigename und gueltige E-Mail-Adresse werden erwartet')
          return
        }
        const raw = body?.['initialPassword']
        // Fehlt das Feld, ist der Einladungsweg gemeint. Steht etwas darin, muss es taugen - ein zu kurzes
        // Initialpasswort wird nicht stillschweigend zur Einladung.
        const wantsPassword = raw !== undefined && raw !== null && raw !== ''
        const checked = wantsPassword ? parsePassword(raw) : null
        if (checked !== null && !checked.ok) {
          sendError(response, 400, checked.problem)
          return
        }
        const passwordHash = checked === null ? null : await hashPassword(checked.password)
        const now = context.now()
        let created: { readonly user: User; readonly token: string | null }
        try {
          created = await context.identity.transaction(async (store) => {
            const user = await store.users.create({ displayName, email }, { isSystemAdmin: false })
            if (passwordHash !== null) {
              // Initialpasswort: der Wechsel bei der ersten Anmeldung ist Teil der Anlage, nicht ihrer Anzeige.
              await store.localCredentials.set(user.id, passwordHash, { mustChangePassword: true })
              return { user, token: null }
            }
            const { token } = await issueInvitation(store, user.id, auth.user.id, now)
            return { user, token }
          })
        } catch (error) {
          if (error instanceof IdentityConflictError) {
            sendError(response, 409, 'Diese Adresse ist bereits vergeben')
            return
          }
          throw error
        }
        logger('info', 'admin.user.created', {
          actorId: auth.user.id,
          userId: created.user.id,
          method: created.token === null ? 'initial-password' : 'invitation',
        })
        const result: CreateUserResponse = {
          user: toUserView(created.user),
          invitationUrl: created.token === null ? null : invitationUrl(config.baseUrl, created.token),
        }
        // Erst nach der Anlage und ohne Rueckweg in diese Antwort: der Link steht hier ohnehin, und ein
        // stummer Postausgang darf ein angelegtes Konto nicht zu einem Fehlschlag machen.
        if (result.invitationUrl !== null) {
          await deliver(
            context.mailer,
            logger,
            'invitation',
            invitationMail(email, displayName, result.invitationUrl),
          )
        }
        sendJson(response, 201, result)
      },
    },

    /**
     * Administrative Ruecksetzung auf ein neues Initialpasswort.
     *
     * Sie beendet jede Sitzung des betroffenen Kontos: eine Ruecksetzung ist der Fall, in dem der bisherige
     * Zugang als verloren gilt, und eine ueberlebende Sitzung waere genau der Zugang, um den es geht.
     */
    {
      method: 'POST',
      path: ADMIN_USER_PASSWORD_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        if (!requireSystemAdmin(context, response, auth)) {
          return
        }
        const body = await readJsonBody(request)
        const userId = readUserId(body)
        if (userId === null) {
          sendError(response, 400, 'userId wird erwartet')
          return
        }
        const checked = parsePassword(body?.['password'])
        if (!checked.ok) {
          sendError(response, 400, checked.problem)
          return
        }
        const target = await context.identity.users.findById(userId)
        if (target === null) {
          sendError(response, 404, 'Unbekannter Nutzer')
          return
        }
        const passwordHash = await hashPassword(checked.password)
        const now = context.now()
        await context.identity.transaction(async (store) => {
          await store.localCredentials.set(userId, passwordHash, { mustChangePassword: true })
          // Eine offene Einladung waere ein zweiter Weg auf dasselbe Konto; die Ruecksetzung schliesst ihn.
          await store.invitations.revokeOpenForUser(userId, now)
          await store.sessions.revokeAllForUser(userId, now)
        })
        context.realtime.closeUser(userId)
        logger('info', 'admin.user.password-reset', { actorId: auth.user.id, userId })
        // Die Mitteilung nennt das neue Passwort ausdruecklich nicht; sie sagt nur, dass es eines gibt.
        // Ein Konto ohne Adresse gibt es nur ueber den externen Weg; dorthin fuehrt keine Nachricht.
        if (target.email !== null) {
          await deliver(
            context.mailer,
            logger,
            'password-reset',
            passwordResetMail(target.email, target.displayName, config.baseUrl),
          )
        }
        sendJson(response, 200, toUserView(target))
      },
    },

    /** Neue Einladung fuer ein vorhandenes Konto - der zweite Weg der Ruecksetzung. */
    {
      method: 'POST',
      path: ADMIN_USER_INVITATION_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        if (!requireSystemAdmin(context, response, auth)) {
          return
        }
        const userId = readUserId(await readJsonBody(request))
        if (userId === null) {
          sendError(response, 400, 'userId wird erwartet')
          return
        }
        const target = await context.identity.users.findById(userId)
        if (target === null) {
          sendError(response, 404, 'Unbekannter Nutzer')
          return
        }
        const now = context.now()
        const { token } = await context.identity.transaction((store) =>
          issueInvitation(store, userId, auth.user.id, now),
        )
        logger('info', 'admin.user.invited', { actorId: auth.user.id, userId })
        const result: CreateInvitationResponse = {
          user: toUserView(target),
          invitationUrl: invitationUrl(config.baseUrl, token),
        }
        if (target.email !== null) {
          await deliver(
            context.mailer,
            logger,
            'invitation',
            invitationMail(target.email, target.displayName, result.invitationUrl),
          )
        }
        sendJson(response, 201, result)
      },
    },

    /** Widerruf aller offenen Einladungen eines Kontos. Ein bereits verschickter Link wirkt danach nicht mehr. */
    {
      method: 'POST',
      path: ADMIN_USER_INVITATION_REVOKE_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        if (!requireSystemAdmin(context, response, auth)) {
          return
        }
        const userId = readUserId(await readJsonBody(request))
        if (userId === null) {
          sendError(response, 400, 'userId wird erwartet')
          return
        }
        const target = await context.identity.users.findById(userId)
        if (target === null) {
          sendError(response, 404, 'Unbekannter Nutzer')
          return
        }
        const revoked = await context.identity.invitations.revokeOpenForUser(userId, context.now())
        logger('info', 'admin.user.invitation-revoked', { actorId: auth.user.id, userId, revoked })
        sendJson(response, 200, toUserView(target))
      },
    },

    {
      method: 'POST',
      path: ADMIN_USER_STATUS_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        if (!requireSystemAdmin(context, response, auth)) {
          return
        }
        const parsed = parseStatusRequest(await readJsonBody(request))
        if (parsed === null) {
          sendError(response, 400, 'userId und status werden erwartet')
          return
        }
        if (parsed.userId === auth.user.id && parsed.status === 'deactivated') {
          sendError(response, 400, 'Ein Systemadmin kann sich nicht selbst deaktivieren')
          return
        }
        const target = await context.identity.users.findById(parsed.userId)
        if (target === null) {
          sendError(response, 404, 'Unbekannter Nutzer')
          return
        }
        const updated = await context.identity.users.setStatus(parsed.userId, parsed.status)
        if (parsed.status === 'deactivated') {
          // Sofort wirksam und fuer beide Anmeldewege: bestehende Sitzungen, offene Verbindungen und eine
          // noch offene Einladung enden mit der Deaktivierung.
          const now = context.now()
          await context.identity.transaction(async (store) => {
            await store.sessions.revokeAllForUser(parsed.userId, now)
            await store.invitations.revokeOpenForUser(parsed.userId, now)
          })
          context.realtime.closeUser(parsed.userId)
        }
        logger('info', 'admin.user-status.changed', {
          actorId: auth.user.id,
          userId: updated.id,
          status: updated.status,
        })
        sendJson(response, 200, toUserView(updated))
      },
    },
  ]
}
