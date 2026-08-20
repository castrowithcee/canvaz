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

import { SCENE_VERSION_RETENTION } from '../domain/board/model.js'
import type { AssetStorageAdapter } from '../domain/storage/asset-storage-port.js'
import type { S3StorageConfig } from '../persistence/asset-storage-s3.js'

export type OidcConfig = {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
}

export type AppConfig = {
  readonly port: number
  /** Oeffentliche Basis-URL der Instanz, Grundlage fuer Redirects und Cookie-Sicherheit. */
  readonly baseUrl: string
  readonly secureCookies: boolean
  readonly databaseUrl: string
  readonly sessionSecret: string
  readonly sessionTtlSeconds: number
  /** `null` heisst: kein Identity Provider konfiguriert. Die Instanz zeigt und bedient dann nur den lokalen Weg. */
  readonly oidc: OidcConfig | null
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
   * Steht die Instanz hinter einem Reverse Proxy?
   *
   * Nur dann wird `x-forwarded-for` ueberhaupt gelesen. Ohne Proxy waere die Kopfzeile frei erfunden und
   * wuerde die Ratengrenze wertlos machen; mit Proxy waere ihr Fehlen genauso schlimm, weil dann alle
   * Clients in einem Eimer landen.
   */
  readonly trustedProxy: boolean
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
    sessionTtlSeconds: readInteger(env, 'CANVAZ_SESSION_TTL_HOURS', 12, 1, 720, problems) * SECONDS_PER_HOUR,
    oidc: readOidc(env, problems),
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
    trustedProxy: readBoolean(env, 'CANVAZ_TRUSTED_PROXY', false, problems),
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
