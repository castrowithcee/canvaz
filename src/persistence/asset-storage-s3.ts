/**
 * S3-Adapter des Storage-Ports (AWS S3 und S3-kompatible Server wie SeaweedFS).
 *
 * ## Warum kein SDK
 *
 * Gebraucht werden drei Aufrufe auf genau einem Bucket: `PUT`, `GET`, `DELETE`. Alles, was `@aws-sdk/client-s3`
 * darueber hinaus mitbringt - Paginierung, Multipart, Presigning, Retry-Strategien, Credential-Provider-Kette,
 * Middleware-Stack - braucht dieses Paket nicht und wuerde die Abhaengigkeitsflaeche einer selbst gehosteten
 * Anwendung um mehrere Dutzend Pakete vergroessern. Der einzige nicht triviale Teil ist die Signatur, und die
 * ist als AWS Signature Version 4 vollstaendig spezifiziert und mit `node:crypto` in wenigen Zeilen
 * geschrieben. HTTP macht `fetch` aus der Laufzeit.
 *
 * Der Nachweis dafuer ist die gemeinsame Contract-Testsuite: dieselben Faelle laufen unveraendert gegen den
 * Dateisystem-Adapter und gegen diesen Adapter vor einem echten SeaweedFS.
 *
 * ## Was dieser Adapter nicht tut
 *
 * Er stellt **keine vorsignierten URLs** aus. Der Abruf laeuft immer ueber den autorisierten Endpunkt der
 * Anwendung; ein Bucket-Objekt ist von aussen nie erreichbar. Damit gibt es keinen Zugriff, der einen
 * Berechtigungsentzug ueberleben koennte.
 */

import { createHash, createHmac } from 'node:crypto'

import type { AssetStoragePort } from '../domain/storage/asset-storage-port.js'
import { assertStorageKey } from '../domain/storage/asset-storage-port.js'

export type S3StorageConfig = {
  /** Basis-URL des Dienstes, z. B. `https://s3.eu-central-1.amazonaws.com` oder `http://127.0.0.1:59000`. */
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** MinIO und aeltere Installationen adressieren den Bucket im Pfad statt im Hostnamen. */
  readonly forcePathStyle: boolean
}

const ALGORITHM = 'AWS4-HMAC-SHA256'
const EMPTY = new Uint8Array(0)

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** `YYYYMMDDTHHMMSSZ`, das von SigV4 verlangte Format. */
function amzTimestamp(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`
}

/**
 * Zielpfad einer Anfrage. Ein leerer Schluessel meint den Bucket selbst.
 *
 * Der erlaubte Schluesselzeichenvorrat (`assertStorageKey`) enthaelt ausschliesslich Zeichen, die in einer
 * URI unveraendert stehen duerfen. Der kanonische Pfad der Signatur ist deshalb zeichengleich mit dem
 * angefragten Pfad; eine Kodierungsabweichung zwischen beiden kann es nicht geben.
 */
function locate(config: S3StorageConfig, key: string): { readonly url: URL; readonly canonicalUri: string } {
  const endpoint = new URL(config.endpoint)
  const path = key === '' ? '' : `/${assertStorageKey(key)}`
  const url = new URL(endpoint)
  if (config.forcePathStyle) {
    const canonicalUri = `/${config.bucket}${path}`
    url.pathname = canonicalUri
    return { url, canonicalUri }
  }
  url.host = `${config.bucket}.${endpoint.host}`
  const canonicalUri = path === '' ? '/' : path
  url.pathname = canonicalUri
  return { url, canonicalUri }
}

/** Eine einzelne signierte Anfrage. Bewusst zustandslos: es gibt keine Verbindung und keinen Cache. */
async function send(
  config: S3StorageConfig,
  method: string,
  key: string,
  body: Uint8Array | null,
): Promise<Response> {
  const { url, canonicalUri } = locate(config, key)
  const payloadHash = sha256Hex(body ?? EMPTY)
  const timestamp = amzTimestamp(new Date())
  const dateStamp = timestamp.slice(0, 8)
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const stringToSign = [ALGORITHM, timestamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'),
    'aws4_request',
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')

  const headers: Record<string, string> = {
    'x-amz-date': timestamp,
    'x-amz-content-sha256': payloadHash,
    authorization: `${ALGORITHM} Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
  if (body === null) {
    return fetch(url, { method, headers })
  }
  headers['content-length'] = String(body.byteLength)
  // `slice()` liefert eine Kopie mit eigenem ArrayBuffer - genau die Form, die `fetch` als Koerper annimmt.
  return fetch(url, { method, headers, body: body.slice() })
}

/** Der Fehlertext des Dienstes gehoert ins Serverlog, nie in die Antwort an den Client. */
async function fail(config: S3StorageConfig, method: string, key: string, response: Response): Promise<never> {
  const detail = await response.text().catch(() => '')
  throw new Error(
    `S3 ${method} ${config.bucket}/${key} fehlgeschlagen (${String(response.status)}): ${detail.slice(0, 500)}`,
  )
}

export function createS3AssetStorage(config: S3StorageConfig): AssetStoragePort {
  return {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      // Der leere Schluessel meint intern den Bucket selbst und ist ueber den Port deshalb nie zulaessig.
      assertStorageKey(key)
      // Ein einzelnes PUT ist beim Objektspeicher die atomare Einheit: entweder das ganze Objekt oder keines.
      const response = await send(config, 'PUT', key, bytes)
      if (!response.ok) {
        await fail(config, 'PUT', key, response)
      }
      await response.arrayBuffer()
    },

    async get(key: string): Promise<Uint8Array | null> {
      assertStorageKey(key)
      const response = await send(config, 'GET', key, null)
      if (response.status === 404) {
        await response.arrayBuffer()
        return null
      }
      if (!response.ok) {
        await fail(config, 'GET', key, response)
      }
      return new Uint8Array(await response.arrayBuffer())
    },

    async delete(key: string): Promise<void> {
      assertStorageKey(key)
      const response = await send(config, 'DELETE', key, null)
      if (!response.ok && response.status !== 404) {
        await fail(config, 'DELETE', key, response)
      }
      await response.arrayBuffer()
    },
  }
}

/**
 * Legt den Bucket an, falls er fehlt.
 *
 * Fuer die lokale Entwicklung und die Tests gegen SeaweedFS. Im Betrieb legt der Betreiber den Bucket an; die
 * Anwendung ruft das nie von selbst auf, weil sie sonst dauerhaft Rechte braeuchte, die sie fuer ihren
 * Betrieb nicht hat.
 */
export async function ensureS3Bucket(config: S3StorageConfig): Promise<void> {
  const response = await send(config, 'PUT', '', null)
  // 409 heisst: gibt es schon und gehoert uns. Das ist genau der gewuenschte Zustand.
  if (!response.ok && response.status !== 409) {
    await fail(config, 'PUT', '', response)
  }
  await response.arrayBuffer()
}
