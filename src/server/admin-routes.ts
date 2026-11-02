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
 * Ohne Postausgang versendet die Instanz nichts; mit ihm gehen Einladung und Mitteilungen zusaetzlich per
 * Mail (`mailer.ts`). Die Selbstwiederherstellung per Mail schaltet der Systemadmin je Konto frei.
 *
 * Deaktivieren widerruft alle Sitzungen des betroffenen Nutzers und schliesst seine offenen WebSockets; es
 * wirkt damit auf **beide** Anmeldewege sofort. Ein Systemadmin kann sich selbst nicht deaktivieren, sonst
 * waere eine Instanz ohne Administration erzeugbar.
 */

import type {
  AdminApiKeysResponse,
  AdminApiKeyView,
  AdminUserView,
  AdminUsersResponse,
  ClientAddressResponse,
  CreateInvitationResponse,
  CreateUserResponse,
  ApiKeyAccessView,
  RevokeApiKeyResponse,
  SetApiAccessRequest,
  SetSelfRecoveryRequest,
  SetUserStatusRequest,
  UserStatusView,
} from '../contracts/api.js'
import {
  ADMIN_API_KEY_REVOKE_PATH,
  ADMIN_API_KEYS_PATH,
  ADMIN_CLIENT_ADDRESS_PATH,
  ADMIN_USER_API_ACCESS_PATH,
  ADMIN_USER_CREATE_PATH,
  ADMIN_USER_INVITATION_PATH,
  ADMIN_USER_INVITATION_REVOKE_PATH,
  ADMIN_USER_PASSWORD_PATH,
  ADMIN_USER_SELF_RECOVERY_PATH,
  ADMIN_USER_STATUS_PATH,
  ADMIN_USERS_PATH,
} from '../contracts/api.js'
import type { ApiKey } from '../domain/identity/api-key.js'
import { isApiKeyLive } from '../domain/identity/api-key.js'
import type { UserInvitation } from '../domain/identity/local-auth.js'
import { invitationExpiry, normalizeDisplayName, normalizeEmail, parsePassword } from '../domain/identity/local-auth.js'
import type { User, UserId } from '../domain/identity/model.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import { selfRecoveryAllowable } from '../domain/identity/self-recovery.js'
import { IdentityConflictError } from '../domain/identity/repositories.js'
import { resolveClientAddress } from './client-address.js'
import type { AppContext } from './context.js'
import { requireCsrfToken, requireSession, requireSystemAdmin, toUserView } from './guard.js'
import type { Route } from './http.js'
import { readJsonBody, sendError, sendJson } from './http.js'
import { createInvitationToken, hashInvitationToken, invitationUrl } from './invitations.js'
import { deliver, invitationMail, passwordResetMail } from './mailer.js'
import { clearLoginAttempts } from './login-throttle.js'
import { hashPassword } from './password.js'
import { asRequester } from './requester.js'

const API_ACCESS_LEVELS: readonly ApiKeyAccessView[] = ['off', 'read', 'edit']

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

function parseSelfRecoveryRequest(body: Record<string, unknown> | null): SetSelfRecoveryRequest | null {
  const userId = body?.['userId']
  const allowed = body?.['allowed']
  return typeof userId === 'string' && userId.length > 0 && typeof allowed === 'boolean' ? { userId, allowed } : null
}

function parseApiAccessRequest(body: Record<string, unknown> | null): SetApiAccessRequest | null {
  const userId = body?.['userId']
  const access = API_ACCESS_LEVELS.find((candidate) => candidate === body?.['access'])
  return typeof userId === 'string' && userId.length > 0 && access !== undefined ? { userId, access } : null
}

function targetViewOf(target: ApiKey['target']): AdminApiKeyView['target'] {
  switch (target.kind) {
    case 'workspace':
      return { kind: 'workspace', id: target.workspaceId }
    case 'folder':
      return { kind: 'folder', id: target.folderId }
    case 'board':
      return { kind: 'board', id: target.boardId }
  }
}

function apiKeyStateOf(key: ApiKey, now: Date): AdminApiKeyView['state'] {
  if (key.revokedAt !== null) {
    return 'revoked'
  }
  return isApiKeyLive(key, now) ? 'active' : 'expired'
}

/** Warum ein Konto nicht freigeschaltet werden kann; der Satz erscheint unveraendert in der Oberflaeche. */
const SELF_RECOVERY_REFUSALS = {
  'system-admin': 'Der Systemadmin stellt seinen Zugang ausschliesslich ueber admin:recover wieder her.',
  'user-deactivated': 'Ein deaktiviertes Konto kann nicht freigeschaltet werden.',
  'no-local-password': 'Dieses Konto hat kein lokales Passwort, das sich zuruecksetzen liesse.',
} as const

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
        const [users, withPassword, openInvitations, selfRecoveries, apiAccess] = await Promise.all([
          context.identity.users.list(),
          context.identity.localCredentials.listUserIds(),
          context.identity.invitations.listOpen(now),
          context.identity.selfRecovery.list(),
          context.identity.apiKeys.listAccess(),
        ])
        const passwords = new Set(withPassword)
        const invitations = new Map(openInvitations.map((invitation) => [invitation.userId, invitation]))
        const recoveries = new Map(selfRecoveries.map((recovery) => [recovery.userId, recovery]))
        const body: AdminUsersResponse = {
          users: users.map((user): AdminUserView => {
            const invitation = invitations.get(user.id)
            return {
              ...toUserView(user),
              hasPassword: passwords.has(user.id),
              invitationExpiresAt: invitation?.expiresAt.toISOString() ?? null,
              selfRecoveryAllowed: recoveries.get(user.id)?.allowed ?? false,
              recoveryEmailVerified: (recoveries.get(user.id)?.email ?? null) !== null,
              apiKeyAccess: apiAccess.get(user.id) ?? 'off',
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
        const checked = wantsPassword ? parsePassword(raw, { email, displayName }) : null
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
        const target = await context.identity.users.findById(userId)
        if (target === null) {
          sendError(response, 404, 'Unbekannter Nutzer')
          return
        }
        const checked = parsePassword(body?.['password'], target)
        if (!checked.ok) {
          sendError(response, 400, checked.problem)
          return
        }
        const passwordHash = await hashPassword(checked.password)
        const now = context.now()
        await context.identity.transaction(async (store) => {
          await store.localCredentials.set(userId, passwordHash, { mustChangePassword: true })
          // Eine offene Einladung waere ein zweiter Weg auf dasselbe Konto; die Ruecksetzung schliesst ihn.
          await store.invitations.revokeOpenForUser(userId, now)
          // Ebenso ein offener Ruecksetzungslink der Selbstwiederherstellung.
          await store.selfRecovery.revokeOpenTokens(userId, now, 'reset')
          await store.sessions.revokeAllForUser(userId, now)
          // Der Notfallweg fuer ein gedrosseltes Konto: mit dem neuen Passwort geht es sofort weiter.
          await clearLoginAttempts(store, config.sessionSecret, target.email)
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

    /**
     * Selbstwiederherstellung per Mail freischalten oder abschalten.
     *
     * Freischalten laesst sich nur ein aktives Konto mit lokalem Passwort und ohne Systemadminrolle - die
     * Regel steht in der Domain und gilt bei jeder Anfrage und Einloesung noch einmal. Abschalten widerruft
     * jeden offenen Bestaetigungs- und Ruecksetzungslink; eine bestaetigte Adresse bleibt stehen.
     */
    {
      method: 'POST',
      path: ADMIN_USER_SELF_RECOVERY_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        if (!requireSystemAdmin(context, response, auth)) {
          return
        }
        const parsed = parseSelfRecoveryRequest(await readJsonBody(request))
        if (parsed === null) {
          sendError(response, 400, 'userId und allowed werden erwartet')
          return
        }
        const target = await context.identity.users.findById(parsed.userId)
        if (target === null) {
          sendError(response, 404, 'Unbekannter Nutzer')
          return
        }
        if (parsed.allowed) {
          const credential = await context.identity.localCredentials.findByUserId(target.id)
          const allowable = selfRecoveryAllowable(target, credential !== null)
          if (allowable !== 'ok') {
            logger('warn', 'admin.user.self-recovery.refused', { actorId: auth.user.id, userId: target.id, reason: allowable })
            sendError(response, 400, SELF_RECOVERY_REFUSALS[allowable])
            return
          }
        }
        const now = context.now()
        await context.identity.transaction(async (store) => {
          await store.selfRecovery.setAllowed(target.id, parsed.allowed)
          if (!parsed.allowed) {
            await store.selfRecovery.revokeOpenTokens(target.id, now)
          }
        })
        logger('info', 'admin.user.self-recovery.changed', {
          actorId: auth.user.id,
          userId: target.id,
          allowed: parsed.allowed,
        })
        sendJson(response, 200, toUserView(target))
      },
    },

    /** Sets a user's API key access. Resolution reads it on every use, so a downgrade takes effect at once. */
    {
      method: 'POST',
      path: ADMIN_USER_API_ACCESS_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        if (!requireSystemAdmin(context, response, auth)) {
          return
        }
        const parsed = parseApiAccessRequest(await readJsonBody(request))
        if (parsed === null) {
          sendError(response, 400, 'userId und access (off, read, edit) werden erwartet')
          return
        }
        const target = await context.identity.users.findById(parsed.userId)
        if (target === null) {
          sendError(response, 404, 'Unbekannter Nutzer')
          return
        }
        const previous = await context.identity.transaction(async (store) => {
          const before = await store.apiKeys.getAccess(target.id)
          if (before !== parsed.access) {
            await store.apiKeys.setAccess(target.id, parsed.access)
            await store.userAudit.record({
              actorId: auth.user.id,
              action: 'api-key.access-changed',
              targetType: 'user',
              targetId: target.id,
              subjectUserId: target.id,
              details: { from: before, to: parsed.access },
            })
          }
          return before
        })
        logger('info', 'admin.user.api-access.changed', {
          actorId: auth.user.id,
          userId: target.id,
          from: previous,
          to: parsed.access,
        })
        sendJson(response, 200, toUserView(target))
      },
    },

    /** All API keys of all users; never the value or hash, the prefix is only for recognition. */
    {
      method: 'GET',
      path: ADMIN_API_KEYS_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireSystemAdmin(context, response, auth)) {
          return
        }
        const now = context.now()
        const all = await context.identity.apiKeys.listAll()
        const body: AdminApiKeysResponse = {
          keys: all.map(({ key, user }): AdminApiKeyView => ({
            id: key.id,
            userId: user.id,
            userDisplayName: user.displayName,
            name: key.name,
            prefix: key.prefix,
            target: targetViewOf(key.target),
            level: key.level,
            expiresAt: key.expiresAt.toISOString(),
            lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
            state: apiKeyStateOf(key, now),
          })),
        }
        sendJson(response, 200, body)
      },
    },

    /** Revokes one key. An already revoked key stays revoked and gets no second audit entry. */
    {
      method: 'POST',
      path: ADMIN_API_KEY_REVOKE_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        if (!requireSystemAdmin(context, response, auth)) {
          return
        }
        const keyId = (await readJsonBody(request))?.['keyId']
        if (typeof keyId !== 'string' || keyId.length === 0) {
          sendError(response, 400, 'keyId wird erwartet')
          return
        }
        // Looking the id up in the list avoids casting a malformed id to uuid in SQL: it is simply not found.
        const found = (await context.identity.apiKeys.listAll()).find(({ key }) => key.id === keyId)
        if (found === undefined) {
          sendError(response, 404, 'Unbekannter API-Key')
          return
        }
        const revoked = await context.identity.transaction(async (store) => {
          const done = await store.apiKeys.revoke(found.key.id, context.now())
          if (done) {
            await store.userAudit.record({
              actorId: auth.user.id,
              action: 'api-key.revoked',
              targetType: 'api-key',
              targetId: found.key.id,
              subjectUserId: found.user.id,
              details: { name: found.key.name, by: 'admin' },
            })
          }
          return done
        })
        logger('info', 'admin.api-key.revoked', {
          actorId: auth.user.id,
          keyId: found.key.id,
          userId: found.user.id,
          revoked,
        })
        const body: RevokeApiKeyResponse = { status: 'ok' }
        sendJson(response, 200, body)
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
          // Sofort wirksam und fuer beide Anmeldewege: bestehende Sitzungen, offene Verbindungen, eine noch
          // offene Einladung und offene Links der Selbstwiederherstellung enden mit der Deaktivierung.
          const now = context.now()
          await context.identity.transaction(async (store) => {
            await store.sessions.revokeAllForUser(parsed.userId, now)
            await store.invitations.revokeOpenForUser(parsed.userId, now)
            await store.selfRecovery.revokeOpenTokens(parsed.userId, now)
            // API keys end with the account as well.
            await store.apiKeys.revokeAllForUser(parsed.userId, now)
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

    /**
     * Adresse und Klasse der aktuellen Anfrage.
     *
     * Die Anzeige der Systemadministration, damit ein Betreiber sieht, was `CANVAZ_TRUSTED_PROXY` und die
     * Weiterleitung des Reverse Proxy tatsaechlich ankommen lassen - unabhaengig von rootful oder rootless
     * Docker. Es entsteht dabei kein zweiter Datensatz: die Adresse gilt genau fuer diese eine Anfrage und
     * wird nicht gespeichert. `plausibility` ist das Urteil ueber die Anfragen dieses Prozesses insgesamt
     * (siehe `client-address.ts`), nicht nur ueber diese eine.
     */
    {
      method: 'GET',
      path: ADMIN_CLIENT_ADDRESS_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireSystemAdmin(context, response, auth)) {
          return
        }
        const resolved = resolveClientAddress(request, config.trustedProxy)
        const body: ClientAddressResponse = {
          address: resolved.address,
          addressClass: resolved.class,
          trustedProxy: config.trustedProxy,
          plausibility: context.addressMonitor.plausibility(),
        }
        sendJson(response, 200, body)
      },
    },
  ]
}
