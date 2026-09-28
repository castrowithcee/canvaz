/**
 * Absenderabwehr gegen gehaeufte Fehlanmeldungen (#35, Meilenstein 1).
 *
 * Zaehlt Fehlschlaege je Absender - IPv4 je Adresse, IPv6 je /64-Praefix - in einem 24-Stunden-Fenster und
 * sperrt ab einer Schwelle vorlaeufig fuer 24 Stunden. Eine zweite Sperre derselben Adresse innerhalb von 30
 * Tagen erzeugt einen Vorschlag fuer eine dauerhafte Sperre. Die Anwendung sperrt nie selbst dauerhaft und
 * greift nie auf Firewall oder Proxy zu - das ist Meilenstein 2.
 *
 * ## Zweckbindung
 *
 * Diese Daten dienen ausschliesslich der Sicherheit der Anmeldewege (berechtigtes Interesse, Art. 6 Abs. 1
 * lit. f DSGVO) und werden nie mit einem Konto verknuepft. Erfolgreiche Anmeldungen zaehlen nicht und
 * erscheinen nirgends in diesem Modul.
 *
 * ## Der taeglich rotierende Schluessel
 *
 * Gespeichert wird nie eine Adresse, sondern nur ein HMAC darueber. Der Schluessel dafuer lebt
 * ausschliesslich im Prozessspeicher, ist zufaellig erzeugt und rotiert einmal taeglich (`createKeyring`).
 * Ein Neustart verliert ihn; bestehende Zaehlerzeilen werden dadurch unauffindbar, was die Zaehlung faktisch
 * zurueksetzt. Das ist eine bewusste Entscheidung und kein Fehler: ein dauerhafter Schluessel muesste
 * gespeichert werden und waere selbst ein Geheimnis, das den Absenderbezug wiederherstellen koennte.
 *
 * Ein Fenster, das genau ueber die Rotation faellt, zaehlt teils unter dem alten und teils unter dem neuen
 * Schluessel - ein Absender kann dadurch knapp unter der Schwelle bleiben, obwohl er in Wirklichkeit ueber
 * 24 Stunden hinweg genug Fehlschlaege erzeugt hat. Diese Vereinfachung ist ausdruecklich zugelassen: es
 * braucht keine zweite Schluesselspur, die ein Fenster ueber die Rotation hinweg zusammenhaelt - die Abwehr
 * wird dadurch hoechstens etwas langsamer wirksam, nie wirkungslos, denn jeder Fehlschlag wird weiterhin
 * gezaehlt.
 *
 * ## Ort der Pruefung
 *
 * `guard()` in `local-auth-routes.ts` prueft `isBlocked` fuer alle dort gebuendelten anonymen Wege (lokale
 * Anmeldung, Passwortwechsel, Einladung, Selbstwiederherstellung) vor jeder Herkunfts- oder Passwortpruefung.
 * Die Bestaetigung des zweiten Faktors (`second-factor-routes.ts`, `AUTH_SECOND_FACTOR_VERIFY_PATH`) prueft
 * eigenstaendig, weil sie keine Sitzung ohne ersten Faktor kennt - sie ist trotzdem ein anonymer Weg im Sinne
 * des Vertrags, denn die Sitzung hat den zweiten Faktor noch nicht bestaetigt.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import type { ServerResponse } from 'node:http'

import type { NewSenderBlock, SenderBlockAddressKind, SenderDefenseRetention } from '../domain/identity/repositories.js'
import { normalizeAddress } from './client-address.js'
import type { ClientAddress } from './client-address.js'
import type { AppConfig, LoginBlockConfig } from './config.js'
import type { AppContext } from './context.js'
import { sendError } from './http.js'

/** Grund, der an einer ausgeloesten Sperre steht - eine stabile Kennung, kein Anzeigetext. */
const LOGIN_FAILURE_REASON = 'login-failures'

/**
 * Die eine Antwort auf eine ausgeloeste Sperre: fuer jeden anonymen Anmeldeweg gleich, und ohne ein Konto zu
 * nennen.
 */
const SENDER_BLOCKED_MESSAGE = 'Zu viele fehlgeschlagene Versuche von dieser Adresse. Bitte spaeter erneut versuchen.'

/** Sendet die kontoneutrale 429-Antwort einer ausgeloesten Sperre, mit passender `retry-after`. */
export function sendSenderBlockedResponse(response: ServerResponse, durationHours: number): void {
  response.setHeader('retry-after', String(durationHours * 3600))
  sendError(response, 429, SENDER_BLOCKED_MESSAGE)
}

const KEY_BYTES = 32
const KEY_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000
const COUNTER_WINDOW_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export type SenderDefenseKeyring = {
  /** Der aktuelle Schluessel. Verlaesst den Prozess nie und wird nirgends gespeichert. */
  current(): Buffer
  stop(): void
}

/** Erzeugt den taeglich rotierenden Schluessel. Siehe Modulkommentar zur Rotation ueber ein Fenster hinweg. */
export function createSenderDefenseKeyring(): SenderDefenseKeyring {
  let key = randomBytes(KEY_BYTES)
  const timer = setInterval(() => {
    key = randomBytes(KEY_BYTES)
  }, KEY_ROTATION_INTERVAL_MS)
  timer.unref()
  return {
    current: () => key,
    stop: () => {
      clearInterval(timer)
    },
  }
}

export type SenderKey = { readonly hashInput: string; readonly address: string; readonly kind: SenderBlockAddressKind }

/** Netzpraefix der ersten 64 Bit (vier Gruppen) einer IPv6-Adresse, als stabile Kennung - keine gueltige Adresse. */
function ipv6NetworkPrefix64(address: string): string {
  const withoutZone = address.split('%')[0] ?? address
  const [head = '', tail] = withoutZone.split('::')
  const headParts = head === '' ? [] : head.split(':')
  const tailParts = tail === undefined || tail === '' ? [] : tail.split(':')
  const missing = 8 - headParts.length - tailParts.length
  const groups = tail === undefined ? headParts : [...headParts, ...new Array(Math.max(missing, 0)).fill('0'), ...tailParts]
  return groups
    .slice(0, 4)
    .map((group) => group.padStart(4, '0').toLowerCase())
    .join(':')
}

/**
 * Kennung eines Absenders, oder `null`, wenn keine sinnvolle gebildet werden kann.
 *
 * `proxy` ist nicht der Client, sondern der Gegenpart der Verbindung - eine Zaehlung darauf wuerde alle
 * Clients hinter einer fehlkonfigurierten Weiterleitung in einen Topf werfen. `unknown` ist keine gueltige
 * Adresse. Beides zaehlt deshalb nicht mit; eine Sperre waere fuer beide Klassen ohnehin ausgeschlossen.
 */
/**
 * Normalisiert eine Rohadresse (IPv4-gemappt -> IPv4) und bildet daraus die gespeicherte Form: eine
 * IPv4-Adresse unveraendert, eine IPv6-Adresse als /64-Praefix. `null`, wenn es keine gueltige Adresse ist.
 *
 * Getrennt von `senderKey`, weil der Hostbefehl `sender-block unblock` (`sender-block-cli.ts`) dieselbe
 * Bildung fuer eine vom Betreiber eingegebene Adresse braucht, aber keine `ClientAddress` mit Klasse hat.
 */
export function resolveSenderAddress(rawAddress: string): SenderKey | null {
  // Normalisieren vor jeder Auswertung: `resolveClientAddress` liefert bei einem Dual-Stack-Socket ohne Proxy
  // die ungemappte Form `::ffff:a.b.c.d`. Ohne diesen Schritt wuerde `isIP` sie als IPv6 lesen und alle
  // IPv4-Absender landeten unter demselben /64-Praefix `0000:0000:0000:0000`.
  const normalized = normalizeAddress(rawAddress)
  const family = isIP(normalized)
  if (family === 4) {
    return { hashInput: `ipv4:${normalized}`, address: normalized, kind: 'ipv4' }
  }
  if (family === 6) {
    const prefix = ipv6NetworkPrefix64(normalized)
    return { hashInput: `ipv6:${prefix}`, address: prefix, kind: 'ipv6-64' }
  }
  return null
}

function senderKey(address: ClientAddress): SenderKey | null {
  if (address.class === 'proxy' || address.class === 'unknown') {
    return null
  }
  return resolveSenderAddress(address.address)
}

function hashSenderKey(key: Buffer, hashInput: string): string {
  return createHmac('sha256', key).update(hashInput).digest('hex')
}

/**
 * Ein gespeicherter Absender als CIDR-Netz in kanonischer Schreibweise - fuer den Hostbefehl
 * `sender-block list`, damit der Betreiber den Wert unveraendert in seine Firewall uebernehmen kann.
 *
 * Eine IPv4-Adresse bleibt, wie sie ist. Ein IPv6-/64-Praefix steht als vier Gruppen (`ipv6NetworkPrefix64`)
 * mit fuehrenden Nullen; das kanonische `::` ersetzt hier immer die impliziten vier Nullgruppen dahinter und
 * jede Nullgruppe unmittelbar davor, sodass z. B. `2001:0db8:0000:0001` zu `2001:db8:0:1::/64` wird.
 */
export function senderAddressAsCidr(record: { readonly address: string; readonly kind: SenderBlockAddressKind }): string {
  if (record.kind === 'ipv4') {
    return record.address
  }
  const groups = record.address.split(':').map((group) => group.replace(/^0+(?=.)/, ''))
  let end = groups.length
  while (end > 0 && groups[end - 1] === '0') {
    end -= 1
  }
  const head = groups.slice(0, end).join(':')
  return `${head}::/64`
}

function buildAllowlist(ranges: LoginBlockConfig['allowlist']): BlockList {
  const list = new BlockList()
  for (const range of ranges) {
    list.addSubnet(range.address, range.prefix, range.family)
  }
  return list
}

/**
 * Darf dieser Absender ueberhaupt gesperrt werden?
 *
 * Private, Loopback- und Proxyadressen nie; eine Adresse aus der Allowlist ebenfalls nie. Nur `public`
 * kommt infrage - das ist zugleich die einzige Klasse, in der `resolveClientAddress` eine echte, aussen
 * erreichbare Adresse liefert.
 */
function blockEligible(address: ClientAddress, allowlist: BlockList): boolean {
  if (address.class !== 'public') {
    return false
  }
  // Dieselbe Normalisierung wie in `senderKey`: eine gemappte Adresse muss gegen eine IPv4-Allowlist pruefen.
  const normalized = normalizeAddress(address.address)
  const family = isIP(normalized)
  const type = family === 4 ? 'ipv4' : 'ipv6'
  return !allowlist.check(normalized, type)
}

/** Die drei Fristgrenzen dieses Moduls zu einem Zeitpunkt - gemeinsam genutzt von Fehlschlag und Aufraeumlauf. */
function retention(now: Date, loginBlock: LoginBlockConfig): SenderDefenseRetention {
  return {
    counterWindowStart: new Date(now.getTime() - COUNTER_WINDOW_MS),
    blockRetentionCutoff: new Date(now.getTime() - loginBlock.retentionDays * DAY_MS),
    proposalRetentionCutoff: new Date(now.getTime() - loginBlock.proposalRetentionDays * DAY_MS),
  }
}

/** Takt des eigenstaendigen Aufraeumlaufs - fein genug fuer Fristen von Stunden bis Monaten. */
const RETENTION_INTERVAL_MS = 3_600_000

/**
 * Eigenstaendiger Aufraeumlauf, nach dem Muster des Papierkorbs (`trash.ts`).
 *
 * `recordFailure` raeumt bei jedem Fehlschlag opportunistisch mit auf; ohne weitere Fehlschlaege - etwa nach
 * einer einzelnen ausgeloesten Sperre, auf die nichts mehr folgt - bliebe das die einzige Gelegenheit. Dieser
 * Lauf sorgt dafuer, dass die "spaetestens"-Fristen des Vertrags auch dann greifen.
 */
export function startSenderDefenseRetention(context: AppContext): () => void {
  const run = (): void => {
    void context.identity.senderDefense
      .purgeExpired(retention(context.now(), context.config.loginBlock))
      .catch((error: unknown) => {
        // Nur die Fehlermeldung, nie eine Adresse.
        context.logger('error', 'auth.sender.retention.failed', { cause: String(error) })
      })
  }
  run()
  const timer = setInterval(run, RETENTION_INTERVAL_MS)
  timer.unref()
  return () => {
    clearInterval(timer)
  }
}

export type SenderDefenseGuard = {
  /** Ist dieser Absender aktuell gesperrt? Fuer den Vorlauf jedes anonymen Anmeldewegs. */
  isBlocked(context: AppContext, address: ClientAddress): Promise<boolean>
  /**
   * Zaehlt einen Fehlschlag ein und legt bei Ueberschreiten der Schwelle eine vorlaeufige Sperre an - mit
   * Vorschlag, wenn dieselbe Adresse bereits innerhalb der Vorschlagsfrist einmal gesperrt war.
   */
  recordFailure(context: AppContext, address: ClientAddress): Promise<void>
  stop(): void
}

export function createSenderDefenseGuard(config: Pick<AppConfig, 'loginBlock'>): SenderDefenseGuard {
  const keyring = createSenderDefenseKeyring()
  const allowlist = buildAllowlist(config.loginBlock.allowlist)

  return {
    async isBlocked(context: AppContext, address: ClientAddress): Promise<boolean> {
      if (!blockEligible(address, allowlist)) {
        return false
      }
      const key = senderKey(address)
      if (key === null) {
        return false
      }
      const record = await context.identity.senderDefense.blocks.findActive(key.address, context.now())
      return record !== null
    },

    async recordFailure(context: AppContext, address: ClientAddress): Promise<void> {
      const key = senderKey(address)
      if (key === null) {
        return
      }
      const now = context.now()
      const { loginBlock } = context.config
      const cutoffs = retention(now, loginBlock)
      // Opportunistisch bei jedem Fehlschlag, zusaetzlich zum eigenstaendigen Lauf (`startSenderDefenseRetention`):
      // keine abgelaufene Zeile bleibt laenger liegen als bis zum naechsten Versuch.
      await context.identity.senderDefense.purgeExpired(cutoffs)
      const hash = hashSenderKey(keyring.current(), key.hashInput)
      const attempts = await context.identity.senderDefense.counters.hit(hash, now, cutoffs.counterWindowStart)
      if (attempts < loginBlock.threshold) {
        return
      }
      // Ohne echte Client-Adressen entsteht keine Sperre: der Plausibilitaetshinweis und die Klasse
      // entscheiden, nicht die Zaehlung allein.
      if (context.addressMonitor.plausibility() !== 'plausible' || !blockEligible(address, allowlist)) {
        return
      }
      const entry: NewSenderBlock = { address: key.address, kind: key.kind, reason: LOGIN_FAILURE_REASON, failureCount: attempts }
      const { record, priorBlockWithinProposalWindow } = await context.identity.senderDefense.blocks.upsert(
        entry,
        now,
        loginBlock.durationHours,
        loginBlock.proposalWindowDays,
      )
      // Die Adresse steht hier bewusst im Log: nur eine ausgeloeste Sperre nennt sie, wie der Vertrag verlangt.
      context.logger('warn', 'auth.sender.blocked', {
        address: record.address,
        kind: record.kind,
        failures: record.failureCount,
      })
      if (priorBlockWithinProposalWindow !== null) {
        await context.identity.senderDefense.proposals.create({
          address: record.address,
          kind: record.kind,
          reason: LOGIN_FAILURE_REASON,
          firstBlockedAt: priorBlockWithinProposalWindow.createdAt,
          secondBlockedAt: now,
        })
        context.logger('warn', 'auth.sender.block-proposal.created', { address: record.address })
      }
    },

    stop(): void {
      keyring.stop()
    },
  }
}
