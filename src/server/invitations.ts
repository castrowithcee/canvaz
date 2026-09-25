/**
 * Einladungswerte.
 *
 * Dieselbe Bauweise wie beim Freigabetoken eines Boards: 32 zufaellige Bytes, base64url kodiert, gespeichert
 * ausschliesslich als SHA-256-Hash. 256 Bit sind gegen Raten nicht zu ueberwinden; kurz genug zum Merken
 * soll ein Einladungslink ausdruecklich nicht sein.
 *
 * Der Wert steht genau einmal in einer Antwort - der der Anlage - und danach nirgends mehr: nicht in der
 * Datenbank, nicht in einem Protokoll, nicht in einem Auditereignis. Die Adresse traegt ihn im **Fragment**
 * (`/einladung#<token>`), das der Browser gar nicht erst mitsendet.
 */

import { randomBytes } from 'node:crypto'

import {
  INVITE_APP_PATH,
  PASSWORD_RESET_APP_PATH,
  RECOVERY_APP_PATH,
  RECOVERY_EMAIL_CONFIRM_APP_PATH,
} from '../contracts/api.js'
import { hashSessionToken } from './session.js'

const TOKEN_BYTES = 32

export function createInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** Dasselbe Verfahren wie beim Sitzungsgeheimnis: gespeichert wird ausschliesslich der Hash. */
export function hashInvitationToken(token: string): string {
  return hashSessionToken(token)
}

export function invitationUrl(baseUrl: string, token: string): string {
  return `${new URL(INVITE_APP_PATH, baseUrl).href}#${token}`
}

/** Adresse des Wiederherstellungswerts; der Wert steht wie bei der Einladung im Fragment. */
export function recoveryUrl(baseUrl: string, token: string): string {
  return `${new URL(RECOVERY_APP_PATH, baseUrl).href}#${token}`
}

/** Links der Selbstwiederherstellung: derselbe Wert, dieselbe Bauweise, eigene Adresse. */
export function passwordResetUrl(baseUrl: string, token: string): string {
  return `${new URL(PASSWORD_RESET_APP_PATH, baseUrl).href}#${token}`
}

export function recoveryEmailConfirmUrl(baseUrl: string, token: string): string {
  return `${new URL(RECOVERY_EMAIL_CONFIRM_APP_PATH, baseUrl).href}#${token}`
}
