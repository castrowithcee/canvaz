/**
 * Standardkonformer OIDC-Provider fuer Tests.
 *
 * Er liefert echte RS256-signierte ID-Tokens und ein echtes JWKS; der Anwendungscode durchlaeuft damit
 * Discovery, PKCE, State, Nonce und die vollstaendige Tokenpruefung genau wie im Betrieb. Es gibt bewusst
 * keinen Testmodus im Produktionscode - jede Abweichung wird hier im Provider eingestellt, so wie ein
 * fehlerhafter oder feindlicher Provider sie liefern wuerde.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { SignJWT, exportJWK, generateKeyPair } from 'jose'

export type ProviderBehaviour = {
  /** Ueberschreibt den `iss`-Claim des ID-Tokens. */
  issuerOverride?: string
  /** Ueberschreibt den `aud`-Claim des ID-Tokens. */
  audienceOverride?: string
  /** Ueberschreibt den `nonce`-Claim des ID-Tokens. */
  nonceOverride?: string
  /** Stellt das ID-Token mit abgelaufenem `exp` aus. */
  expiredIdToken?: boolean
  /** Der Token-Endpunkt bricht die Verbindung ab, als waere der Provider nicht erreichbar. */
  tokenEndpointOffline?: boolean
  /** Der Token-Endpunkt antwortet mit `invalid_grant`, als waere der Code abgelaufen. */
  tokenEndpointInvalidGrant?: boolean
}

export type TestProvider = {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
  /** Alle jemals ausgegebenen ID- und Access-Tokens. Grundlage des Nachweises, dass keines gespeichert wird. */
  readonly issuedTokens: readonly string[]
  /** Steuert das Verhalten der naechsten Antworten. */
  setBehaviour(behaviour: ProviderBehaviour): void
  resetBehaviour(): void
  close(): Promise<void>
}

type PendingRequest = {
  readonly redirectUri: string
  readonly state: string | null
  readonly nonce: string | null
  readonly codeChallenge: string
}

type IssuedCode = PendingRequest & {
  readonly subject: string
  readonly email: string
  readonly name: string
  readonly issuedAt: number
  used: boolean
}

const CODE_TTL_MS = 60_000

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', reject)
  })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(html)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => `&#${String(character.charCodeAt(0))};`)
}

function credentialsFrom(request: IncomingMessage, form: URLSearchParams): { id: string; secret: string } | null {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator > 0) {
      return {
        id: decodeURIComponent(decoded.slice(0, separator)),
        secret: decodeURIComponent(decoded.slice(separator + 1)),
      }
    }
  }
  const id = form.get('client_id')
  const secret = form.get('client_secret')
  return id === null || secret === null ? null : { id, secret }
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return Buffer.from(digest).toString('base64url')
}

export async function startTestProvider(
  options: { clientId?: string; clientSecret?: string; port?: number } = {},
): Promise<TestProvider> {
  const clientId = options.clientId ?? 'canvaz-test'
  const clientSecret = options.clientSecret ?? 'canvaz-test-secret'
  const keyPair = await generateKeyPair('RS256', { extractable: true })
  const kid = 'test-key-1'
  const publicJwk = { ...(await exportJWK(keyPair.publicKey)), kid, alg: 'RS256', use: 'sig' }

  const issuedTokens: string[] = []
  const pending = new Map<string, PendingRequest>()
  const codes = new Map<string, IssuedCode>()
  let behaviour: ProviderBehaviour = {}
  let issuer = ''

  async function issueIdToken(code: IssuedCode): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const nonce = behaviour.nonceOverride ?? code.nonce
    let token = new SignJWT({
      email: code.email,
      email_verified: true,
      name: code.name,
      preferred_username: code.subject,
      ...(nonce === null ? {} : { nonce }),
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(behaviour.issuerOverride ?? issuer)
      .setSubject(code.subject)
      .setAudience(behaviour.audienceOverride ?? clientId)
      .setIssuedAt(behaviour.expiredIdToken === true ? now - 7200 : now)
    token = token.setExpirationTime(behaviour.expiredIdToken === true ? now - 3600 : now + 300)
    return token.sign(keyPair.privateKey)
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', issuer)

      if (url.pathname === '/.well-known/openid-configuration') {
        sendJson(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/logout`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          scopes_supported: ['openid', 'profile', 'email'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          code_challenge_methods_supported: ['S256'],
          claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email', 'email_verified', 'name'],
        })
        return
      }

      if (url.pathname === '/jwks') {
        sendJson(response, 200, { keys: [publicJwk] })
        return
      }

      if (url.pathname === '/authorize' && request.method === 'GET') {
        const redirectUri = url.searchParams.get('redirect_uri')
        const challenge = url.searchParams.get('code_challenge')
        if (
          url.searchParams.get('client_id') !== clientId ||
          url.searchParams.get('response_type') !== 'code' ||
          redirectUri === null ||
          challenge === null ||
          url.searchParams.get('code_challenge_method') !== 'S256'
        ) {
          sendJson(response, 400, { error: 'invalid_request' })
          return
        }
        const requestId = randomUUID()
        pending.set(requestId, {
          redirectUri,
          state: url.searchParams.get('state'),
          nonce: url.searchParams.get('nonce'),
          codeChallenge: challenge,
        })
        sendHtml(
          response,
          `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Test-Provider</title></head>
<body><h1>Test-Provider</h1>
<form method="post" action="/authorize/decide">
  <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
  <label for="subject">Subject</label>
  <input id="subject" name="subject" value="test-user">
  <label for="email">E-Mail</label>
  <input id="email" name="email" value="test-user@example.com">
  <label for="name">Name</label>
  <input id="name" name="name" value="Test Nutzerin">
  <button id="approve" type="submit" name="decision" value="approve">Anmelden</button>
  <button id="deny" type="submit" name="decision" value="deny">Abbrechen</button>
</form></body></html>`,
        )
        return
      }

      if (url.pathname === '/authorize/decide' && request.method === 'POST') {
        const form = new URLSearchParams(await readBody(request))
        const requestId = form.get('request_id') ?? ''
        const authorization = pending.get(requestId)
        pending.delete(requestId)
        if (authorization === undefined) {
          sendJson(response, 400, { error: 'invalid_request' })
          return
        }
        const target = new URL(authorization.redirectUri)
        if (authorization.state !== null) {
          target.searchParams.set('state', authorization.state)
        }
        if (form.get('decision') !== 'approve') {
          target.searchParams.set('error', 'access_denied')
          target.searchParams.set('error_description', 'Der Nutzer hat abgebrochen')
        } else {
          const code = randomUUID()
          codes.set(code, {
            ...authorization,
            subject: form.get('subject') ?? 'test-user',
            email: form.get('email') ?? 'test-user@example.com',
            name: form.get('name') ?? 'Test Nutzerin',
            issuedAt: Date.now(),
            used: false,
          })
          target.searchParams.set('code', code)
        }
        response.writeHead(302, { location: target.href })
        response.end()
        return
      }

      if (url.pathname === '/token' && request.method === 'POST') {
        if (behaviour.tokenEndpointOffline === true) {
          request.socket.destroy()
          return
        }
        const form = new URLSearchParams(await readBody(request))
        const credentials = credentialsFrom(request, form)
        if (credentials === null || credentials.id !== clientId || credentials.secret !== clientSecret) {
          sendJson(response, 401, { error: 'invalid_client' })
          return
        }
        if (behaviour.tokenEndpointInvalidGrant === true) {
          sendJson(response, 400, { error: 'invalid_grant', error_description: 'Code abgelaufen' })
          return
        }
        const code = codes.get(form.get('code') ?? '')
        const verifier = form.get('code_verifier')
        if (
          code === undefined ||
          code.used ||
          Date.now() - code.issuedAt > CODE_TTL_MS ||
          verifier === null ||
          (await pkceChallenge(verifier)) !== code.codeChallenge ||
          form.get('redirect_uri') !== code.redirectUri
        ) {
          sendJson(response, 400, { error: 'invalid_grant' })
          return
        }
        code.used = true
        const accessToken = `access-${randomUUID()}`
        const idToken = await issueIdToken(code)
        issuedTokens.push(accessToken, idToken)
        sendJson(response, 200, {
          token_type: 'Bearer',
          access_token: accessToken,
          expires_in: 300,
          scope: 'openid profile email',
          id_token: idToken,
        })
        return
      }

      if (url.pathname === '/__control' && request.method === 'POST') {
        // Prozessuebergreifende Steuerung fuer die Browsertests: nur der Provider veraendert sein Verhalten.
        behaviour = JSON.parse(await readBody(request)) as ProviderBehaviour
        sendJson(response, 200, { ok: true })
        return
      }

      if (url.pathname === '/logout') {
        const target = url.searchParams.get('post_logout_redirect_uri')
        response.writeHead(302, { location: target ?? issuer })
        response.end()
        return
      }

      sendJson(response, 404, { error: 'not_found' })
    })().catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'server_error' })
      }
      response.end()
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })
  issuer = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

  return {
    issuer,
    clientId,
    clientSecret,
    issuedTokens,
    setBehaviour(next: ProviderBehaviour): void {
      behaviour = next
    },
    resetBehaviour(): void {
      behaviour = {}
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
