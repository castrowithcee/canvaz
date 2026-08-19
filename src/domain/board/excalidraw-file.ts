/**
 * Das offene `.excalidraw`-Dateiformat als Aus- und Eingang eines Boards.
 *
 * Reiner Fachkern ohne IO und **ohne das Excalidraw-Paket**: beschrieben wird hier ein oeffentlich
 * dokumentiertes JSON-Dateiformat, kein Editortyp. Die Regel "Excalidraw erscheint ausschliesslich in
 * `src/web/board/excalidraw-adapter.ts`" bleibt damit unberuehrt - diese Datei importiert nichts davon.
 *
 * ## Warum genau dieses Format
 *
 * Es ist die Datei, die der Editor selbst schreibt und liest: ein Board laesst sich damit in jeder anderen
 * Excalidraw-Installation oeffnen, und ein dort gezeichneter Stand kommt hier wieder herein. Ein eigenes
 * Archivformat waere ein Einschluss und braeuchte einen eigenen Packer; die Bilder stehen im Format ohnehin
 * als `data:`-URL **in** derselben Datei, sodass ein Board mit seinen Bildern eine einzige Datei bleibt.
 *
 * ## Eine Importdatei ist nicht vertrauenswuerdig
 *
 * Sie kommt von aussen und wird deshalb vollstaendig geprueft, bevor irgendetwas davon gespeichert wird:
 *
 * - **Schema**: Typ, Version, Elemente und AppState muessen dem Vertrag entsprechen. Alles andere wird
 *   benannt abgelehnt, nie stillschweigend geglaettet.
 * - **Keine externen Assetzugriffe**: eine Datei darf ausschliesslich als eingebettete `data:`-URL kommen.
 *   Ein `http(s)://`-Verweis wuerde beim Oeffnen des Boards eine fremde Herkunft anfragen und wird
 *   abgelehnt, nicht etwa nachgeladen.
 * - **Kein Scriptinhalt**: der Editor kann an ein Element einen Link haengen. Ein `javascript:`-Link waere
 *   ausfuehrbarer Inhalt in einer Zeichnung und wird abgelehnt.
 *
 * Die Bytes selbst dekodiert diese Datei nicht: sie reicht die Base64-Nutzlast weiter und bleibt damit frei
 * von Plattform-APIs. Ob die Bytes wirklich ein erlaubtes Bild sind, entscheidet danach dieselbe
 * Signaturpruefung wie beim Upload.
 */

import type { PersistedAppState, SyncElement } from '../../contracts/scene.js'
import { parseSyncElements } from '../../contracts/scene.js'

export const EXCALIDRAW_FILE_TYPE = 'excalidraw'

/** Die Formatversion, die geschrieben wird. Gelesen werden `1` und `2`; darueber hinaus wird abgelehnt. */
export const EXCALIDRAW_FILE_VERSION = 2

/** Herkunftsangabe des Formats. Rein beschreibend; beim Einlesen wird sie nicht geprueft. */
export const EXCALIDRAW_FILE_SOURCE = 'canvaz'

/**
 * Hoechstzahl eingebetteter Bilder je Importdatei.
 *
 * Die Bytegrenze allein reicht nicht: sehr viele winzige Dateien waeren ebenso viele Speichervorgaenge und
 * Datensaetze in einer einzigen Anfrage. Der Wert liegt weit ueber allem, was eine Zeichnung braucht.
 */
export const MAX_IMPORT_FILES = 100

/** Ein eingebettetes Bild, wie es im Dateiformat steht. */
export type ExcalidrawFileEntry = {
  readonly id: string
  readonly mimeType: string
  /** Ausschliesslich `data:<mime>;base64,<nutzlast>`. Alles andere waere ein externer Zugriff. */
  readonly dataURL: string
  readonly created: number
}

export type ExcalidrawFile = {
  readonly type: typeof EXCALIDRAW_FILE_TYPE
  readonly version: number
  readonly source: string
  readonly elements: readonly SyncElement[]
  readonly appState: {
    readonly viewBackgroundColor: string
    readonly gridSize: number | null
    readonly gridModeEnabled: boolean
  }
  readonly files: Readonly<Record<string, ExcalidrawFileEntry>>
}

/** Warum eine Datei nicht angenommen wird. Jeder Grund ist benannt; es gibt keine stille Ablehnung. */
export type ExcalidrawImportProblem =
  | 'kein-excalidraw'
  | 'unbekannte-formatversion'
  | 'ungueltige-elemente'
  | 'ungueltiger-appstate'
  | 'ungueltige-datei'
  | 'externe-assetreferenz'
  | 'gefaehrlicher-link'
  | 'zu-viele-dateien'

/** Ein eingebettetes Bild nach der Pruefung. Die Bytes dekodiert der Aufrufer. */
export type ExcalidrawImportFile = {
  readonly id: string
  /** Der Typ aus der `data:`-URL selbst - nicht das danebenstehende `mimeType`, das nichts belegt. */
  readonly mimeType: string
  readonly base64: string
  readonly created: number
}

export type ParsedExcalidrawFile = {
  readonly elements: readonly SyncElement[]
  readonly viewBackgroundColor: string
  readonly gridSize: number | null
  readonly gridModeEnabled: boolean
  readonly files: readonly ExcalidrawImportFile[]
}

export type ExcalidrawParseResult =
  | { readonly ok: true; readonly file: ParsedExcalidrawFile }
  | { readonly ok: false; readonly problem: ExcalidrawImportProblem }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Schemata, die ein Link niemals tragen darf.
 *
 * Geprueft wird nach dem Entfernen von Leerraum und Steuerzeichen, weil `java\nscript:` in einem Browser
 * dasselbe bedeutet wie `javascript:`. Alles Uebrige - `https:`, `mailto:`, ein relativer Pfad - bleibt
 * erlaubt: ein Verweis ist ein legitimer Bestandteil einer Zeichnung.
 */
const DANGEROUS_LINK = /^(javascript|data|vbscript):/i

function isDangerousLink(value: string): boolean {
  return DANGEROUS_LINK.test(value.replace(/[\s\p{Cc}]/gu, ''))
}

/** Base64 im Standardalphabet, mit hoechstens zwei Fuellzeichen am Ende. */
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/
/** Ein MIME-Typ, wie er in einer Data-URL stehen darf. Parameter wie `charset` gehoeren hier nicht hin. */
const DATA_URL_PREFIX = /^data:([a-z]+\/[a-z0-9.+-]+);base64$/i

/**
 * Zerlegt eine eingebettete Data-URL. `null` heisst: keine eingebettete Datei - also entweder eine externe
 * Referenz oder gar keine gueltige URL. Beides wird vom Aufrufer als externer Zugriff abgelehnt.
 */
export function parseDataUrl(value: string): { readonly mimeType: string; readonly base64: string } | null {
  const comma = value.indexOf(',')
  if (comma < 0) {
    return null
  }
  const head = DATA_URL_PREFIX.exec(value.slice(0, comma))
  const mimeType = head?.[1]
  if (mimeType === undefined) {
    return null
  }
  const base64 = value.slice(comma + 1)
  return base64.length > 0 && BASE64_BODY.test(base64) ? { mimeType: mimeType.toLowerCase(), base64 } : null
}

function parseFiles(raw: unknown): ExcalidrawImportFile[] | ExcalidrawImportProblem {
  if (raw === undefined) {
    // Eine Zeichnung ohne Bilder ist der Normalfall; das Feld darf fehlen.
    return []
  }
  if (!isRecord(raw)) {
    return 'ungueltige-datei'
  }
  const entries = Object.entries(raw)
  if (entries.length > MAX_IMPORT_FILES) {
    return 'zu-viele-dateien'
  }
  const files: ExcalidrawImportFile[] = []
  for (const [key, value] of entries) {
    if (!isRecord(value)) {
      return 'ungueltige-datei'
    }
    const { id, dataURL, created } = value
    // Die Kennung steht doppelt im Format. Weichen beide ab, ist unklar, welche das Element meint.
    if (typeof id !== 'string' || id !== key || id.length === 0) {
      return 'ungueltige-datei'
    }
    if (typeof dataURL !== 'string') {
      return 'ungueltige-datei'
    }
    const embedded = parseDataUrl(dataURL)
    if (embedded === null) {
      // Genau hier faellt `"dataURL": "https://fremde.example/bild.png"` durch - es wird nicht geladen.
      return 'externe-assetreferenz'
    }
    files.push({
      id,
      mimeType: embedded.mimeType,
      base64: embedded.base64,
      created: typeof created === 'number' && Number.isFinite(created) ? created : 0,
    })
  }
  return files
}

/**
 * Liest eine Importdatei. Gibt entweder den vollstaendig geprueften Inhalt oder genau einen benannten Grund
 * zurueck - nie eine halbe Szene.
 */
export function parseExcalidrawFile(value: unknown): ExcalidrawParseResult {
  if (!isRecord(value) || value['type'] !== EXCALIDRAW_FILE_TYPE) {
    return { ok: false, problem: 'kein-excalidraw' }
  }
  const version = value['version']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > EXCALIDRAW_FILE_VERSION) {
    return { ok: false, problem: 'unbekannte-formatversion' }
  }
  const elements = parseSyncElements(value['elements'])
  if (elements === null) {
    return { ok: false, problem: 'ungueltige-elemente' }
  }
  for (const element of elements) {
    const link = element['link']
    if (typeof link === 'string' && isDangerousLink(link)) {
      return { ok: false, problem: 'gefaehrlicher-link' }
    }
  }
  const appState = value['appState']
  if (!isRecord(appState)) {
    return { ok: false, problem: 'ungueltiger-appstate' }
  }
  const viewBackgroundColor = appState['viewBackgroundColor']
  const gridSize = appState['gridSize']
  const gridModeEnabled = appState['gridModeEnabled']
  if (
    typeof viewBackgroundColor !== 'string' ||
    !(gridSize === null || gridSize === undefined || (typeof gridSize === 'number' && Number.isFinite(gridSize))) ||
    !(gridModeEnabled === undefined || typeof gridModeEnabled === 'boolean')
  ) {
    return { ok: false, problem: 'ungueltiger-appstate' }
  }
  const files = parseFiles(value['files'])
  if (!Array.isArray(files)) {
    return { ok: false, problem: files }
  }
  return {
    ok: true,
    file: {
      elements,
      viewBackgroundColor,
      gridSize: gridSize ?? null,
      gridModeEnabled: gridModeEnabled ?? false,
      files,
    },
  }
}

/**
 * Baut die Exportdatei.
 *
 * `elements` traegt bewusst **keine** Tombstones: sie sind ein Mittel des Abgleichs und in einer Datei, die
 * ein anderer Editor oeffnen soll, nur unsichtbarer Ballast. `dataUrls` liefert der Aufrufer aus dem
 * Assetspeicher; eine Datei ohne Bytes bleibt draussen, statt als leerer Verweis mitzureisen.
 */
export function toExcalidrawFile(
  elements: readonly SyncElement[],
  appState: PersistedAppState,
  files: readonly { readonly id: string; readonly mimeType: string; readonly created: number }[],
  dataUrls: ReadonlyMap<string, string>,
): ExcalidrawFile {
  const embedded: Record<string, ExcalidrawFileEntry> = {}
  for (const file of files) {
    const dataURL = dataUrls.get(file.id)
    if (dataURL !== undefined) {
      embedded[file.id] = { id: file.id, mimeType: file.mimeType, dataURL, created: file.created }
    }
  }
  return {
    type: EXCALIDRAW_FILE_TYPE,
    version: EXCALIDRAW_FILE_VERSION,
    source: EXCALIDRAW_FILE_SOURCE,
    elements: elements.filter((element) => element.isDeleted !== true),
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      gridSize: appState.gridSize,
      gridModeEnabled: appState.gridModeEnabled,
    },
    files: embedded,
  }
}
