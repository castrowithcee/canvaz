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

import type { ErrorResponse } from '../contracts/api.js'

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

function sendError(response: ServerResponse, status: number, message: string): void {
  const body: ErrorResponse = { error: message }
  sendJson(response, status, body)
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

/**
 * Baut den Request-Listener aus Routen und SPA-Wurzel. Unbekannte GET-Pfade fallen auf `index.html`
 * zurueck, damit clientseitige Routen nach einem Neuladen weiter funktionieren.
 */
export function createRequestListener(routes: readonly Route[], webRoot: string): RequestListener {
  const root = resolve(webRoot)
  const indexPath = join(root, 'index.html')

  return (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const method = request.method ?? 'GET'
      const route = routes.find((candidate) => candidate.path === url.pathname)
      if (route !== undefined) {
        if (route.method !== method) {
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
      console.error('Unbehandelter Anfragefehler', error)
      if (!response.headersSent) {
        sendError(response, 500, 'Interner Fehler')
      }
      response.end()
    })
  }
}
