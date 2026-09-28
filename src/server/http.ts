/**
 * HTTP-Grundlage: Routing und Auslieferung der SPA.
 *
 * Bewusst `node:http` ohne Framework. Der Bedarf ist eine Handvoll Routen plus statische Dateien; ein
 * Framework wuerde hier nur eine weitere Abhaengigkeit und eigene Konventionen mitbringen.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

import { API_BASE_PATH, HEALTH_PATH, METRICS_PATH, READY_PATH } from '../contracts/api.js'
import type { ErrorResponse } from '../contracts/api.js'
import type { ClientAddressMonitor } from './client-address.js'
import { resolveClientAddress } from './client-address.js'
import { describeError } from './log.js'
import type { Logger } from './log.js'
import type { Metrics } from './metrics.js'
import type { RateLimiter } from './rate-limit.js'

export type RouteHandler = (context: {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly url: URL
}) => Promise<void> | void

export type Route = {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly handle: RouteHandler
}

/**
 * Content-Security-Policy der Instanz. Die SPA laedt ausschliesslich eigene Dateien; alles Fremde ist
 * verboten. `data:`/`blob:` bleiben fuer Bilder offen, weil der Zeichenbereich Inhalte als Datenverweis
 * einbettet und exportiert. `frame-ancestors 'none'` ersetzt `X-Frame-Options`. HSTS fehlt bewusst: die
 * TLS-Terminierung ist eine Eingabe des Deployments, nicht dieser Anwendung.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
].join('; ')

/** Gilt fuer jede Antwort, auch fuer statische Dateien, Weiterleitungen und Fehler. */
export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('content-security-policy', CONTENT_SECURITY_POLICY)
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    // Antworten der API sind nutzerbezogen und duerfen nie in einem geteilten Cache landen.
    'cache-control': 'no-store',
  })
  response.end(payload)
}

export function sendError(response: ServerResponse, status: number, message: string): void {
  const body: ErrorResponse = { error: message }
  sendJson(response, status, body)
}

/** Weiterleitung mit `no-store`: Anmeldeantworten duerfen nie aus einem Cache wiederholt werden. */
export function sendRedirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, 'cache-control': 'no-store' })
  response.end()
}

const MAX_JSON_BODY_BYTES = 16_384

/**
 * Ergebnis des Koerperlesens. Zu gross und ungueltig sind getrennt, weil sie verschiedene Antworten
 * verdienen: 413 nennt eine ueberschreitbare Grenze, 400 einen kaputten Koerper.
 */
export type JsonBody =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'too-large' | 'invalid' }

/**
 * Liest einen JSON-Koerper mit harter Obergrenze. Ein zu grosser Koerper landet nie vollstaendig im
 * Speicher: ab der Grenze wird nichts mehr aufgehoben.
 */
export async function readJsonBodyLimited(request: IncomingMessage, maxBytes: number): Promise<JsonBody> {
  // Angekuendigte Groesse zuerst: ein zu grosser Koerper wird gar nicht erst gelesen.
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'too-large' }
  }
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) {
      // Ab hier wird nichts mehr aufgehoben, aber weiter gelesen: der Verbindungsabbruch mitten in der
      // Anfrage wuerde dem Client statt der 413 einen Netzwerkfehler liefern. Der Speicher bleibt begrenzt.
      tooLarge = true
      chunks.length = 0
      continue
    }
    chunks.push(buffer)
  }
  if (tooLarge) {
    return { ok: false, reason: 'too-large' }
  }
  if (size === 0) {
    return { ok: true, body: {} }
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { ok: true, body: parsed as Record<string, unknown> }
      : { ok: false, reason: 'invalid' }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

/**
 * Ergebnis des Lesens eines Binaerkoerpers.
 *
 * `aborted` ist ein eigener Fall: bricht der Client den Transfer ab, sind die Bytes unvollstaendig. Sie
 * duerfen dann nirgends ankommen - weder im Speicher noch als Metadatensatz.
 */
export type BinaryBody =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: 'too-large' | 'empty' | 'aborted' }

/** Liest einen Binaerkoerper mit harter Obergrenze. Wie beim JSON-Koerper wird nichts darueber aufgehoben. */
export async function readBinaryBodyLimited(request: IncomingMessage, maxBytes: number): Promise<BinaryBody> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'too-large' }
  }
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        continue
      }
      chunks.push(buffer)
    }
  } catch {
    // Verbindungsabbruch mitten im Transfer. Das Gelesene ist eine halbe Datei und wird verworfen.
    return { ok: false, reason: 'aborted' }
  }
  if (tooLarge) {
    return { ok: false, reason: 'too-large' }
  }
  // Ein angekuendigter, aber nicht vollstaendig gelieferter Koerper ist ebenfalls ein Abbruch.
  if (Number.isFinite(declared) && declared !== size) {
    return { ok: false, reason: 'aborted' }
  }
  if (size === 0) {
    return { ok: false, reason: 'empty' }
  }
  return { ok: true, bytes: Buffer.concat(chunks) }
}

/**
 * Sendet Bytes mit ausdruecklichem Typ und ausdruecklicher Cachevorgabe.
 *
 * Es gibt keinen Standardwert fuer `cacheControl`: eine berechtigungsabhaengige Antwort ohne bewusste
 * Cachevorgabe waere genau der Fehler, der ein Bild in einen geteilten Zwischenspeicher legt.
 */
export function sendBytes(
  response: ServerResponse,
  bytes: Uint8Array,
  options: { readonly contentType: string; readonly cacheControl: string },
): void {
  response.writeHead(200, {
    'content-type': options.contentType,
    'content-length': String(bytes.byteLength),
    'cache-control': options.cacheControl,
  })
  response.end(bytes)
}

/** Liest einen kleinen JSON-Koerper. `null` bedeutet: zu gross, kein JSON oder kein Objekt. */
export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const result = await readJsonBodyLimited(request, MAX_JSON_BODY_BYTES)
  return result.ok ? result.body : null
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

/**
 * Loest einen Anfragepfad in eine Datei unterhalb der Wurzel auf. `null` bedeutet: ausserhalb der Wurzel
 * oder nicht vorhanden. Der Vergleich laeuft ueber den aufgeloesten Pfad, damit `..` und Symlink-Tricks
 * nicht aus dem Verzeichnis herausfuehren.
 */
async function resolveStaticFile(root: string, pathname: string): Promise<string | null> {
  const candidate = resolve(root, `.${normalize(pathname)}`)
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return null
  }
  try {
    const info = await stat(candidate)
    return info.isFile() ? candidate : null
  } catch {
    return null
  }
}

function streamFile(response: ServerResponse, filePath: string): void {
  response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' })
  createReadStream(filePath).pipe(response)
}

export type RequestListenerOptions = {
  /** Verzeichnis mit der gebauten SPA. */
  readonly webRoot: string
  readonly rateLimit: RateLimiter
  /** Steht ein Reverse Proxy davor, zaehlt die Ratengrenze dessen `x-forwarded-for` statt der Proxyadresse. */
  readonly trustedProxy: boolean
  readonly metrics: Metrics
  readonly logger: Logger
  /** Zaehlt die Klasse jeder API-Anfrage ein - ohne eine Adresse zu speichern - fuer den Plausibilitaetshinweis. */
  readonly addressMonitor: ClientAddressMonitor
}

/**
 * Betriebsendpunkte: der Docker-`HEALTHCHECK`, der aktive Healthcheck eines beliebigen davorstehenden
 * Reverse Proxy und Monitoring fragen sie regelmaessig und automatisiert ab, unabhaengig vom echten Verkehr
 * und unabhaengig davon, welcher Proxy oder welches Werkzeug fragt. Sie zaehlen deshalb in die Ratengrenze
 * (unveraendert), aber nicht in den Plausibilitaetshinweis der Client-Adresse - sonst wuerde eine kleine
 * Instanz mit wenig echtem Verkehr allein durch diese Anfragen als "ueberwiegend intern" gelten. Die
 * Ausnahme haengt ausschliesslich an diesen Pfaden, nie an einem bestimmten Proxy.
 */
const OPERATIONAL_PATHS: ReadonlySet<string> = new Set([HEALTH_PATH, READY_PATH, METRICS_PATH])

/**
 * Baut den Request-Listener aus Routen und SPA-Wurzel. Unbekannte GET-Pfade fallen auf `index.html`
 * zurueck, damit clientseitige Routen nach einem Neuladen weiter funktionieren.
 *
 * Hier haengen die Dinge, die jede Anfrage betreffen und deshalb an keiner einzelnen Route stehen duerfen:
 * Sicherheitskopfzeilen, die Ratengrenze der API, die Zaehlung der Statusklasse und die Klassifizierung der
 * Client-Adresse fuer den Plausibilitaetshinweis.
 */
export function createRequestListener(routes: readonly Route[], options: RequestListenerOptions): RequestListener {
  const root = resolve(options.webRoot)
  const indexPath = join(root, 'index.html')

  return (request, response) => {
    applySecurityHeaders(response)
    response.on('finish', () => {
      options.metrics.recordResponse(response.statusCode)
    })
    const url = new URL(request.url ?? '/', 'http://localhost')
    void (async () => {
      const method = request.method ?? 'GET'
      // Nur die API: statische Dateien der SPA kommen beim ersten Laden im Dutzend und sind kein Angriffsweg.
      const istApi = url.pathname.startsWith(`${API_BASE_PATH}/`)
      if (istApi) {
        // Eine Ermittlung fuer beides: die Ratengrenze zaehlt die Adresse, der Monitor nur ihre Klasse -
        // und auch nur fuer Anfragen, die nicht vom Betrieb selbst stammen (siehe OPERATIONAL_PATHS).
        const clientAddress = resolveClientAddress(request, options.trustedProxy)
        if (!OPERATIONAL_PATHS.has(url.pathname)) {
          options.addressMonitor.record(clientAddress)
        }
        if (!options.rateLimit.take(clientAddress.address)) {
          options.metrics.recordRateLimited()
          // Ohne Kennung des Clients: die Adresse steht im Zugriffsprotokoll des Reverse Proxy, und das Log
          // der Anwendung soll keine zweite Sammlung davon werden.
          options.logger('warn', 'http.rate.exceeded', { path: url.pathname })
          response.setHeader('retry-after', '1')
          sendError(response, 429, 'Zu viele Anfragen')
          return
        }
      }
      // Erst nach Pfad, dann nach Methode: derselbe Pfad kann mehrere Methoden tragen (`/api/workspaces`
      // listet und legt an), und ein bekannter Pfad mit falscher Methode bleibt eine 405.
      const candidates = routes.filter((candidate) => candidate.path === url.pathname)
      if (candidates.length > 0) {
        const route = candidates.find((candidate) => candidate.method === method)
        if (route === undefined) {
          sendError(response, 405, 'Methode nicht erlaubt')
          return
        }
        await route.handle({ request, response, url })
        return
      }
      if (method !== 'GET') {
        sendError(response, 404, 'Nicht gefunden')
        return
      }
      const file = await resolveStaticFile(root, url.pathname)
      if (file !== null) {
        streamFile(response, file)
        return
      }
      const index = await resolveStaticFile(root, '/index.html')
      if (index === null) {
        sendError(response, 503, `Kein SPA-Build unter ${indexPath}. Zuerst "npm run build" ausfuehren.`)
        return
      }
      streamFile(response, index)
    })().catch((error: unknown) => {
      // Nur Name und Meldung: ein durchgereichtes Fehlerobjekt kann die ausgefuehrte Abfrage samt Parametern
      // tragen, und damit Boardinhalte.
      // Nur der Pfad, nie die Anfragezeile: der Suchbegriff der Nutzersuche steht als Query dahinter.
      options.logger('error', 'http.unhandled', { path: url.pathname, error: describeError(error) })
      if (!response.headersSent) {
        sendError(response, 500, 'Interner Fehler')
      }
      response.end()
    })
  }
}
