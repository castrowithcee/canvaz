/**
 * Externe Anmeldung, Abmeldung und eigenes Profil.
 *
 * Die OIDC-Strecke ist **zuschaltbar**: ohne konfigurierten Provider entstehen die beiden Routen gar nicht
 * erst, und die Oberflaeche bekommt ueber `/api/auth/methods` gesagt, dass es diesen Weg hier nicht gibt.
 * Abmeldung und Profil gelten unabhaengig davon fuer jede Sitzung - beide Anmeldewege fuehren auf dieselbe
 * serverseitige, widerrufbare Sitzung.
 *
 * Der Callback ist die einzige Stelle, an der Providerantworten in lokale Zustaende uebersetzt werden. Er
 * beendet den transienten Flow-Zustand vor der Codeeinloesung (Einmalverwendung), verifiziert ueber den
 * OIDC-Client und legt erst danach Profil und Session an. Fehlerdetails gehen ins strukturierte Log; der
 * Nutzer bekommt einen Code, den die Oberflaeche in einen Satz mit Wiederholungsweg uebersetzt.
 */

import type {
  AppearanceView,
  AuthMethodsResponse,
  LoginErrorCode,
  LogoutResponse,
  MeResponse,
  SecondFactorView,
} from '../contracts/api.js'
import {
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_METHODS_PATH,
  DEFAULT_APPEARANCE,
  LOGIN_ERROR_PARAM,
  ME_APPEARANCE_PATH,
  ME_PATH,
  parseAppearance,
} from '../contracts/api.js'
import type { SignedInSession, UserId } from '../domain/identity/model.js'
import { requiresSecondFactor } from '../domain/identity/model.js'
import { hasActiveTotp } from '../domain/identity/second-factor.js'
import type { IdentityClaims, ProvisioningDecision } from '../domain/identity/provisioning.js'
import { decideProvisioning } from '../domain/identity/provisioning.js'
import { IdentityConflictError } from '../domain/identity/repositories.js'
import type { OidcConfig } from './config.js'
import type { AppContext } from './context.js'
import { clearFlowCookie, openFlowState, readFlowCookie, sealFlowState, setFlowCookie } from './flow-state.js'
import { requireCsrfToken, requireSession, requireSignedIn, toUserView } from './guard.js'
import type { Route } from './http.js'
import { readJsonBody, sendError, sendJson, sendRedirect } from './http.js'
import { describeError } from './log.js'
import type { OidcClient } from './oidc.js'
import { OidcError } from './oidc.js'
import { asRequester } from './requester.js'
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

/** Die Ablehnungsgruende der Provisionierung; jeder hat genau einen Code fuer die Anzeige. */
type ProvisioningDenial = Extract<ProvisioningDecision, { kind: 'deny' }>['reason']

const DENIAL_CODES: Readonly<Record<ProvisioningDenial, LoginErrorCode>> = {
  'user-deactivated': 'nutzer-deaktiviert',
  'email-already-linked': 'konto-nicht-zuordenbar',
}

type LoginOutcome =
  | { readonly kind: 'ok'; readonly token: string; readonly userId: UserId }
  | { readonly kind: 'denied'; readonly reason: ProvisioningDenial }

/**
 * Just-in-time-Provisionierung samt Session in einer Transaktion: Nutzer, Verknuepfung und Sitzung entstehen
 * gemeinsam oder gar nicht. Die Regel selbst steht in `decideProvisioning`.
 */
async function runProvisioning(context: AppContext, claims: IdentityClaims): Promise<LoginOutcome> {
  const now = context.now()
  return context.identity.transaction(async (store) => {
    const key = { issuer: claims.issuer, subject: claims.subject }
    const linked = await store.externalIdentities.findByKey(key)
    // Nur eine unbekannte Identitaet fragt nach einem Profil mit derselben bestaetigten Adresse; eine
    // gewoehnliche Anmeldung laeuft unberuehrt daran vorbei.
    const existingByEmail =
      linked === null && claims.email !== null ? await store.users.findByEmail(claims.email) : null
    // Und nur ein solches Profil wird gefragt, ob seine Zuordnung noch offen ist.
    const existingHasExternalIdentity =
      existingByEmail !== null && (await store.externalIdentities.existsForUser(existingByEmail.id))
    const decision = decideProvisioning(claims, linked, { existingByEmail, existingHasExternalIdentity })
    if (decision.kind === 'deny') {
      return { kind: 'denied', reason: decision.reason }
    }
    let userId: UserId
    if (decision.kind === 'provision') {
      // Ausdruecklich ohne Rechte: ein Systemadmin entsteht ausschliesslich durch den einmaligen Bootstrap,
      // nie durch eine Anmeldung.
      const user = await store.users.create(decision.profile, { isSystemAdmin: false })
      await store.externalIdentities.link(user.id, decision.key)
      userId = user.id
    } else if (decision.kind === 'link') {
      // Dasselbe Profil, ein zweiter Weg darauf: Rechte, Status und Mitgliedschaften bleiben, wie sie sind.
      await store.externalIdentities.link(decision.userId, decision.key)
      await store.users.updateProfile(decision.userId, decision.profile)
      userId = decision.userId
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

/**
 * Die beiden Routen der externen Anmeldung. Sie entstehen nur mit konfiguriertem Provider - ohne ihn gibt es
 * den Weg nicht, und ein Aufruf laeuft in dieselbe 404 wie jeder unbekannte Pfad.
 */
function createOidcRoutes(context: AppContext, oidc: OidcConfig, client: OidcClient): readonly Route[] {
  const { config, logger } = context
  // Der Callback existiert ausschliesslich unter dem konfigurierten Pfad. Damit ist die Redirect-URI streng
  // validiert: eine Antwort an einen anderen Pfad findet keine Route.
  const callbackPath = new URL(oidc.redirectUri).pathname

  return [
    {
      method: 'GET',
      path: AUTH_LOGIN_PATH,
      handle: async ({ response }) => {
        try {
          const request = await client.createAuthorizationRequest()
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
        const callbackUrl = new URL(oidc.redirectUri)
        callbackUrl.search = url.search

        let claims: IdentityClaims
        try {
          claims = await client.completeAuthorization(callbackUrl, flow)
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
          logger('warn', 'auth.callback.denied', { reason: outcome.reason, subject: claims.subject })
          sendRedirect(response, appUrl(config.baseUrl, DENIAL_CODES[outcome.reason]))
          return
        }

        setSessionCookie(response, config, outcome.token)
        logger('info', 'auth.login.succeeded', { userId: outcome.userId, method: 'oidc' })
        sendRedirect(response, appUrl(config.baseUrl))
      },
    },
  ]
}

/** Stand des zweiten Faktors fuer die Oberflaeche; die Durchsetzung liegt in den Guards. */
async function secondFactorOf(context: AppContext, auth: SignedInSession): Promise<SecondFactorView> {
  if (!requiresSecondFactor(auth.user)) {
    return { state: 'not-required' }
  }
  if (auth.secondFactorPending) {
    const enrolled = hasActiveTotp(await context.identity.secondFactors.findTotp(auth.user.id))
    return { state: enrolled ? 'verification-required' : 'setup-required' }
  }
  return {
    state: 'verified',
    backupCodesRemaining: await context.identity.secondFactors.countUnusedBackupCodes(auth.user.id),
  }
}

export function createAuthRoutes(context: AppContext): readonly Route[] {
  const { config, logger } = context
  const oidcClient = context.oidc
  const oidcRoutes =
    config.oidc === null || oidcClient === null ? [] : createOidcRoutes(context, config.oidc, oidcClient)

  return [
    ...oidcRoutes,

    /**
     * Welche Anmeldewege diese Instanz tatsaechlich hat.
     *
     * Oeffentlich und ohne jede Angabe zum Provider: die Anmeldeseite soll keinen Weg anbieten, den es hier
     * nicht gibt, und ein Unangemeldeter erfaehrt trotzdem nichts ueber Issuer, Client oder Konten.
     */
    {
      method: 'GET',
      path: AUTH_METHODS_PATH,
      handle: ({ response }) => {
        const body: AuthMethodsResponse = { local: true, oidc: config.oidc !== null }
        sendJson(response, 200, body)
      },
    },

    {
      method: 'POST',
      path: AUTH_LOGOUT_PATH,
      handle: async ({ request, response }) => {
        // Auch ohne belegten zweiten Faktor: abmelden kann sich jede Sitzung.
        const auth = await requireSignedIn(context, request, response)
        if (auth === null) {
          return
        }
        if (!requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        await context.identity.sessions.revoke(auth.session.id, context.now())
        // Ein offener WebSocket ueberlebt den Widerruf nicht.
        context.realtime.closeSession(auth.session.id)
        clearSessionCookie(response, config)
        let endSessionUrl: string | null = null
        if (oidcClient !== null) {
          try {
            endSessionUrl = await oidcClient.endSessionUrl()
          } catch (error) {
            // Die lokale Abmeldung ist bereits vollzogen; ein stummer Provider aendert daran nichts.
            logger('warn', 'auth.logout.end-session-unavailable', { reason: describeError(error) })
          }
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
        // Auch ohne belegten zweiten Faktor: das Profil sind die Minimaldaten, mit denen die Oberflaeche
        // Einrichtung oder Abfrage zeigt. Es traegt nichts, was die Sitzung nicht ohnehin kennt.
        const auth = await requireSignedIn(context, request, response)
        if (auth === null) {
          return
        }
        const appearance = await context.identity.appearances.findByUserId(auth.user.id)
        const body: MeResponse = {
          user: toUserView(auth.user),
          csrfToken: csrfTokenFor(auth.session.id, config.sessionSecret),
          appearance: appearance ?? DEFAULT_APPEARANCE,
          secondFactor: await secondFactorOf(context, auth),
        }
        sendJson(response, 200, body)
      },
    },

    /**
     * Eigenes Erscheinungsbild aendern.
     *
     * Die Route kennt keinen Nutzerparameter: sie schreibt ausschliesslich die Wahl dessen, der die Sitzung
     * fuehrt. Einen Weg, die Wahl eines anderen zu lesen oder zu aendern, gibt es damit nicht - auch nicht
     * fuer die Systemadministration. Ein Gast hat keine Sitzung und damit keine Wahl.
     */
    {
      method: 'POST',
      path: ME_APPEARANCE_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        if (!requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        const appearance = parseAppearance(await readJsonBody(request))
        if (appearance === null) {
          sendError(response, 400, 'Unbekanntes Farbschema oder unbekannte Akzentfarbe')
          return
        }
        await context.identity.appearances.set(auth.user.id, appearance)
        const body: AppearanceView = appearance
        sendJson(response, 200, body)
      },
    },
  ]
}
