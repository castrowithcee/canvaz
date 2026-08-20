/**
 * Erstinbetriebnahme: der erste Systemadmin.
 *
 * Bis zu diesem Task bootstrappte sich der Systemadmin selbst - der erste angemeldete Nutzer einer leeren
 * Instanz bekam die Rolle. Das ist mit einem optionalen Provider kein tragfaehiger Weg mehr: er haengt an
 * einer Anmeldung, und wer als Erster ankommt, entscheidet der Zufall. **Dieser Weg ist deshalb geschlossen;
 * eine Anmeldung vergibt keine Rechte mehr.**
 *
 * Stattdessen ein ausdruecklicher, einmaliger Vorgang auf dem Host: `npm run admin:bootstrap` legt genau
 * einen Systemadmin an und gibt einen befristeten Einladungslink aus. Damit gilt:
 *
 * - **Keine fest codierten Zugangsdaten** im Image und in keiner Konfigurationsvorlage. Das Passwort setzt
 *   der Empfaenger selbst beim Einloesen, und die Anwendung speichert nur dessen Hash.
 * - **Serialisiert.** Die Pruefung "gibt es schon einen Systemadmin?" laeuft unter einer Advisory-Sperre bis
 *   zum Commit; zwei gleichzeitige Aufrufe ergeben nie zwei Administratoren.
 * - **Genau einmal.** Sobald ein Systemadmin existiert, verweigert der Vorgang seine Arbeit. Weitere Konten
 *   entstehen ueber die Systemadministration im Produkt - allerdings **ohne** Systemadminrolle: eine
 *   nachtraegliche Rollenvergabe gibt es in diesem Paket nicht. Eine Instanz hat damit genau einen
 *   Systemadmin, den aus diesem Vorgang.
 */

import type { User } from '../domain/identity/model.js'
import { invitationExpiry } from '../domain/identity/local-auth.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import { IdentityConflictError } from '../domain/identity/repositories.js'
import { createInvitationToken, hashInvitationToken } from './invitations.js'

export type BootstrapResult =
  /** Der Systemadmin ist angelegt. `token` ist der Einladungswert und erscheint genau hier ein einziges Mal. */
  | { readonly kind: 'created'; readonly user: User; readonly token: string; readonly expiresAt: Date }
  /** Diese Instanz hat bereits einen Systemadmin. Weitere Konten entstehen im Produkt, nicht auf dem Host. */
  | { readonly kind: 'already-administered' }
  /** Die Adresse gehoert schon einem Konto - etwa einem ueber den Provider angelegten. */
  | { readonly kind: 'email-taken' }

export async function bootstrapSystemAdmin(
  store: IdentityStore,
  options: { readonly displayName: string; readonly email: string; readonly now: Date },
): Promise<BootstrapResult> {
  const { displayName, email, now } = options
  try {
    return await store.transaction(async (tx): Promise<BootstrapResult> => {
      // Die Sperre haelt bis zum Commit; ein gleichzeitiger Aufruf sieht danach den angelegten Systemadmin.
      if (await tx.users.hasSystemAdmin()) {
        return { kind: 'already-administered' }
      }
      const user = await tx.users.create({ displayName, email }, { isSystemAdmin: true })
      const token = createInvitationToken()
      const expiresAt = invitationExpiry(now)
      await tx.invitations.create({
        userId: user.id,
        tokenHash: hashInvitationToken(token),
        // Kein interner Akteur: dieser eine Vorgang laeuft auf dem Host und nicht im Produkt.
        createdByUserId: null,
        expiresAt,
      })
      return { kind: 'created', user, token, expiresAt }
    })
  } catch (error) {
    if (error instanceof IdentityConflictError) {
      return { kind: 'email-taken' }
    }
    throw error
  }
}
