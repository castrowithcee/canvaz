/**
 * Just-in-time-Provisionierung.
 *
 * Reine Funktionen ohne IO: aus bereits verifizierten Claims wird ein fachliches Profil abgeleitet und
 * entschieden, was mit dem Nutzer geschieht. Der OIDC-Callback liefert die Claims und fuehrt die
 * Entscheidung mit den Repositories aus; die Regel selbst bleibt hier und ist ohne Netzwerk testbar.
 */

import type { ExternalIdentity, ExternalIdentityKey, User, UserId } from './model.js'
import { isUserActive } from './model.js'

/** Aus dem verifizierten ID-Token abgeleitete Claims. Der Aufrufer garantiert die Signaturpruefung. */
export type IdentityClaims = {
  readonly issuer: string
  readonly subject: string
  readonly email: string | null
  readonly name: string | null
  readonly preferredUsername: string | null
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Liest die Claims eines verifizierten Tokens in die fachliche Form. `null` bedeutet: `iss` oder `sub`
 * fehlen, also gibt es keine belastbare Zuordnung und die Anmeldung wird abgelehnt.
 */
export function parseIdentityClaims(raw: unknown): IdentityClaims | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }
  const claims = raw as Record<string, unknown>
  const issuer = trimmedString(claims['iss'])
  const subject = trimmedString(claims['sub'])
  if (issuer === null || subject === null) {
    return null
  }
  const rawEmail = trimmedString(claims['email'])
  // Eine unbestaetigte Adresse wird nicht als Profilmerkmal uebernommen; sie waere fremd befuellbar.
  const email = rawEmail !== null && claims['email_verified'] !== false ? rawEmail.toLowerCase() : null
  return {
    issuer,
    subject,
    email,
    name: trimmedString(claims['name']),
    preferredUsername: trimmedString(claims['preferred_username']),
  }
}

export type UserProfileDraft = {
  readonly displayName: string
  readonly email: string | null
}

/** Der Anzeigename faellt geordnet zurueck, damit er nie leer ist. */
export function deriveUserProfile(claims: IdentityClaims): UserProfileDraft {
  const emailLocalPart = claims.email === null ? null : (claims.email.split('@')[0] ?? null)
  const displayName = claims.name ?? claims.preferredUsername ?? emailLocalPart ?? claims.subject
  return { displayName, email: claims.email }
}

export type ProvisioningDecision =
  /** Unbekannte externe Identitaet: Nutzer anlegen und Identitaet damit verknuepfen. */
  | { readonly kind: 'provision'; readonly key: ExternalIdentityKey; readonly profile: UserProfileDraft; readonly isSystemAdmin: boolean }
  /** Bekannte Identitaet eines aktiven Nutzers: Profil aus den Claims auffrischen. */
  | { readonly kind: 'refresh'; readonly userId: UserId; readonly identity: ExternalIdentity; readonly profile: UserProfileDraft }
  /** Serverseitige Ablehnung. Die UI darf sie anzeigen, aber nicht umgehen. */
  | { readonly kind: 'deny'; readonly reason: 'user-deactivated' }

export type ProvisioningContext = {
  /** Wahr, solange die Instanz keinen Nutzer hat. Der erste angemeldete Nutzer bootstrappt den Systemadmin. */
  readonly isFirstUser: boolean
}

export function decideProvisioning(
  claims: IdentityClaims,
  linked: { readonly identity: ExternalIdentity; readonly user: User } | null,
  context: ProvisioningContext,
): ProvisioningDecision {
  const profile = deriveUserProfile(claims)
  if (linked === null) {
    return {
      kind: 'provision',
      key: { issuer: claims.issuer, subject: claims.subject },
      profile,
      isSystemAdmin: context.isFirstUser,
    }
  }
  if (!isUserActive(linked.user)) {
    return { kind: 'deny', reason: 'user-deactivated' }
  }
  return { kind: 'refresh', userId: linked.user.id, identity: linked.identity, profile }
}
