/**
 * Lokale Konten in Integrationstests.
 *
 * Auch hier gibt es keinen verkuerzten Aufbau: der Systemadmin entsteht ueber genau den Bootstrap, den der
 * Betrieb auf dem Host aufruft (`bootstrapSystemAdmin`), und meldet sich danach ueber die echten Endpunkte
 * an - Einladung einloesen, Cookie annehmen, Profil abrufen. Kein Test setzt ein Adminrecht direkt in die
 * Datenbank.
 */

import { Secret, TOTP } from 'otpauth'

import type { MeResponse, SecondFactorBackupCodesResponse, SecondFactorEnrollResponse } from '../../src/contracts/api.js'
import {
  AUTH_INVITATION_REDEEM_PATH,
  AUTH_LOCAL_LOGIN_PATH,
  AUTH_LOCAL_PASSWORD_PATH,
  AUTH_SECOND_FACTOR_CONFIRM_PATH,
  AUTH_SECOND_FACTOR_ENROLL_PATH,
  AUTH_SECOND_FACTOR_VERIFY_PATH,
  CSRF_HEADER,
  ME_PATH,
} from '../../src/contracts/api.js'
import { bootstrapSystemAdmin } from '../../src/server/bootstrap-admin.js'
import { INVITE_APP_PATH } from '../../src/contracts/api.js'
import { createJar } from './browser-client.js'
import type { Jar } from './browser-client.js'
import type { TestApp } from './test-app.js'

export type Account = { readonly jar: Jar; readonly profile: MeResponse }

/** Der Systemadmin mit eingerichtetem zweitem Faktor: Geheimnis und Ersatzcodes fuer weitere Anmeldungen. */
export type AdminAccount = Account & { readonly totpSecret: string; readonly backupCodes: readonly string[] }

/** Passwort der Testkonten. Lang genug fuer die Untergrenze und ohne jede Bedeutung. */
export const TEST_PASSWORD = 'test-passwort-1234'

function erwarte(bedingung: boolean, meldung: string): void {
  if (!bedingung) {
    throw new Error(meldung)
  }
}

export function post(app: TestApp, jar: Jar, path: string, body: unknown): Promise<Response> {
  return jar.fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function localLogin(app: TestApp, jar: Jar, email: string, password: string): Promise<Response> {
  return post(app, jar, AUTH_LOCAL_LOGIN_PATH, { email, password })
}

export function changePassword(
  app: TestApp,
  jar: Jar,
  change: { readonly email: string; readonly currentPassword: string; readonly newPassword: string },
): Promise<Response> {
  return post(app, jar, AUTH_LOCAL_PASSWORD_PATH, change)
}

export function redeemInvitation(app: TestApp, jar: Jar, token: string, password: string): Promise<Response> {
  return post(app, jar, AUTH_INVITATION_REDEEM_PATH, { token, password })
}

/** Der Einladungswert steht im Fragment der Adresse - genau wie beim Gastlink. */
export function tokenOfInvitationUrl(url: string): string {
  const [pfad = '', token = ''] = url.split('#')
  erwarte(pfad.endsWith(INVITE_APP_PATH), `Unerwartete Einladungsadresse: ${url}`)
  erwarte(token.length > 0, 'Die Einladungsadresse traegt kein Token')
  return token
}

export async function profileOf(app: TestApp, jar: Jar): Promise<MeResponse> {
  const response = await jar.fetch(`${app.baseUrl}${ME_PATH}`)
  erwarte(response.status === 200, `Profilabruf antwortete mit ${String(response.status)}`)
  return (await response.json()) as MeResponse
}

/** Der Code einer Authenticator-App zu diesem Zeitpunkt - dieselben Parameter wie im Server. */
export function totpCode(secret: string, at: Date): string {
  return TOTP.generate({ secret: Secret.fromBase32(secret), timestamp: at.getTime() })
}

/** Ein zustandsaendernder Aufruf mit dem CSRF-Token der aktuellen Sitzung. */
export async function postWithCsrf(app: TestApp, jar: Jar, path: string, body: unknown): Promise<Response> {
  const { csrfToken } = await profileOf(app, jar)
  return jar.fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: csrfToken },
    body: JSON.stringify(body),
  })
}

/**
 * Richtet den zweiten Faktor ueber die echten Endpunkte ein - genau wie die Oberflaeche: Einrichtung
 * beginnen, Code der "App" bestaetigen. Danach traegt `jar` eine Sitzung mit Nachweis.
 */
export async function completeSecondFactorSetup(
  app: TestApp,
  jar: Jar,
): Promise<{ readonly totpSecret: string; readonly backupCodes: readonly string[] }> {
  const begonnen = await postWithCsrf(app, jar, AUTH_SECOND_FACTOR_ENROLL_PATH, {})
  erwarte(begonnen.status === 200, `Einrichtung antwortete mit ${String(begonnen.status)}`)
  const { secret } = (await begonnen.json()) as SecondFactorEnrollResponse
  const bestaetigt = await postWithCsrf(app, jar, AUTH_SECOND_FACTOR_CONFIRM_PATH, {
    code: totpCode(secret, app.context.now()),
  })
  erwarte(bestaetigt.status === 200, `Bestaetigung antwortete mit ${String(bestaetigt.status)}`)
  const { backupCodes } = (await bestaetigt.json()) as SecondFactorBackupCodesResponse
  return { totpSecret: secret, backupCodes }
}

/** Belegt den zweiten Faktor einer eingeschraenkten Sitzung mit einem Code oder Ersatzcode. */
export function verifySecondFactor(app: TestApp, jar: Jar, code: string): Promise<Response> {
  return postWithCsrf(app, jar, AUTH_SECOND_FACTOR_VERIFY_PATH, { code })
}

/**
 * Der Bootstrap-Systemadmin dieser Instanz, angemeldet.
 *
 * Er entsteht ueber die Bootstrap-Funktion des Betriebs, loest seine Einladung ueber den echten Endpunkt ein
 * und richtet danach seinen zweiten Faktor ein - ohne ihn waere die Sitzung eingeschraenkt. Danach traegt
 * er eine gewoehnliche Sitzung mit Nachweis und CSRF-Token.
 */
export async function signedInAsSystemAdmin(
  app: TestApp,
  options: { readonly displayName?: string; readonly email?: string; readonly password?: string } = {},
): Promise<AdminAccount> {
  const password = options.password ?? TEST_PASSWORD
  const result = await bootstrapSystemAdmin(app.store, {
    displayName: options.displayName ?? 'Root',
    email: options.email ?? 'root@example.com',
    now: app.context.now(),
  })
  erwarte(result.kind === 'created', `Bootstrap lieferte ${result.kind}`)
  const jar = createJar()
  const token = result.kind === 'created' ? result.token : ''
  const redeemed = await redeemInvitation(app, jar, token, password)
  erwarte(redeemed.status === 200, `Einloesen antwortete mit ${String(redeemed.status)}`)
  const factor = await completeSecondFactorSetup(app, jar)
  return { jar, profile: await profileOf(app, jar), ...factor }
}
