/**
 * Treibt den vollstaendigen Anmeldefluss ohne Browser.
 *
 * Jeder Schritt entspricht dem, was ein Browser taete: Weiterleitung zum Provider, Entscheidung im
 * Anmeldeformular, Rueckkehr auf die Redirect-URI. Es wird nichts uebersprungen und nichts vorgetaeuscht.
 */

import { AUTH_LOGIN_PATH, LOGIN_ERROR_PARAM } from '../../src/contracts/api.js'
import type { LoginErrorCode } from '../../src/contracts/api.js'
import type { Jar } from './browser-client.js'
import type { TestApp } from './test-app.js'

export type TestIdentity = {
  readonly subject: string
  readonly email?: string
  readonly name?: string
}

function locationOf(response: Response): string {
  const location = response.headers.get('location')
  if (location === null) {
    throw new Error(`Antwort ${String(response.status)} ohne Location-Header`)
  }
  return location
}

/** Schritt 1: Der Anwendungsserver leitet auf den Provider und legt den transienten Flow-Zustand ab. */
export async function startLogin(app: TestApp, jar: Jar): Promise<string> {
  const response = await jar.fetch(`${app.baseUrl}${AUTH_LOGIN_PATH}`)
  if (response.status !== 302) {
    throw new Error(`Login-Einstieg antwortete mit ${String(response.status)}`)
  }
  return locationOf(response)
}

/** Schritte 2 und 3: Anmeldeformular des Providers holen und entscheiden. Liefert die Callback-URL. */
export async function decideAtProvider(
  jar: Jar,
  authorizationUrl: string,
  identity: TestIdentity,
  decision: 'approve' | 'deny' = 'approve',
): Promise<string> {
  const page = await fetch(authorizationUrl)
  const html = await page.text()
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1]
  if (requestId === undefined) {
    throw new Error('Der Test-Provider hat kein Anmeldeformular geliefert')
  }
  const issuer = new URL(authorizationUrl).origin
  const form = new URLSearchParams({
    request_id: requestId,
    subject: identity.subject,
    email: identity.email ?? `${identity.subject}@example.com`,
    name: identity.name ?? identity.subject,
    decision,
  })
  const response = await fetch(`${issuer}/authorize/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  })
  return locationOf(response)
}

/** Schritt 4: Rueckkehr auf die Redirect-URI. Liefert das Ziel der abschliessenden Weiterleitung. */
export async function finishLogin(jar: Jar, callbackUrl: string): Promise<URL> {
  const response = await jar.fetch(callbackUrl)
  if (response.status !== 302) {
    throw new Error(`Callback antwortete mit ${String(response.status)}`)
  }
  return new URL(locationOf(response))
}

export type LoginResult = {
  readonly target: URL
  readonly error: LoginErrorCode | null
}

export async function login(
  app: TestApp,
  jar: Jar,
  identity: TestIdentity,
  decision: 'approve' | 'deny' = 'approve',
): Promise<LoginResult> {
  const authorizationUrl = await startLogin(app, jar)
  const callbackUrl = await decideAtProvider(jar, authorizationUrl, identity, decision)
  const target = await finishLogin(jar, callbackUrl)
  return { target, error: target.searchParams.get(LOGIN_ERROR_PARAM) as LoginErrorCode | null }
}
