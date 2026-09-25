/**
 * Drosselung der lokalen Anmeldung je Zielkonto.
 *
 * Die Ratengrenze je Client (`rate-limit.ts`) bremst einen einzelnen Absender. Gegen ein verteiltes
 * Durchprobieren - viele Adressen, ein Konto - hilft sie nicht; dafuer zaehlt diese Grenze je **eingegebener**
 * Adresse, gleich von wo die Versuche kommen (OWASP Credential Stuffing Prevention, NIST SP 800-63B 3.2.2).
 *
 * - **Keine Auskunft ueber Konten.** Gezaehlt wird die normalisierte Eingabe, ob es das Konto gibt oder
 *   nicht. Eine gedrosselte Anmeldung antwortet wie ein falsches Passwort und kostet dieselbe Rechenzeit.
 * - **Keine dauerhafte Sperre.** Ein festes Fenster ab dem ersten Versuch; weitere Versuche verlaengern es
 *   nicht. Danach ist die Drosselung von selbst aufgehoben. Vorzeitig hebt sie eine richtige Anmeldung, die
 *   Einloesung einer Einladung oder Wiederherstellung und die administrative Ruecksetzung auf.
 * - **Uebersteht einen Neustart.** Der Zustand liegt in PostgreSQL (`login_throttle`).
 * - **Keine Adresse in der Datenbank.** Gespeichert wird ein HMAC der Adresse mit dem Sitzungsgeheimnis.
 *
 * Gezaehlt wird **vor** der Pruefung des Passworts und atomar: gleichzeitige Versuche auf dasselbe Konto
 * koennen das Budget nicht dadurch ueberholen, dass alle noch vor der ersten Buchung pruefen.
 */

import { createHmac } from 'node:crypto'

import type { IdentityStore } from '../domain/identity/repositories.js'
import type { AppConfig } from './config.js'

type ThrottleConfig = Pick<AppConfig, 'sessionSecret' | 'authAccountAttempts' | 'authAccountWindowMinutes'>

/** Schluessel eines Kontos. Die Adresse ist bereits normalisiert (`normalizeEmail`). */
export function loginThrottleKey(email: string, sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update(`login-throttle:${email}`).digest('hex')
}

/** Bucht einen Versuch auf das Konto. `false` heisst: das Budget des laufenden Fensters ist erschoepft. */
export async function takeLoginAttempt(
  store: IdentityStore,
  config: ThrottleConfig,
  email: string,
  now: Date,
): Promise<boolean> {
  const windowStart = new Date(now.getTime() - config.authAccountWindowMinutes * 60_000)
  const attempts = await store.loginThrottle.hit(loginThrottleKey(email, config.sessionSecret), now, windowStart)
  return attempts <= config.authAccountAttempts
}

/** Hebt die Drosselung eines Kontos auf. Ein Konto ohne Adresse hat keine lokale Anmeldung und nichts zu heben. */
export async function clearLoginAttempts(
  store: IdentityStore,
  sessionSecret: string,
  email: string | null,
): Promise<void> {
  if (email !== null) {
    await store.loginThrottle.clear(loginThrottleKey(email, sessionSecret))
  }
}
