/**
 * OIDC-Client: Authorization Code Flow mit PKCE.
 *
 * Gewaehlt ist `openid-client` (auf `oauth4webapi`/`jose` aufgesetzt, vom Maintainer der JOSE-Bibliothek
 * gepflegt). Es erledigt Discovery, JWKS-Abruf samt Caching und die vollstaendige Pruefung des ID-Tokens -
 * Signatur, `iss`, `aud`, `exp`, `iat`/`nbf` mit Toleranz und `nonce`. Signaturpruefung und JWKS-Handling
 * selbst zu schreiben waere die schlechteste Stelle fuer Eigenbau.
 *
 * Aus dem Tokenaustausch verlaesst dieses Modul ausschliesslich das gepruefte Claim-Set. ID-, Access- und
 * Refresh-Token werden weder zurueckgegeben noch protokolliert noch gespeichert.
 */

import * as client from 'openid-client'

import type { IdentityClaims } from '../domain/identity/provisioning.js'
import { parseIdentityClaims } from '../domain/identity/provisioning.js'
import type { AppConfig } from './config.js'
import type { FlowState } from './flow-state.js'

const SCOPE = 'openid profile email'

/** Fachliche Fehlerlagen des Flusses. Der Aufrufer uebersetzt sie in eine Anzeige; Details bleiben im Log. */
export type OidcFailureKind = 'aborted' | 'provider-unreachable' | 'invalid-response' | 'invalid-code'

export class OidcError extends Error {
  readonly kind: OidcFailureKind

  constructor(kind: OidcFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OidcError'
    this.kind = kind
  }
}

export type AuthorizationRequest = {
  readonly url: string
  readonly flow: FlowState
}

export type OidcClient = {
  /** Erzeugt `state`, `nonce` und `code_verifier` und baut die Weiterleitung zum Provider. */
  createAuthorizationRequest(): Promise<AuthorizationRequest>
  /** Loest den Code ein und liefert die geprueften Claims. Wirft `OidcError`. */
  completeAuthorization(callbackUrl: URL, flow: FlowState): Promise<IdentityClaims>
  /** RP-initiiertes Logout, falls der Issuer ein `end_session_endpoint` veroeffentlicht. Sonst `null`. */
  endSessionUrl(): Promise<string | null>
}

function isNetworkFailure(error: unknown): boolean {
  // `fetch` meldet Verbindungsfehler als TypeError; openid-client reicht sie unveraendert durch.
  return error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')
}

function toOidcError(error: unknown): OidcError {
  if (error instanceof OidcError) {
    return error
  }
  if (error instanceof client.AuthorizationResponseError) {
    const code = error.error
    const aborted = code === 'access_denied' || code === 'login_required' || code === 'consent_required'
    return new OidcError(aborted ? 'aborted' : 'invalid-response', `Autorisierungsfehler ${code}`, { cause: error })
  }
  if (error instanceof client.ResponseBodyError) {
    const expired = error.error === 'invalid_grant'
    return new OidcError(expired ? 'invalid-code' : 'provider-unreachable', `Tokenfehler ${error.error}`, {
      cause: error,
    })
  }
  if (isNetworkFailure(error)) {
    return new OidcError('provider-unreachable', 'Provider nicht erreichbar', { cause: error })
  }
  return new OidcError('invalid-response', 'Antwort des Providers nicht verwertbar', { cause: error })
}

export function createOidcClient(config: AppConfig): OidcClient {
  const issuer = new URL(config.oidc.issuer)
  let discovered: Promise<client.Configuration> | null = null

  /**
   * Discovery laeuft verzoegert und wird gecacht. Ein Provider, der beim Start nicht erreichbar ist, darf
   * die Anwendung nicht am Start hindern; nach einem Fehlschlag wird beim naechsten Versuch neu geladen.
   */
  async function configuration(): Promise<client.Configuration> {
    discovered ??= client
      .discovery(issuer, config.oidc.clientId, config.oidc.clientSecret, undefined, {
        // Ein `http:`-Issuer ist eine bewusste Konfigurationsentscheidung (lokale Instanz); ohne diese
        // Freigabe verweigert die Bibliothek jede Verbindung.
        ...(issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : {}),
      })
      .catch((error: unknown) => {
        discovered = null
        throw error
      })
    return discovered
  }

  return {
    async createAuthorizationRequest(): Promise<AuthorizationRequest> {
      let configured: client.Configuration
      try {
        configured = await configuration()
      } catch (error) {
        throw toOidcError(error)
      }
      const codeVerifier = client.randomPKCECodeVerifier()
      const flow: FlowState = {
        state: client.randomState(),
        nonce: client.randomNonce(),
        codeVerifier,
      }
      const url = client.buildAuthorizationUrl(configured, {
        redirect_uri: config.oidc.redirectUri,
        scope: SCOPE,
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
      })
      return { url: url.href, flow }
    },

    async completeAuthorization(callbackUrl: URL, flow: FlowState): Promise<IdentityClaims> {
      let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>
      try {
        const configured = await configuration()
        tokens = await client.authorizationCodeGrant(configured, callbackUrl, {
          pkceCodeVerifier: flow.codeVerifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
        })
      } catch (error) {
        throw toOidcError(error)
      }
      const claims = parseIdentityClaims(tokens.claims())
      if (claims === null) {
        throw new OidcError('invalid-response', 'ID-Token ohne verwertbare iss/sub-Claims')
      }
      return claims
    },

    async endSessionUrl(): Promise<string | null> {
      const configured = await configuration()
      if (configured.serverMetadata().end_session_endpoint === undefined) {
        return null
      }
      // Ohne gespeichertes `id_token_hint` bleibt der Client-Hinweis; Provider fragen dann ggf. nach.
      return client.buildEndSessionUrl(configured, { post_logout_redirect_uri: config.baseUrl }).href
    },
  }
}
