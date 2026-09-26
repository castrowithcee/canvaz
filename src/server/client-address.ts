/**
 * Echte Client-Adresse: Ermittlung, Klassifizierung und ein Plausibilitaetshinweis - deploymentunabhaengig
 * von Docker rootful/rootless und vom eingesetzten Reverse Proxy.
 *
 * Die Ermittlung ist dieselbe wie in `rate-limit.ts` (`clientKey`): mit `CANVAZ_TRUSTED_PROXY` der letzte
 * Eintrag aus `x-forwarded-for`, sonst die Verbindungsadresse. Diese Datei ist der einzige Ort, an dem sie
 * steht; `clientKey` ruft sie nur noch auf, damit es keine zweite Ermittlung gibt.
 *
 * **Was hier nirgends steht:** eine Adresse selbst. Weder diese Datei noch ihr Aufrufer speichern oder
 * loggen eine ermittelte Adresse - nur ihre Klasse und Zaehlwerte darueber. Das Datenschutzprinzip gilt
 * unveraendert: eine Adresse dient ausschliesslich der Sicherheit des laufenden Anmeldewegs.
 */

import { BlockList, isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'

import type { Logger } from './log.js'

/**
 * Klasse einer ermittelten Adresse.
 *
 * `proxy` heisst: das ist nicht der Client, sondern der unmittelbare Gegenpart der Verbindung - siehe
 * `resolveClientAddress`. `unknown` heisst: die ermittelte Zeichenkette ist keine gueltige IPv4- oder
 * IPv6-Adresse (etwa `unbekannt`, wenn der Socket keine Adresse mehr hat).
 */
export type AddressClass = 'public' | 'private' | 'loopback' | 'proxy' | 'unknown'

export type ClientAddress = {
  readonly address: string
  readonly class: AddressClass
}

const IPV4_MAPPED_PREFIX = '::ffff:'

/** IPv4-gemappte IPv6-Adressen (`::ffff:a.b.c.d`) auf ihre IPv4-Form zurueckfuehren; alles andere bleibt unveraendert. */
function normalizeAddress(address: string): string {
  if (address.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)) {
    const candidate = address.slice(IPV4_MAPPED_PREFIX.length)
    if (isIP(candidate) === 4) {
      return candidate
    }
  }
  return address
}

/**
 * Private Bereiche: RFC 1918 (IPv4), CGNAT (RFC 6598, `100.64.0.0/10` - der Bereich, in dem RootlessKits
 * `slirp4netns` und viele Provider-NAT-Gateways die Gegenseite sehen), Link-Local (RFC 3927 und RFC 4291)
 * und die IPv6-ULA (RFC 4193).
 */
const PRIVATE_RANGES = new BlockList()
PRIVATE_RANGES.addSubnet('10.0.0.0', 8, 'ipv4')
PRIVATE_RANGES.addSubnet('172.16.0.0', 12, 'ipv4')
PRIVATE_RANGES.addSubnet('192.168.0.0', 16, 'ipv4')
PRIVATE_RANGES.addSubnet('100.64.0.0', 10, 'ipv4')
PRIVATE_RANGES.addSubnet('169.254.0.0', 16, 'ipv4')
PRIVATE_RANGES.addSubnet('fc00::', 7, 'ipv6')
PRIVATE_RANGES.addSubnet('fe80::', 10, 'ipv6')

const LOOPBACK_RANGES = new BlockList()
LOOPBACK_RANGES.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK_RANGES.addSubnet('::1', 128, 'ipv6')

/** Klasse einer einzelnen Adresse ohne Ruecksicht auf Proxy oder Herkunft der Kopfzeile. */
function baseClass(address: string): 'public' | 'private' | 'loopback' | 'unknown' {
  const normalized = normalizeAddress(address)
  const family = isIP(normalized)
  if (family === 0) {
    return 'unknown'
  }
  const type = family === 4 ? 'ipv4' : 'ipv6'
  if (LOOPBACK_RANGES.check(normalized, type)) {
    return 'loopback'
  }
  if (PRIVATE_RANGES.check(normalized, type)) {
    return 'private'
  }
  return 'public'
}

/** Letzter Eintrag aus `x-forwarded-for`, oder `null` ohne oder mit leerer Kopfzeile. */
function lastForwarded(request: IncomingMessage): string | null {
  const forwarded = request.headers['x-forwarded-for']
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')
  const last = chain.split(',').at(-1)?.trim() ?? ''
  return last === '' ? null : last
}

/**
 * Adresse und Klasse der aktuellen Anfrage.
 *
 * Ohne `CANVAZ_TRUSTED_PROXY` ist die Verbindungsadresse bereits die ganze Antwort - eine Kopfzeile waere
 * ohne Proxy frei erfunden. Mit ihm ist die Verbindungsadresse die des Proxys, also **nicht** der Client:
 * sie zaehlt deshalb als `proxy`, und zwar auch dann, wenn `x-forwarded-for` fehlt (kein Client dahinter zu
 * sehen ist keine oeffentliche Adresse) oder ihr letzter Eintrag zufaellig mit ihr uebereinstimmt (derselbe
 * Fall, nur einmal explizit statt implizit). Nur ein davon abweichender letzter Eintrag ist der Client.
 */
export function resolveClientAddress(request: IncomingMessage, trustedProxy: boolean): ClientAddress {
  const socketAddress = request.socket.remoteAddress ?? 'unbekannt'
  if (!trustedProxy) {
    return { address: socketAddress, class: baseClass(socketAddress) }
  }
  const forwarded = lastForwarded(request)
  if (forwarded === null || forwarded === socketAddress) {
    return { address: socketAddress, class: 'proxy' }
  }
  return { address: forwarded, class: baseClass(forwarded) }
}

export type AddressPlausibility = 'plausible' | 'implausible' | 'unknown'

export type ClientAddressMonitor = {
  /** Zaehlt eine Anfrage in das laufende Fenster ein. Nimmt nur die Klasse entgegen, nie die Adresse selbst. */
  record(entry: ClientAddress): void
  /**
   * Aussage fuer diesen Prozess: sieht die Instanz plausible oeffentliche Client-Adressen? Grundlage fuer
   * #35 (IP-Sperre nach gehaeuften Fehlanmeldungen) - ohne echte Adressen erzeugt sie keine Sperre.
   */
  plausibility(): AddressPlausibility
}

/**
 * Mindestzahl an Anfragen, bevor ueberhaupt geurteilt wird.
 *
 * Darunter waere ein einzelner interner Aufruf - ein Zustandscheck, ein Cronjob im selben Netz - schon ein
 * Fehlalarm; 50 sind mehr, als eine Handvoll solcher Aufrufe je Fenster ausloest.
 */
const MIN_SAMPLE = 50

/**
 * Groesse eines Fensters. Danach beginnt die Zaehlung neu, die zuletzt getroffene Aussage bleibt aber bis
 * zur naechsten Mindestzahl an Anfragen im neuen Fenster gueltig - es gibt sonst keinen Moment ohne Aussage.
 */
const WINDOW_SIZE = 200

/**
 * Anteil nicht-oeffentlicher Adressen, ab dem ein "deutlicher Grossteil" gilt. 80% lassen eine Minderheit
 * echter Anfragen - etwa ein Systemadmin im internen Netz - zu, ohne bei fehlender Weiterleitung stumm zu
 * bleiben, bei der praktisch alle Adressen intern sind.
 */
const NON_PUBLIC_WARN_RATIO = 0.8

export function createClientAddressMonitor(logger: Logger): ClientAddressMonitor {
  let total = 0
  let nonPublic = 0
  let state: AddressPlausibility = 'unknown'

  return {
    record(entry: ClientAddress): void {
      total += 1
      if (entry.class !== 'public') {
        nonPublic += 1
      }
      if (total >= MIN_SAMPLE) {
        const ratio = nonPublic / total
        const next: AddressPlausibility = ratio >= NON_PUBLIC_WARN_RATIO ? 'implausible' : 'plausible'
        // Nur beim Uebergang in "implausible": bleibt es dabei, wuerde eine Warnung je Fenster nur denselben
        // Befund wiederholen. Ein Ruecksprung nach "plausible" laesst einen spaeteren Uebergang neu warnen.
        if (next === 'implausible' && state !== 'implausible') {
          // Nur Zaehlwerte, keine Adresse und keine Klasse je Anfrage: das Log bleibt frei von Nutzungsdaten.
          logger('warn', 'client-address.mostly-internal', {
            sampleSize: total,
            nonPublicPercent: Math.round(ratio * 100),
          })
        }
        state = next
      }
      if (total >= WINDOW_SIZE) {
        total = 0
        nonPublic = 0
      }
    },
    plausibility(): AddressPlausibility {
      return state
    },
  }
}
