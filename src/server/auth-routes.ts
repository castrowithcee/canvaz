/**
 * Anmeldung, Abmeldung und eigenes Profil.
 *
 * Der Callback ist die einzige Stelle, an der Providerantworten in lokale Zustaende uebersetzt werden. Er
 * beendet den transienten Flow-Zustand vor der Codeeinloesung (Einmalverwendung), verifiziert ueber den
 * OIDC-Client und legt erst danach Profil und Session an. Fehlerdetails gehen ins strukturierte Log; der
 * Nutzer bekommt einen Code, den die Oberflaeche in einen Satz mit Wiederholungsweg uebersetzt.
 */

import type { LoginErrorCode, LogoutResponse, MeResponse } from '../contracts/api.js'
import { AUTH_LOGIN_PATH, AUTH_LOGOUT_PATH, LOGIN_ERROR_PARAM, ME_PATH } from '../contracts/api.js'
import type { UserId } from '../domain/identity/model.js'
import type { IdentityClaims } from '../domain/identity/provisioning.js'
import { decideProvisioning } from '../domain/identity/provisioning.js'
import { IdentityConflictError } from '../domain/identity/repositories.js'
import type { AppContext } from './context.js'
import { clearFlowCookie, openFlowState, readFlowCookie, sealFlowState, setFlowCookie } from './flow-state.js'
import { requireCsrfToken, requireSession, toUserView } from './guard.js'
import type { Route } from './http.js'
import { sendJson, sendRedirect } from './http.js'
import { describeError } from './log.js'
import { OidcError } from './oidc.js'
import { clearSessionCookie, csrfTokenFor, setSessionCookie, startSession } from './session.js'

/** Der Callback antwortet immer mit einer Weiterleitung auf die Startseite - mit oder ohne Fehlercode. */
function appUrl(baseUrl: string, error?: LoginErrorCode): string {
  const url = new URL('/', baseUrl)
  if (error !== undefined) {
    url.searchParams.set(LOGIN_ERROR_PARAM, error)
  }
  return url.href
}

const FAILURE_CODES: Readonly<Record<OidcError['kind'], LoginErrorCode>> = {
  aborted: 'abgebrochen',
  'provider-unreachable': 'provider-fehler',
  'invalid-response': 'ungueltige-antwort',
  'invalid-code': 'code-ungueltig',
}

type LoginOutcome =
  | { readonly kind: 'ok'; readonly token: string; readonly userId: UserId }
  | { readonly kind: 'denied' }

/**
 * Just-in-time-Provisionierung samt Session in einer Transaktion: Nutzer, Verknuepfung und Sitzung entstehen
 * gemeinsam oder gar nicht. Die Regel selbst steht in `decideProvisioning`.
 */
async function runProvisioning(context: AppContext, claims: IdentityClaims): Promise<LoginOutcome> {
  const now = context.now()
  return context.identity.transaction(async (store) => {
    const key = { issuer: claims.issuer, subject: claims.subject }
    const linked = await store.externalIdentities.findByKey(key)
    // Nur der Weg in die Erstanlage fragt - und sperrt - die Bootstrap-Entscheidung; eine gewoehnliche
    // Anmeldung laeuft unberuehrt daran vorbei.
    const isFirstUser = linked === null && (await store.users.isFirstUser())
    const decision = decideProvisioning(claims, linked, { isFirstUser })
    if (decision.kind === 'deny') {
      return { kind: 'denied' }
    }
    let userId: UserId
    if (decision.kind === 'provision') {
      const user = await store.users.create(decision.profile, { isSystemAdmin: decision.isSystemAdmin })
      await store.externalIdentities.link(user.id, decision.key)
      userId = user.id
    } else {
      await store.users.updateProfile(decision.userId, decision.profile)
      await store.externalIdentities.markSeen(decision.identity.id, now)
      userId = decision.userId
    }
    const { token } = await startSession(store, context.config, userId, now)
    return { kind: 'ok', token, userId }
  })
}

/**
 * Melden sich mehrere Geraete desselben Nutzers gleichzeitig zum ersten Mal an, gewinnt einer die Erstanlage
 * und die anderen laufen in die Eindeutigkeit von Adresse oder externer Identitaet. Das ist ein erwarteter
 * Konflikt: der zweite Anlauf findet den angelegten Nutzer vor und meldet ihn normal an.
 */
async function provisionAndStartSession(context: AppContext, claims: IdentityClaims): Promise<LoginOutcome> {
  try {
    return await runProvisioning(context, claims)
  } catch (error) {
    if (!(error instanceof IdentityConflictError)) {
      throw error
    }
    context.logger('warn', 'auth.provisioning.conflict-retried', { subject: claims.subject })
    return runProvisioning(context, claims)
  }
}

export function createAuthRoutes(context: AppContext): readonly Route[] {
  const { config, logger } = context
  // Der Callback existiert ausschliesslich unter dem konfigurierten Pfad. Damit ist die Redirect-URI streng
  // validiert: eine Antwort an einen anderen Pfad findet keine Route.
  const callbackPath = new URL(config.oidc.redirectUri).pathname

  return [
    {
      method: 'GET',
      path: AUTH_LOGIN_PATH,
      handle: async ({ response }) => {
        try {
          const request = await context.oidc.createAuthorizationRequest()
          setFlowCookie(response, config, await sealFlowState(request.flow, config.sessionSecret))
          logger('info', 'auth.login.started')
          sendRedirect(response, request.url)
        } catch (error) {
          logger('error', 'auth.login.failed', { reason: describeError(error) })
          sendRedirect(response, appUrl(config.baseUrl, 'provider-fehler'))
        }
      },
    },

    {
      method: 'GET',
      path: callbackPath,
      handle: async ({ request, response, url }) => {
        const sealed = readFlowCookie(request, config)
        // Einmalverwendung: der Zustand wird verworfen, bevor irgendetwas mit ihm geschieht.
        clearFlowCookie(response, config)
        const flow = sealed === null ? null : await openFlowState(sealed, config.sessionSecret)
        if (flow === null) {
          logger('warn', 'auth.callback.no-flow-state', { hadCookie: sealed !== null })
          sendRedirect(response, appUrl(config.baseUrl, 'flow-abgelaufen'))
          return
        }

        // Die Antwort wird gegen die konfigurierte Redirect-URI geprueft, nicht gegen den Anfrage-Host.
        const callbackUrl = new URL(config.oidc.redirectUri)
        callbackUrl.search = url.search

        let claims: IdentityClaims
        try {
          claims = await context.oidc.completeAuthorization(callbackUrl, flow)
        } catch (error) {
          const failure = error instanceof OidcError ? error : null
          const code: LoginErrorCode = failure === null ? 'unbekannt' : FAILURE_CODES[failure.kind]
          logger('warn', 'auth.callback.rejected', { code, reason: describeError(error) })
          sendRedirect(response, appUrl(config.baseUrl, code))
          return
        }

        let outcome: LoginOutcome
        try {
          outcome = await provisionAndStartSession(context, claims)
        } catch (error) {
          logger('error', 'auth.callback.provisioning-failed', { reason: describeError(error) })
          sendRedirect(response, appUrl(config.baseUrl, 'unbekannt'))
          return
        }
        if (outcome.kind === 'denied') {
          logger('warn', 'auth.callback.denied', { reason: 'user-deactivated', subject: claims.subject })
          sendRedirect(response, appUrl(config.baseUrl, 'nutzer-deaktiviert'))
          return
        }

        setSessionCookie(response, config, outcome.token)
        logger('info', 'auth.login.succeeded', { userId: outcome.userId })
        sendRedirect(response, appUrl(config.baseUrl))
      },
    },

    {
      method: 'POST',
      path: AUTH_LOGOUT_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        if (!requireCsrfToken(context, request, response, auth)) {
          return
        }
        await context.identity.sessions.revoke(auth.session.id, context.now())
        // Ein offener WebSocket ueberlebt den Widerruf nicht.
        context.realtime.closeSession(auth.session.id)
        clearSessionCookie(response, config)
        let endSessionUrl: string | null = null
        try {
          endSessionUrl = await context.oidc.endSessionUrl()
        } catch (error) {
          // Die lokale Abmeldung ist bereits vollzogen; ein stummer Provider aendert daran nichts.
          logger('warn', 'auth.logout.end-session-unavailable', { reason: describeError(error) })
        }
        logger('info', 'auth.logout.succeeded', { userId: auth.user.id })
        const body: LogoutResponse = { endSessionUrl }
        sendJson(response, 200, body)
      },
    },

    {
      method: 'GET',
      path: ME_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        const body: MeResponse = {
          user: toUserView(auth.user),
          csrfToken: csrfTokenFor(auth.session.id, config.sessionSecret),
        }
        sendJson(response, 200, body)
      },
    },
  ]
}
