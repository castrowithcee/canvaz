/**
 * Ratengrenze der HTTP-API je Client.
 *
 * Die Echtzeitstrecke begrenzt ihre Nachrichtenrate bereits im Boardraum; die HTTP-Seite hatte bisher keine
 * Grenze. Sie steht in der Anwendung und nicht im Reverse Proxy, damit sie unabhaengig davon gilt, welcher
 * Proxy vor der Instanz steht - und damit sie in derselben Sprache begrenzt, in der die Endpunkte gedacht
 * sind.
 *
 * Verfahren ist derselbe Eimer wie im Boardraum: eine Marke je Anfrage, gleichmaessige Nachfuellung. Ein
 * kurzer Ausschlag - eine geladene Boardliste, ein Import - passt vollstaendig hinein, eine anhaltende Flut
 * nicht.
 */

import type { IncomingMessage } from 'node:http'

import { resolveClientAddress } from './client-address.js'

export type RateLimiter = {
  /** `true`, wenn die Anfrage laufen darf. `false` heisst: Grenze erreicht. */
  take(client: string): boolean
}

/**
 * Hoechstzahl gleichzeitig gefuehrter Clients.
 *
 * Ohne Grenze waere die Tabelle selbst der Angriffspunkt: viele Herkunftsadressen, viel Speicher. Ist sie
 * voll, fallen zuerst die vollstaendig aufgefuellten Eimer heraus - das sind genau die Clients, die aktuell
 * nichts tun.
 */
const MAX_TRACKED_CLIENTS = 4096

const MILLISECONDS_PER_MINUTE = 60_000

export function createRateLimiter(options: {
  readonly perMinute: number
  readonly now?: () => number
}): RateLimiter {
  const now = options.now ?? (() => Date.now())
  const capacity = options.perMinute
  const perMillisecond = capacity / MILLISECONDS_PER_MINUTE
  const buckets = new Map<string, { tokens: number; updatedAt: number }>()

  function prune(): void {
    for (const [client, bucket] of buckets) {
      if (bucket.tokens >= capacity) {
        buckets.delete(client)
      }
    }
  }

  return {
    take(client: string): boolean {
      const at = now()
      const bucket = buckets.get(client) ?? { tokens: capacity, updatedAt: at }
      bucket.tokens = Math.min(capacity, bucket.tokens + (at - bucket.updatedAt) * perMillisecond)
      bucket.updatedAt = at
      const allowed = bucket.tokens >= 1
      if (allowed) {
        bucket.tokens -= 1
      }
      if (!buckets.has(client) && buckets.size >= MAX_TRACKED_CLIENTS) {
        prune()
      }
      buckets.set(client, bucket)
      return allowed
    },
  }
}

/**
 * Wen die Grenze zaehlt.
 *
 * Hinter einem Reverse Proxy sieht die Anwendung sonst nur den Proxy und wuerde alle Clients in einen Eimer
 * werfen. Deshalb der **letzte** Eintrag aus `x-forwarded-for`: der Proxy haengt die Adresse an, von der er
 * die Anfrage tatsaechlich entgegengenommen hat. Ein vom Client selbst gesetzter Kopfzeileninhalt steht
 * davor und kann die eigene Zaehlung damit nicht verwaessern.
 *
 * Ohne `CANVAZ_TRUSTED_PROXY` wird die Kopfzeile gar nicht gelesen - ohne Proxy waere sie frei erfunden.
 *
 * Die Ermittlung selbst steht in `client-address.ts` (`resolveClientAddress`), zusammen mit ihrer
 * Klassifizierung fuer die Systemadministration und den Plausibilitaetshinweis. Diese Funktion nimmt davon
 * nur die Adresse - die Ratengrenze braucht keine Klasse.
 */
export function clientKey(request: IncomingMessage, trustedProxy: boolean): string {
  return resolveClientAddress(request, trustedProxy).address
}
