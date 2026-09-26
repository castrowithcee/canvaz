/**
 * Zentrale Anwendungskonfiguration.
 *
 * Alle Werte kommen ausschliesslich aus Umgebungsvariablen. Fehlt oder taugt ein Pflichtwert nicht, bricht
 * der Start mit einer Aufstellung aller Probleme ab. Es gibt bewusst keinen stillen Ersatzwert fuer
 * Datenbank oder Session-Geheimnis: ein Server, der mit einem geratenen Geheimnis laeuft, ist schlimmer als
 * einer, der gar nicht startet.
 *
 * **OIDC ist optional.** Ohne jede der vier OIDC-Variablen startet die Instanz und arbeitet allein mit der
 * lokalen Benutzerverwaltung. Wer den Weg zuschaltet, setzt alle vier - eine halbe Konfiguration ist ein
 * Startfehler und kein stiller Verzicht auf den Provider.
 */

import { isIP } from 'node:net'

import { SCENE_VERSION_RETENTION, TRASH_RETENTION_DAYS } from '../domain/board/model.js'
import { normalizeEmail } from '../domain/identity/local-auth.js'
import type { AssetStorageAdapter } from '../domain/storage/asset-storage-port.js'
import type { S3StorageConfig } from '../persistence/asset-storage-s3.js'

export type OidcConfig = {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
}

/**
 * Zugang zum Postausgang.
 *
 * `null` heisst: kein Versand. Die Instanz laeuft dann vollstaendig - ein Einladungslink steht wie bisher
 * genau einmal in der Antwort der Anlage, und wer ihn zustellt, entscheidet der Betrieb.
 */
export type MailConfig = {
  readonly host: string
  readonly port: number
  /** Implizites TLS ab der ersten Verbindung (Port 465). Sonst ist STARTTLS Pflicht. */
  readonly secure: boolean
  /**
   * Ausnahme fuer einen isolierten Relay ohne TLS: ohne `secure` darf die Verbindung dann im Klartext
   * bleiben. Nur ausdruecklich gesetzt; ohne Angabe bricht ein Server ohne STARTTLS den Versand ab.
   */
  readonly allowInsecure: boolean
  /** `null` heisst: ohne Anmeldung. Ein Auffangserver im eigenen Netz verlangt keine. */
  readonly auth: { readonly user: string; readonly password: string } | null
  /** Absenderadresse jeder Nachricht dieser Instanz. */
  readonly from: string
}

export type AppConfig = {
  readonly port: number
  /** Oeffentliche Basis-URL der Instanz, Grundlage fuer Redirects und Cookie-Sicherheit. */
  readonly baseUrl: string
  readonly secureCookies: boolean
  readonly databaseUrl: string
  readonly sessionSecret: string
  /**
   * 32 Byte fuer AES-256-GCM: versiegelt das TOTP-Geheimnis und leitet den Schluessel der Ersatzcodes ab.
   * Pflichtwert ohne Ersatz - dieselbe Regel wie beim Sitzungsgeheimnis.
   */
  readonly mfaEncryptionKey: Buffer
  readonly sessionTtlSeconds: number
  /** `null` heisst: kein Identity Provider konfiguriert. Die Instanz zeigt und bedient dann nur den lokalen Weg. */
  readonly oidc: OidcConfig | null
  /**
   * `null` heisst: kein Postausgang konfiguriert. Dann verschickt die Instanz nichts und niemand wartet auf
   * eine Mail, die nie kommt.
   */
  readonly mail: MailConfig | null
  readonly storage: {
    readonly adapter: AssetStorageAdapter
    /** Obergrenze einer einzelnen hochgeladenen Bilddatei in Bytes. Begrenzt zugleich den Anfragekoerper. */
    readonly maxAssetBytes: number
    /** Genau der gewaehlte Adapter ist gesetzt; der andere ist `null`. */
    readonly filesystem: { readonly root: string } | null
    readonly s3: S3StorageConfig | null
  }
  /**
   * Obergrenze eines serialisierten Szenen-Snapshots in Bytes. Sie begrenzt zugleich den Anfragekoerper der
   * Speicherung; ein groesserer Koerper wird gar nicht erst vollstaendig gelesen.
   */
  readonly maxSceneBytes: number
  /**
   * Zahl der je Board aufbewahrten Szenenversionen.
   *
   * Die Historie waechst mit jeder Speicherung und jedem Checkpoint; ohne Grenze waechst sie unbegrenzt.
   * Der Wert ist konfigurierbar, weil er zwischen Rueckweg und Speicherbedarf abwaegt - ein Betrieb mit
   * langen Sitzungen will mehr Staende, ein enger Datenbankplatz weniger.
   */
  readonly sceneVersionRetention: number
  /**
   * Aufbewahrungsfrist des Papierkorbs in Tagen.
   *
   * Nach ihr entfernt die Instanz ein geloeschtes Board ohne Zutun endgueltig. Konfigurierbar, weil ein
   * Betrieb zwischen Rueckweg und Speicherbedarf abwaegt; der Standard bleibt bei vierzehn Tagen. Die
   * Frist begrenzt ausschliesslich die Aufbewahrung im Papierkorb - Wiederherstellungsziel und Sicherung
   * bleiben davon unberuehrt.
   */
  readonly trashRetentionDays: number
  /**
   * Obergrenze einer Importdatei in Bytes.
   *
   * Deutlich groesser als ein Snapshot: eine `.excalidraw`-Datei traegt ihre Bilder als Base64 in derselben
   * Datei und ist dadurch um rund ein Drittel groesser als die Bytes, die sie meint. Sie begrenzt den
   * Anfragekoerper; ein groesserer landet nie vollstaendig im Speicher.
   */
  readonly maxImportBytes: number
  /** Verzeichnis mit der gebauten SPA. */
  readonly webRoot: string
  /** Anfragen je Minute und Client auf die HTTP-API. */
  readonly rateLimitPerMinute: number
  /**
   * Versuche je Minute und Client auf die unangemeldeten Anmeldestrecken: lokale Anmeldung, Passwortwechsel
   * und Einloesen einer Einladung. Sie liegt weit unter der allgemeinen Ratengrenze, weil hier ein Raten
   * stattfindet und kein Gebrauch.
   */
  readonly authRateLimitPerMinute: number
  /**
   * Anmeldeversuche je Zielkonto und Fenster, unabhaengig davon, von wie vielen Clients sie kommen. Gezaehlt
   * wird die eingegebene Adresse, ob es das Konto gibt oder nicht; eine erfolgreiche Anmeldung setzt den
   * Zaehler zurueck.
   */
  readonly authAccountAttempts: number
  /** Laenge dieses Fensters in Minuten. Danach ist die Drosselung von selbst aufgehoben. */
  readonly authAccountWindowMinutes: number
  /**
   * Steht die Instanz hinter einem Reverse Proxy?
   *
   * Nur dann wird `x-forwarded-for` ueberhaupt gelesen. Ohne Proxy waere die Kopfzeile frei erfunden und
   * wuerde die Ratengrenze wertlos machen; mit Proxy waere ihr Fehlen genauso schlimm, weil dann alle
   * Clients in einem Eimer landen.
   */
  readonly trustedProxy: boolean
  /**
   * Absenderabwehr gegen gehaeufte Fehlanmeldungen (#35, Meilenstein 1): Schwelle, Sperrdauer, Vorschlags-
   * und Aufbewahrungsfristen sowie eine Allowlist eigener Netze, die nie gesperrt werden.
   */
  readonly loginBlock: LoginBlockConfig
}

export type CidrRange = { readonly address: string; readonly prefix: number; readonly family: 'ipv4' | 'ipv6' }

export type LoginBlockConfig = {
  /** Eigene Netze, die trotz Schwellenueberschreitung nie gesperrt werden. Ohne Angabe leer. */
  readonly allowlist: readonly CidrRange[]
  /** Fehlschlaege eines Absenders in 24 Stunden, ab denen die Anwendung vorlaeufig sperrt. */
  readonly threshold: number
  /** Dauer einer vorlaeufigen Sperre in Stunden. */
  readonly durationHours: number
  /** Zweite Sperre derselben Adresse innerhalb dieser Frist in Tagen erzeugt einen Vorschlag. */
  readonly proposalWindowDays: number
  /** Aufbewahrung eines Sperreintrags nach seinem Ablauf in Tagen. */
  readonly retentionDays: number
  /** Hoechste Aufbewahrung eines Vorschlags in Tagen, unabhaengig von einer Betreiberentscheidung. */
  readonly proposalRetentionDays: number
}

/** Sammelt alle Konfigurationsprobleme, damit ein Fehlstart nicht Variable fuer Variable aufgeloest wird. */
export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Ungueltige Konfiguration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

type Env = Record<string, string | undefined>

const MIN_SESSION_SECRET_LENGTH = 32

/** Laenge des Schluessels fuer AES-256-GCM in Bytes. */
const MFA_KEY_BYTES = 32

/**
 * Schluessel des zweiten Faktors: base64 (oder base64url) fuer genau 32 Byte, etwa aus
 * `openssl rand -base64 32`. Ein beliebiger Text wuerde still zu einem schwachen Schluessel; deshalb
 * zaehlt nur ein Wert, der sich vollstaendig und in genau dieser Laenge dekodieren laesst.
 */
function readMfaKey(env: Env, problems: string[]): Buffer {
  const name = 'CANVAZ_MFA_ENCRYPTION_KEY'
  const raw = readRequired(env, name, problems)
  if (raw === '') {
    return Buffer.alloc(0)
  }
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(raw) ? Buffer.from(raw, 'base64') : Buffer.alloc(0)
  if (key.length !== MFA_KEY_BYTES) {
    problems.push(`${name} muss genau ${String(MFA_KEY_BYTES)} Byte in base64 sein, z. B. aus \`openssl rand -base64 32\``)
  }
  return key
}

function readRequired(env: Env, name: string, problems: string[]): string {
  const value = env[name]?.trim()
  if (value === undefined || value.length === 0) {
    problems.push(`${name} fehlt`)
    return ''
  }
  return value
}

function readUrl(env: Env, name: string, problems: string[], protocols: readonly string[]): string {
  const raw = readRequired(env, name, problems)
  if (raw === '') {
    return ''
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    problems.push(`${name} ist keine gueltige URL`)
    return ''
  }
  if (!protocols.includes(parsed.protocol)) {
    problems.push(`${name} muss eines dieser Protokolle nutzen: ${protocols.join(', ')}`)
    return ''
  }
  return raw
}

function readInteger(env: Env, name: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = env[name]?.trim()
  if (raw === undefined || raw.length === 0) {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} muss eine ganze Zahl zwischen ${String(min)} und ${String(max)} sein`)
    return fallback
  }
  return value
}

const STORAGE_ADAPTERS: readonly AssetStorageAdapter[] = ['filesystem', 's3']

function readStorageAdapter(env: Env, problems: string[]): AssetStorageAdapter {
  const raw = env['CANVAZ_STORAGE_ADAPTER']?.trim()
  if (raw === undefined || raw.length === 0) {
    return 'filesystem'
  }
  const adapter = STORAGE_ADAPTERS.find((candidate) => candidate === raw)
  if (adapter === undefined) {
    problems.push(`CANVAZ_STORAGE_ADAPTER muss einer von ${STORAGE_ADAPTERS.join(', ')} sein`)
    return 'filesystem'
  }
  return adapter
}

function readBoolean(env: Env, name: string, fallback: boolean, problems: string[]): boolean {
  const raw = env[name]?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) {
    return fallback
  }
  if (raw === 'true' || raw === 'false') {
    return raw === 'true'
  }
  problems.push(`${name} muss true oder false sein`)
  return fallback
}

/**
 * Adapterspezifische Pflichtwerte.
 *
 * Nur der gewaehlte Adapter wird geprueft: wer `filesystem` faehrt, soll nicht ueber fehlende S3-Werte
 * stolpern. Fuer das Wurzelverzeichnis gibt es bewusst keinen Standardwert - ein Ersatzpfad im
 * Containerlayer saehe aus wie Persistenz und waere beim naechsten Neustart weg.
 */
function readStorage(
  env: Env,
  adapter: AssetStorageAdapter,
  problems: string[],
): { readonly filesystem: { readonly root: string } | null; readonly s3: S3StorageConfig | null } {
  if (adapter === 's3') {
    return {
      filesystem: null,
      s3: {
        endpoint: readUrl(env, 'CANVAZ_S3_ENDPOINT', problems, ['http:', 'https:']),
        region: readRequired(env, 'CANVAZ_S3_REGION', problems),
        bucket: readRequired(env, 'CANVAZ_S3_BUCKET', problems),
        accessKeyId: readRequired(env, 'CANVAZ_S3_ACCESS_KEY_ID', problems),
        secretAccessKey: readRequired(env, 'CANVAZ_S3_SECRET_ACCESS_KEY', problems),
        // MinIO und aeltere Installationen koennen den Bucket nur im Pfad adressieren; AWS erwartet ihn im
        // Hostnamen. Der Standard folgt AWS, weil eine falsche Annahme dort schwerer zu bemerken waere.
        forcePathStyle: readBoolean(env, 'CANVAZ_S3_FORCE_PATH_STYLE', false, problems),
      },
    }
  }
  return { filesystem: { root: readRequired(env, 'CANVAZ_STORAGE_FILESYSTEM_ROOT', problems) }, s3: null }
}

const SECONDS_PER_HOUR = 3600

/** 5 MiB. Deutlich mehr als jede beobachtete Szene und klein genug, um Speicher und Datenbank zu schuetzen. */
const DEFAULT_MAX_SCENE_BYTES = 5 * 1024 * 1024
const MIN_MAX_SCENE_BYTES = 64 * 1024
const MAX_MAX_SCENE_BYTES = 64 * 1024 * 1024

/**
 * 5 MiB je Bilddatei. Reicht fuer eine Bildschirmaufnahme oder ein Foto in Ansichtsgroesse und haelt eine
 * einzelne Anfrage klein genug, dass sie vollstaendig im Speicher geprueft werden kann.
 */
const DEFAULT_MAX_ASSET_BYTES = 5 * 1024 * 1024
const MIN_MAX_ASSET_BYTES = 16 * 1024
const MAX_MAX_ASSET_BYTES = 64 * 1024 * 1024

/**
 * Der Standard steht im Fachkern; hier stehen nur die Grenzen, in denen der Betrieb ihn verschieben darf.
 * Unter zehn Staenden waere die Historie kein Rueckweg mehr, ueber tausend keine begrenzte mehr.
 */
const MIN_SCENE_VERSION_RETENTION = 10
const MAX_SCENE_VERSION_RETENTION = 1000

/**
 * Grenzen der Papierkorbfrist. Der Standard steht im Fachkern.
 *
 * Ein Tag ist die kuerzeste Frist, die noch ein Rueckweg ist; ein Jahr die laengste, die noch eine
 * Aufbewahrung und keine zweite Ablage ist.
 */
const MIN_TRASH_RETENTION_DAYS = 1
const MAX_TRASH_RETENTION_DAYS = 365

/**
 * 20 MiB je Importdatei. Das traegt eine grosse Zeichnung samt mehrerer Bilder in Base64 und bleibt weit
 * unter dem, was eine einzelne Anfrage im Speicher halten darf.
 */
const DEFAULT_MAX_IMPORT_BYTES = 20 * 1024 * 1024
const MIN_MAX_IMPORT_BYTES = 64 * 1024
const MAX_MAX_IMPORT_BYTES = 128 * 1024 * 1024

/**
 * Anfragen je Minute und Client.
 *
 * 600 sind zehn je Sekunde und damit deutlich mehr, als eine geoeffnete Boardliste, ein Import oder ein
 * schneller Wechsel zwischen Boards ausloest - und deutlich weniger, als eine Flut braucht, um die
 * Datenbank zu beschaeftigen. Die Untergrenze liegt bei 60, weil alles darunter den normalen Gebrauch
 * traefe.
 */
const DEFAULT_RATE_LIMIT_PER_MINUTE = 600
const MIN_RATE_LIMIT_PER_MINUTE = 60
const MAX_RATE_LIMIT_PER_MINUTE = 600_000

/**
 * Anmeldeversuche je Minute und Client.
 *
 * Zehn sind mehr, als ein Mensch mit einem vergessenen Passwort in einer Minute schafft, und wenig genug,
 * dass ein Durchprobieren an der Wand endet statt an der Passwortlaenge. Die Untergrenze liegt bei fuenf,
 * weil darunter schon ein Vertipper samt Wiederholung ausgesperrt wuerde.
 */
const DEFAULT_AUTH_RATE_LIMIT_PER_MINUTE = 10
const MIN_AUTH_RATE_LIMIT_PER_MINUTE = 5
const MAX_AUTH_RATE_LIMIT_PER_MINUTE = 600_000

/**
 * Anmeldeversuche je Zielkonto und Fenster.
 *
 * Zehn Versuche in fuenfzehn Minuten, egal von wie vielen Adressen: ein verteiltes Durchprobieren kommt so
 * auf keine tausend Versuche am Tag und Konto, ein Mensch mit einem Vertipper merkt davon nichts. Die
 * Drosselung endet mit dem Fenster von selbst - eine dauerhafte Sperre koennte jeder Fremde ausloesen. Die
 * Untergrenze von drei laesst einen Vertipper samt Wiederholung zu, die Obergrenze des Fensters ist ein Tag.
 */
const DEFAULT_AUTH_ACCOUNT_ATTEMPTS = 10
const MIN_AUTH_ACCOUNT_ATTEMPTS = 3
const MAX_AUTH_ACCOUNT_ATTEMPTS = 100_000
const DEFAULT_AUTH_ACCOUNT_WINDOW_MINUTES = 15
const MIN_AUTH_ACCOUNT_WINDOW_MINUTES = 1
const MAX_AUTH_ACCOUNT_WINDOW_MINUTES = 1440

/**
 * Schwelle, ab der die Anwendung einen Absender vorlaeufig sperrt.
 *
 * Zwanzig Fehlschlaege eines Absenders in 24 Stunden sind deutlich mehr, als ein Mensch mit vertipptem
 * Passwort samt zweitem Faktor je erreicht, und wenig genug, dass ein automatisiertes Durchprobieren an der
 * Sperre endet, bevor es nennenswert Konten trifft.
 */
const DEFAULT_LOGIN_BLOCK_THRESHOLD = 20
const MIN_LOGIN_BLOCK_THRESHOLD = 1
const MAX_LOGIN_BLOCK_THRESHOLD = 100_000

/** Dauer einer vorlaeufigen Sperre. Kein Dauerlock: nach 24 Stunden ist sie von selbst aufgehoben. */
const DEFAULT_LOGIN_BLOCK_DURATION_HOURS = 24
const MIN_LOGIN_BLOCK_DURATION_HOURS = 1
const MAX_LOGIN_BLOCK_DURATION_HOURS = 24 * 30

/** Zweite Sperre derselben Adresse binnen 30 Tagen erzeugt einen Vorschlag fuer eine dauerhafte Sperre. */
const DEFAULT_LOGIN_BLOCK_PROPOSAL_WINDOW_DAYS = 30
const MIN_LOGIN_BLOCK_PROPOSAL_WINDOW_DAYS = 1
const MAX_LOGIN_BLOCK_PROPOSAL_WINDOW_DAYS = 365

/** Ein abgelaufener Sperreintrag bleibt danach noch 30 Tage nachvollziehbar, dann wird er entfernt. */
const DEFAULT_LOGIN_BLOCK_RETENTION_DAYS = 30
const MIN_LOGIN_BLOCK_RETENTION_DAYS = 1
const MAX_LOGIN_BLOCK_RETENTION_DAYS = 365

/** Ein Vorschlag verschwindet spaetestens nach 12 Monaten, auch ohne Betreiberentscheidung (Meilenstein 2). */
const DEFAULT_LOGIN_BLOCK_PROPOSAL_RETENTION_DAYS = 365
const MIN_LOGIN_BLOCK_PROPOSAL_RETENTION_DAYS = 30
const MAX_LOGIN_BLOCK_PROPOSAL_RETENTION_DAYS = 3650

/**
 * Eigene Netze, die die Absenderabwehr nie sperrt - etwa ein interner Schwachstellenscan oder ein
 * Monitoring-Dienst, der absichtlich falsche Anmeldedaten prueft. Bewusst ohne Standardwert: eine geratene
 * Ausnahme waere schlimmer als gar keine.
 */
function readLoginBlockAllowlist(env: Env, problems: string[]): readonly CidrRange[] {
  const raw = env['CANVAZ_LOGIN_BLOCK_ALLOWLIST']?.trim()
  if (raw === undefined || raw === '') {
    return []
  }
  const ranges: CidrRange[] = []
  for (const entry of raw.split(',')) {
    const candidate = entry.trim()
    if (candidate === '') {
      continue
    }
    const [address, prefixRaw] = candidate.split('/')
    const family = address === undefined ? 0 : isIP(address)
    const prefix = Number(prefixRaw)
    const maxPrefix = family === 4 ? 32 : 128
    if (family === 0 || address === undefined || prefixRaw === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      problems.push(`CANVAZ_LOGIN_BLOCK_ALLOWLIST: "${candidate}" ist kein gueltiges CIDR-Netz`)
      continue
    }
    ranges.push({ address, prefix, family: family === 4 ? 'ipv4' : 'ipv6' })
  }
  return ranges
}

function readLoginBlock(env: Env, problems: string[]): LoginBlockConfig {
  return {
    allowlist: readLoginBlockAllowlist(env, problems),
    threshold: readInteger(
      env,
      'CANVAZ_LOGIN_BLOCK_THRESHOLD',
      DEFAULT_LOGIN_BLOCK_THRESHOLD,
      MIN_LOGIN_BLOCK_THRESHOLD,
      MAX_LOGIN_BLOCK_THRESHOLD,
      problems,
    ),
    durationHours: readInteger(
      env,
      'CANVAZ_LOGIN_BLOCK_DURATION_HOURS',
      DEFAULT_LOGIN_BLOCK_DURATION_HOURS,
      MIN_LOGIN_BLOCK_DURATION_HOURS,
      MAX_LOGIN_BLOCK_DURATION_HOURS,
      problems,
    ),
    proposalWindowDays: readInteger(
      env,
      'CANVAZ_LOGIN_BLOCK_PROPOSAL_WINDOW_DAYS',
      DEFAULT_LOGIN_BLOCK_PROPOSAL_WINDOW_DAYS,
      MIN_LOGIN_BLOCK_PROPOSAL_WINDOW_DAYS,
      MAX_LOGIN_BLOCK_PROPOSAL_WINDOW_DAYS,
      problems,
    ),
    retentionDays: readInteger(
      env,
      'CANVAZ_LOGIN_BLOCK_RETENTION_DAYS',
      DEFAULT_LOGIN_BLOCK_RETENTION_DAYS,
      MIN_LOGIN_BLOCK_RETENTION_DAYS,
      MAX_LOGIN_BLOCK_RETENTION_DAYS,
      problems,
    ),
    proposalRetentionDays: readInteger(
      env,
      'CANVAZ_LOGIN_BLOCK_PROPOSAL_RETENTION_DAYS',
      DEFAULT_LOGIN_BLOCK_PROPOSAL_RETENTION_DAYS,
      MIN_LOGIN_BLOCK_PROPOSAL_RETENTION_DAYS,
      MAX_LOGIN_BLOCK_PROPOSAL_RETENTION_DAYS,
      problems,
    ),
  }
}

const OIDC_VARIABLES = [
  'CANVAZ_OIDC_ISSUER',
  'CANVAZ_OIDC_CLIENT_ID',
  'CANVAZ_OIDC_CLIENT_SECRET',
  'CANVAZ_OIDC_REDIRECT_URI',
] as const

/**
 * OIDC ist zuschaltbar, aber nicht halb.
 *
 * Ohne jede der vier Variablen gibt es den Weg nicht - das ist eine gueltige Instanz mit ausschliesslich
 * lokaler Anmeldung. Sobald **eine** gesetzt ist, gelten alle vier als gewollt und fehlende werden beim
 * Namen genannt: eine unvollstaendige Konfiguration ist ein Irrtum, und ein Server, der sie stillschweigend
 * als "kein Provider" liest, verbirgt genau diesen Irrtum bis zur ersten Anmeldung.
 */
function readOidc(env: Env, problems: string[]): OidcConfig | null {
  const configured = OIDC_VARIABLES.some((name) => (env[name]?.trim() ?? '') !== '')
  if (!configured) {
    return null
  }
  return {
    issuer: readUrl(env, 'CANVAZ_OIDC_ISSUER', problems, ['http:', 'https:']),
    clientId: readRequired(env, 'CANVAZ_OIDC_CLIENT_ID', problems),
    clientSecret: readRequired(env, 'CANVAZ_OIDC_CLIENT_SECRET', problems),
    redirectUri: readUrl(env, 'CANVAZ_OIDC_REDIRECT_URI', problems, ['http:', 'https:']),
  }
}

const MAIL_VARIABLES = [
  'CANVAZ_SMTP_HOST',
  'CANVAZ_SMTP_PORT',
  'CANVAZ_SMTP_USER',
  'CANVAZ_SMTP_PASSWORD',
  'CANVAZ_MAIL_FROM',
] as const

/** Impliziertes TLS gehoert zu Port 465; jeder andere Port spricht zuerst Klartext und muss per STARTTLS abheben. */
const SMTP_IMPLICIT_TLS_PORT = 465

/** Der Auffangserver einer Entwicklungsumgebung; der Standard eines echten Anbieters ist 587. */
const DEFAULT_SMTP_PORT = 587

/**
 * Der Postausgang ist zuschaltbar, aber nicht halb - dieselbe Regel wie bei OIDC.
 *
 * Ohne jede Variable gibt es keinen Versand: die Instanz laeuft, und der Einladungslink bleibt der Weg, den
 * ein Administrator selbst zustellt. Sobald **eine** gesetzt ist, gelten Server und Absender als gewollt und
 * fehlende werden beim Namen genannt.
 *
 * Benutzer und Passwort gehoeren zusammen. Ein Auffangserver im eigenen Netz verlangt keine Anmeldung,
 * deshalb ist das Paar optional - aber halb angemeldet gibt es nicht.
 *
 * Ohne implizites TLS ist STARTTLS Pflicht: eine Einladung traegt ihren Wert im Link und darf nicht still
 * im Klartext zum Relay gehen. Die Ausnahme `CANVAZ_SMTP_ALLOW_INSECURE` gilt nur, wenn sie ausdruecklich
 * gesetzt ist.
 */
function readMail(env: Env, problems: string[]): MailConfig | null {
  const configured = MAIL_VARIABLES.some((name) => (env[name]?.trim() ?? '') !== '')
  if (!configured) {
    return null
  }
  const port = readInteger(env, 'CANVAZ_SMTP_PORT', DEFAULT_SMTP_PORT, 1, 65_535, problems)
  const user = env['CANVAZ_SMTP_USER']?.trim() ?? ''
  const password = env['CANVAZ_SMTP_PASSWORD']?.trim() ?? ''
  if ((user === '') !== (password === '')) {
    problems.push('CANVAZ_SMTP_USER und CANVAZ_SMTP_PASSWORD gehoeren zusammen: entweder beide oder keines')
  }
  const rawFrom = readRequired(env, 'CANVAZ_MAIL_FROM', problems)
  const from = rawFrom === '' ? null : normalizeEmail(rawFrom)
  if (rawFrom !== '' && from === null) {
    problems.push('CANVAZ_MAIL_FROM ist keine gueltige E-Mail-Adresse')
  }
  return {
    host: readRequired(env, 'CANVAZ_SMTP_HOST', problems),
    port,
    secure: readBoolean(env, 'CANVAZ_SMTP_SECURE', port === SMTP_IMPLICIT_TLS_PORT, problems),
    allowInsecure: readBoolean(env, 'CANVAZ_SMTP_ALLOW_INSECURE', false, problems),
    auth: user === '' || password === '' ? null : { user, password },
    from: from ?? '',
  }
}

export function loadConfig(env: Env = process.env): AppConfig {
  const problems: string[] = []

  const storageAdapter = readStorageAdapter(env, problems)
  const baseUrl = readUrl(env, 'CANVAZ_BASE_URL', problems, ['http:', 'https:'])
  const databaseUrl = readUrl(env, 'DATABASE_URL', problems, ['postgres:', 'postgresql:'])
  const sessionSecret = readRequired(env, 'CANVAZ_SESSION_SECRET', problems)
  if (sessionSecret !== '' && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(`CANVAZ_SESSION_SECRET muss mindestens ${String(MIN_SESSION_SECRET_LENGTH)} Zeichen haben`)
  }

  const config: AppConfig = {
    port: readInteger(env, 'CANVAZ_PORT', 3000, 1, 65_535, problems),
    baseUrl,
    // Ohne TLS koennte der Browser ein `Secure`-Cookie nicht zuruecksenden; die Basis-URL entscheidet.
    secureCookies: baseUrl.startsWith('https:'),
    databaseUrl,
    sessionSecret,
    mfaEncryptionKey: readMfaKey(env, problems),
    sessionTtlSeconds: readInteger(env, 'CANVAZ_SESSION_TTL_HOURS', 12, 1, 720, problems) * SECONDS_PER_HOUR,
    oidc: readOidc(env, problems),
    mail: readMail(env, problems),
    storage: {
      adapter: storageAdapter,
      maxAssetBytes: readInteger(
        env,
        'CANVAZ_MAX_ASSET_BYTES',
        DEFAULT_MAX_ASSET_BYTES,
        MIN_MAX_ASSET_BYTES,
        MAX_MAX_ASSET_BYTES,
        problems,
      ),
      ...readStorage(env, storageAdapter, problems),
    },
    maxSceneBytes: readInteger(
      env,
      'CANVAZ_MAX_SCENE_BYTES',
      DEFAULT_MAX_SCENE_BYTES,
      MIN_MAX_SCENE_BYTES,
      MAX_MAX_SCENE_BYTES,
      problems,
    ),
    sceneVersionRetention: readInteger(
      env,
      'CANVAZ_SCENE_VERSION_RETENTION',
      SCENE_VERSION_RETENTION,
      MIN_SCENE_VERSION_RETENTION,
      MAX_SCENE_VERSION_RETENTION,
      problems,
    ),
    trashRetentionDays: readInteger(
      env,
      'CANVAZ_TRASH_RETENTION_DAYS',
      TRASH_RETENTION_DAYS,
      MIN_TRASH_RETENTION_DAYS,
      MAX_TRASH_RETENTION_DAYS,
      problems,
    ),
    maxImportBytes: readInteger(
      env,
      'CANVAZ_MAX_IMPORT_BYTES',
      DEFAULT_MAX_IMPORT_BYTES,
      MIN_MAX_IMPORT_BYTES,
      MAX_MAX_IMPORT_BYTES,
      problems,
    ),
    webRoot: env['CANVAZ_WEB_ROOT']?.trim() ?? 'dist/web',
    rateLimitPerMinute: readInteger(
      env,
      'CANVAZ_RATE_LIMIT_PER_MINUTE',
      DEFAULT_RATE_LIMIT_PER_MINUTE,
      MIN_RATE_LIMIT_PER_MINUTE,
      MAX_RATE_LIMIT_PER_MINUTE,
      problems,
    ),
    authRateLimitPerMinute: readInteger(
      env,
      'CANVAZ_AUTH_RATE_LIMIT_PER_MINUTE',
      DEFAULT_AUTH_RATE_LIMIT_PER_MINUTE,
      MIN_AUTH_RATE_LIMIT_PER_MINUTE,
      MAX_AUTH_RATE_LIMIT_PER_MINUTE,
      problems,
    ),
    authAccountAttempts: readInteger(
      env,
      'CANVAZ_AUTH_RATE_LIMIT_PER_ACCOUNT',
      DEFAULT_AUTH_ACCOUNT_ATTEMPTS,
      MIN_AUTH_ACCOUNT_ATTEMPTS,
      MAX_AUTH_ACCOUNT_ATTEMPTS,
      problems,
    ),
    authAccountWindowMinutes: readInteger(
      env,
      'CANVAZ_AUTH_RATE_LIMIT_WINDOW_MINUTES',
      DEFAULT_AUTH_ACCOUNT_WINDOW_MINUTES,
      MIN_AUTH_ACCOUNT_WINDOW_MINUTES,
      MAX_AUTH_ACCOUNT_WINDOW_MINUTES,
      problems,
    ),
    trustedProxy: readBoolean(env, 'CANVAZ_TRUSTED_PROXY', false, problems),
    loginBlock: readLoginBlock(env, problems),
  }

  // Die Redirect-URI zeigt auf diese Instanz zurueck. Eine fremde Herkunft waere ein offener Umleitungspunkt
  // und wuerde ausserdem das Session-Cookie nie erreichen.
  if (baseUrl !== '' && config.oidc !== null && config.oidc.redirectUri !== '') {
    if (new URL(config.oidc.redirectUri).origin !== new URL(baseUrl).origin) {
      problems.push('CANVAZ_OIDC_REDIRECT_URI muss dieselbe Herkunft wie CANVAZ_BASE_URL haben')
    }
  }

  if (problems.length > 0) {
    // Nur Variablennamen, nie Werte: die Fehlermeldung landet im Log.
    throw new ConfigError(problems)
  }
  return config
}
