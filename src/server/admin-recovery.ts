/**
 * Wiederherstellung des Systemadminzugangs per Betreiberbefehl.
 *
 * Eine Instanz hat genau einen Systemadmin (siehe `bootstrap-admin.ts`). Verliert er seinen Zugang, stellt
 * ihn ein Betreiber mit Shellzugang wieder her - ohne SQL von Hand, ohne neue Rolle und ohne dauerhaftes
 * Masterpasswort. Der Vorgang laeuft ausschliesslich auf dem Host (`admin-recover-cli.ts`); es gibt keinen
 * HTTP-Endpunkt, der ihn ausloest.
 *
 * In **einer** Transaktion:
 *
 * - Der einzige Systemadmin wird serverseitig ermittelt. Keiner oder mehrere: Abbruch ohne Aenderung.
 * - Jede Sitzung des Kontos wird widerrufen. HTTP und neue WebSocket-Verbindungen scheitern sofort, offene
 *   Verbindungen beendet die Nachpruefung des Verbindungsregisters (`realtime.ts`).
 * - Jede offene Einladung und jeder offene Wiederherstellungswert des Kontos wird widerrufen.
 * - Eine laufende Drosselung des Kontos (`login-throttle.ts`, beide Stufen) wird aufgehoben.
 * - Ein neuer, zufaelliger Wert entsteht, gespeichert nur als Hash, genau einmal einloesbar und kurz
 *   befristet (`RECOVERY_TTL_MINUTES`).
 *
 * **Serialisiert** ueber dieselbe Advisory-Sperre wie der Bootstrap: zwei gleichzeitige Aufrufe laufen
 * nacheinander, und der zweite widerruft den Wert des ersten. Es gibt nie zwei gleichzeitig gueltige Werte.
 *
 * Eingeloest wird ueber den Weg jeder Einladung: der Empfaenger setzt sein Passwort selbst, Rolle,
 * Status und Mitgliedschaften bleiben unveraendert. Am Zweck `recovery` der eingeloesten Zeile haengt, was
 * nur eine Wiederherstellung darf: sie entfernt den zweiten Faktor samt Ersatzcodes, und die naechste
 * Anmeldung fuehrt zu dessen Neueinrichtung. Der Befehl selbst laesst den Faktor stehen - ohne Einloesung
 * aendert sich daran nichts.
 */

import type { User } from '../domain/identity/model.js'
import { isUserActive } from '../domain/identity/model.js'
import { recoveryExpiry } from '../domain/identity/local-auth.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import { createInvitationToken, hashInvitationToken } from './invitations.js'
import { clearLoginAttempts, clearSecondFactorAttempts } from './login-throttle.js'

export type RecoveryResult =
  /** `token` ist der Wiederherstellungswert und erscheint genau hier ein einziges Mal. */
  | { readonly kind: 'issued'; readonly user: User; readonly token: string; readonly expiresAt: Date }
  /** Die Instanz hat noch keinen Systemadmin - dafuer ist der Bootstrap da. */
  | { readonly kind: 'no-admin' }
  /** Mehr als ein Systemadmin: welches Konto gemeint ist, entscheidet der Befehl nicht. */
  | { readonly kind: 'ambiguous'; readonly count: number }
  /** Das Konto ist deaktiviert; ein Link darauf liesse sich nicht einloesen. */
  | { readonly kind: 'deactivated' }

export async function recoverSystemAdmin(
  store: IdentityStore,
  /** `sessionSecret` bildet den Schluessel der Drosselung; derselbe Wert, mit dem die Anwendung laeuft. */
  options: { readonly now: Date; readonly sessionSecret: string },
): Promise<RecoveryResult> {
  const { now, sessionSecret } = options
  return store.transaction(async (tx): Promise<RecoveryResult> => {
    // Die Sperre haelt bis zum Commit; ein gleichzeitiger Aufruf wartet hier.
    const admins = await tx.users.listSystemAdmins()
    const [admin] = admins
    if (admin === undefined) {
      return { kind: 'no-admin' }
    }
    if (admins.length > 1) {
      return { kind: 'ambiguous', count: admins.length }
    }
    if (!isUserActive(admin)) {
      return { kind: 'deactivated' }
    }
    await tx.sessions.revokeAllForUser(admin.id, now)
    await tx.invitations.revokeOpenForUser(admin.id, now)
    await clearLoginAttempts(tx, sessionSecret, admin.email)
    await clearSecondFactorAttempts(tx, sessionSecret, admin.id)
    const token = createInvitationToken()
    const expiresAt = recoveryExpiry(now)
    await tx.invitations.create({
      userId: admin.id,
      tokenHash: hashInvitationToken(token),
      // Kein interner Akteur: der Vorgang laeuft auf dem Host und nicht im Produkt.
      createdByUserId: null,
      expiresAt,
      purpose: 'recovery',
    })
    return { kind: 'issued', user: admin, token, expiresAt }
  })
}
