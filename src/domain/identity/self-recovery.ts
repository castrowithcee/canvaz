/**
 * Selbstwiederherstellung eines lokalen Passworts ueber eine bestaetigte Wiederherstellungsadresse.
 *
 * Reiner Domain-Core: keine Datenbank, kein HTTP, keine Kryptografie. Hier steht, **wer** den Weg nutzen
 * darf und wie lange ein Link gilt; Versand, Hash und Einloesung liegen im Server
 * (`src/server/self-recovery-routes.ts`).
 *
 * Zwei getrennte Merkmale tragen den Weg: die **Freischaltung** durch den Systemadmin und die **bestaetigte**
 * Wiederherstellungsadresse des Inhabers. Erst beides zusammen, dazu ein aktives Konto mit lokalem Passwort
 * und ohne Systemadminrolle, ergibt einen Ruecksetzungslink. Der Systemadmin hat ausschliesslich den
 * Betreiberweg (`admin:recover`).
 */

import type { User, UserId } from './model.js'

export type RecoveryEmailTokenPurpose = 'confirm' | 'reset'

/** Stand eines Kontos. Ohne Zeile: nicht freigeschaltet, keine Adresse. */
export type SelfRecovery = {
  readonly userId: UserId
  readonly allowed: boolean
  /** Bestaetigte Wiederherstellungsadresse; `null` heisst: keine bestaetigt. */
  readonly email: string | null
  readonly verifiedAt: Date | null
}

/** Bestaetigungs- oder Ruecksetzungslink. Der Hash steht wie bei der Einladung nicht im Modell. */
export type RecoveryEmailToken = {
  readonly id: string
  readonly userId: UserId
  readonly purpose: RecoveryEmailTokenPurpose
  /** Die Adresse, an die der Link ging. */
  readonly email: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly redeemedAt: Date | null
  readonly revokedAt: Date | null
}

/**
 * Frist eines Ruecksetzungslinks. Kurz, weil er ohne jede weitere Pruefung ein Passwort setzt; wer ihn
 * verpasst, fordert nach Ablauf einen neuen an.
 */
export const PASSWORD_RESET_TTL_MINUTES = 15

export function passwordResetExpiry(now: Date): Date {
  return new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000)
}

/**
 * Frist eines Bestaetigungslinks. Er belegt nur den Besitz einer Adresse, die der angemeldete Inhaber mit
 * seinem Passwort eingetragen hat, und darf deshalb laenger liegen als ein Ruecksetzungslink.
 */
export const RECOVERY_EMAIL_CONFIRM_TTL_HOURS = 24

export function recoveryEmailConfirmExpiry(now: Date): Date {
  return new Date(now.getTime() + RECOVERY_EMAIL_CONFIRM_TTL_HOURS * 3600 * 1000)
}

/** Warum ein Konto keinen Ruecksetzungslink bekommt. Nur fuer das Protokoll, nie fuer eine Antwort. */
export type SelfResetDenial =
  | 'unknown-account'
  | 'user-deactivated'
  | 'system-admin'
  | 'no-local-password'
  | 'not-allowed'
  | 'not-verified'

/**
 * Darf der Systemadmin dieses Konto freischalten? Nur ein aktives Konto mit lokalem Passwort und ohne
 * Systemadminrolle; ein reines OIDC-Konto hat kein Passwort, das sich zuruecksetzen liesse.
 */
export function selfRecoveryAllowable(
  user: User,
  hasPassword: boolean,
): 'ok' | Exclude<SelfResetDenial, 'unknown-account' | 'not-allowed' | 'not-verified'> {
  if (user.isSystemAdmin) {
    return 'system-admin'
  }
  if (user.status !== 'active') {
    return 'user-deactivated'
  }
  return hasPassword ? 'ok' : 'no-local-password'
}

/**
 * Die eine Regel fuer Anfrage und Einloesung: freischaltbar, freigeschaltet und mit bestaetigter Adresse.
 * Liefert die Adresse, an die der Link geht.
 */
export function selfResetTarget(
  user: User | null,
  hasPassword: boolean,
  recovery: SelfRecovery | null,
): { readonly ok: true; readonly email: string } | { readonly ok: false; readonly reason: SelfResetDenial } {
  if (user === null) {
    return { ok: false, reason: 'unknown-account' }
  }
  const allowable = selfRecoveryAllowable(user, hasPassword)
  if (allowable !== 'ok') {
    return { ok: false, reason: allowable }
  }
  if (recovery === null || !recovery.allowed) {
    return { ok: false, reason: 'not-allowed' }
  }
  return recovery.email === null ? { ok: false, reason: 'not-verified' } : { ok: true, email: recovery.email }
}
