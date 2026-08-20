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
  // Nur eine ausdruecklich bestaetigte Adresse wird uebernommen; jede andere waere fremd befuellbar. Ein
  // fehlender `email_verified`-Claim ist keine Bestaetigung und zaehlt wie `false`.
  const email = rawEmail !== null && claims['email_verified'] === true ? rawEmail.toLowerCase() : null
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
  /**
   * Unbekannte externe Identitaet ohne passendes Profil: Nutzer anlegen und Identitaet damit verknuepfen.
   *
   * **Nie mit Systemadminrechten.** Die einzige Rolle dieses Pakets entsteht ausschliesslich beim einmaligen
   * Bootstrap der Instanz; der Anmeldeweg entscheidet allein die Identitaet.
   */
  | { readonly kind: 'provision'; readonly key: ExternalIdentityKey; readonly profile: UserProfileDraft }
  /**
   * Unbekannte externe Identitaet, aber ein vorhandenes Profil mit derselben bestaetigten Adresse **und
   * ohne bisherige externe Identitaet**: die Identitaet wird mit diesem Profil verknuepft, statt ein
   * zweites anzulegen.
   *
   * Das ist die Stelle, an der beide Anmeldewege zusammenlaufen: ein administrativ angelegtes Konto und die
   * externe Anmeldung derselben Person fuehren auf dasselbe Profil - mit denselben Rechten und ohne dass
   * eine zweite Zeile entsteht. Bestaetigt heisst `email_verified`; eine unbestaetigte Adresse kommt aus
   * `parseIdentityClaims` gar nicht erst heraus.
   *
   * Die Verknuepfung ist **einmalig je Profil**. Traegt das Profil bereits eine externe Identitaet, ist die
   * Adresse als Zuordnung verbraucht: ein zweites, fremdes `sub` mit derselben Adresse wuerde sonst das
   * Konto samt seiner Rolle uebernehmen, und beim Provider genuegt dafuer eine Adresse, die niemand hier
   * kontrolliert.
   */
  | { readonly kind: 'link'; readonly userId: UserId; readonly key: ExternalIdentityKey; readonly profile: UserProfileDraft }
  /** Bekannte Identitaet eines aktiven Nutzers: Profil aus den Claims auffrischen. */
  | { readonly kind: 'refresh'; readonly userId: UserId; readonly identity: ExternalIdentity; readonly profile: UserProfileDraft }
  /**
   * Serverseitige Ablehnung. Die UI darf sie anzeigen, aber nicht umgehen.
   *
   * `email-already-linked`: die Adresse gehoert zu einem Profil, das bereits ueber eine andere externe
   * Identitaet erreichbar ist. Weder Uebernahme noch zweites Profil - die Zuordnung ist eine Sache der
   * Systemadministration und keine Folge dessen, welche Adresse ein Provider ausliefert.
   */
  | { readonly kind: 'deny'; readonly reason: 'user-deactivated' | 'email-already-linked' }

export type ProvisioningContext = {
  /**
   * Vorhandenes Profil mit derselben bestaetigten Adresse, sonst `null`. Es entscheidet zwischen Anlage und
   * Verknuepfung.
   */
  readonly existingByEmail: User | null
  /**
   * Traegt dieses Profil bereits eine externe Identitaet? Dann ist die neue keine Verknuepfung, sondern eine
   * Uebernahme - und wird abgelehnt. Ohne `existingByEmail` bedeutungslos.
   */
  readonly existingHasExternalIdentity: boolean
}

/**
 * Ein vorhandenes Profil verliert seine Adresse nicht, nur weil ein Token diesmal keine bestaetigte
 * mitbringt: die Adresse ist zugleich der lokale Anmeldename, und ein stiller Verlust waere ein
 * ausgesperrtes Konto.
 */
function keepKnownEmail(profile: UserProfileDraft, user: User): UserProfileDraft {
  return profile.email === null ? { ...profile, email: user.email } : profile
}

export function decideProvisioning(
  claims: IdentityClaims,
  linked: { readonly identity: ExternalIdentity; readonly user: User } | null,
  context: ProvisioningContext,
): ProvisioningDecision {
  const profile = deriveUserProfile(claims)
  const key = { issuer: claims.issuer, subject: claims.subject }
  if (linked !== null) {
    if (!isUserActive(linked.user)) {
      return { kind: 'deny', reason: 'user-deactivated' }
    }
    return {
      kind: 'refresh',
      userId: linked.user.id,
      identity: linked.identity,
      profile: keepKnownEmail(profile, linked.user),
    }
  }
  if (context.existingByEmail !== null) {
    // Zuerst die Uebernahme ausschliessen: der Anfragende ist hier nicht der Inhaber des Kontos, und die
    // vagere Ablehnung verraet ihm auch dessen Status nicht.
    if (context.existingHasExternalIdentity) {
      return { kind: 'deny', reason: 'email-already-linked' }
    }
    if (!isUserActive(context.existingByEmail)) {
      return { kind: 'deny', reason: 'user-deactivated' }
    }
    return {
      kind: 'link',
      userId: context.existingByEmail.id,
      key,
      profile: keepKnownEmail(profile, context.existingByEmail),
    }
  }
  return { kind: 'provision', key, profile }
}
