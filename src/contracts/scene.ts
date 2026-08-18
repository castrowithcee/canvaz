/**
 * Serialisierbarer Boardzustand des Spikes.
 *
 * Diese Datei ist die Grenze zwischen Editor und Rest des Systems: Server, Persistenz und Tests kennen
 * ausschliesslich diese Typen und niemals das Excalidraw-Paket. Der Client-Adapter uebersetzt an genau
 * einer Stelle zwischen Excalidraw-Typen und diesen Typen.
 */

export const SCENE_SCHEMA_VERSION = 1 as const

/**
 * Minimalvertrag eines Zeichenelements. Excalidraw-Elemente erfuellen ihn strukturell; alle weiteren
 * Felder werden unveraendert durchgereicht, damit ein Roundtrip nichts verliert.
 */
export type SyncElement = {
  readonly id: string
  readonly version: number
  readonly versionNonce: number
  readonly isDeleted?: boolean
} & Record<string, unknown>

/**
 * Referenz auf ein Binaerasset. Der Spike transportiert bewusst keine Bytes ueber den Sync-Kanal; das
 * Produkt laedt sie spaeter ueber den Storage-Port.
 */
export type BinaryFileRef = {
  readonly id: string
  readonly mimeType: string
  readonly created: number
  readonly byteSize: number
  readonly storageKey: string
}

/**
 * Persistierte Teilmenge des Excalidraw-AppState. Bewusst klein: Kamera, Auswahl und UI-Zustand sind
 * clientlokal und gehoeren nicht in den geteilten Boardzustand.
 */
export type PersistedAppState = {
  readonly viewBackgroundColor: string
  readonly gridSize: number | null
  readonly gridModeEnabled: boolean
  readonly name: string
}

export type SceneSnapshot = {
  readonly schemaVersion: typeof SCENE_SCHEMA_VERSION
  readonly boardId: string
  readonly elements: readonly SyncElement[]
  readonly appState: PersistedAppState
  readonly files: Readonly<Record<string, BinaryFileRef>>
  readonly updatedAt: number
}

export const DEFAULT_APP_STATE: PersistedAppState = {
  viewBackgroundColor: '#ffffff',
  gridSize: null,
  gridModeEnabled: false,
  name: 'Unbenanntes Board',
}

export function createEmptySnapshot(boardId: string, updatedAt: number): SceneSnapshot {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    boardId,
    elements: [],
    appState: DEFAULT_APP_STATE,
    files: {},
    updatedAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Eine Zahl, die auch wieder zurueckgelesen werden kann: `Infinity` und `NaN` sind keine. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isSyncElement(value: unknown): value is SyncElement {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    value['id'].length > 0 &&
    isFiniteNumber(value['version']) &&
    isFiniteNumber(value['versionNonce']) &&
    (value['isDeleted'] === undefined || typeof value['isDeleted'] === 'boolean')
  )
}

export function parseSyncElements(value: unknown): SyncElement[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const elements: SyncElement[] = []
  for (const entry of value) {
    if (!isSyncElement(entry)) {
      return null
    }
    elements.push(entry)
  }
  return elements
}

function parseBinaryFileRef(value: unknown): BinaryFileRef | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, mimeType, created, byteSize, storageKey } = value
  if (
    typeof id !== 'string' ||
    typeof mimeType !== 'string' ||
    !isFiniteNumber(created) ||
    !isFiniteNumber(byteSize) ||
    typeof storageKey !== 'string'
  ) {
    return null
  }
  return { id, mimeType, created, byteSize, storageKey }
}

export function parsePersistedAppState(value: unknown): PersistedAppState | null {
  if (!isRecord(value)) {
    return null
  }
  const { viewBackgroundColor, gridSize, gridModeEnabled, name } = value
  if (
    typeof viewBackgroundColor !== 'string' ||
    !(gridSize === null || isFiniteNumber(gridSize)) ||
    typeof gridModeEnabled !== 'boolean' ||
    typeof name !== 'string'
  ) {
    return null
  }
  return { viewBackgroundColor, gridSize, gridModeEnabled, name }
}

/**
 * Liest einen persistierten Snapshot zurueck. Gibt `null` statt einer Teilszene zurueck, damit ein
 * beschaedigter Datensatz nie still als leeres Board erscheint.
 */
export function parseSceneSnapshot(value: unknown): SceneSnapshot | null {
  if (!isRecord(value) || value['schemaVersion'] !== SCENE_SCHEMA_VERSION) {
    return null
  }
  const boardId = value['boardId']
  const updatedAt = value['updatedAt']
  if (typeof boardId !== 'string' || boardId.length === 0 || !isFiniteNumber(updatedAt)) {
    return null
  }
  const elements = parseSyncElements(value['elements'])
  const appState = parsePersistedAppState(value['appState'])
  if (elements === null || appState === null) {
    return null
  }
  const rawFiles = value['files']
  if (!isRecord(rawFiles)) {
    return null
  }
  const files: Record<string, BinaryFileRef> = {}
  for (const [key, rawFile] of Object.entries(rawFiles)) {
    const file = parseBinaryFileRef(rawFile)
    if (file === null || file.id !== key) {
      return null
    }
    files[key] = file
  }
  return { schemaVersion: SCENE_SCHEMA_VERSION, boardId, elements, appState, files, updatedAt }
}

/**
 * Werte, die JSON zwar transportiert, die aber nicht zurueckgelesen werden koennen, was gespeichert wurde.
 *
 * - `nicht-endliche-zahl`: `1e400` ist gueltiges JSON und wird beim Parsen zu `Infinity`. `JSON.stringify`
 *   macht daraus `null`; die Zahl waere still verschwunden, und auf oberster Ebene liesse sie den Snapshot
 *   beim Zuruecklesen scheitern.
 * - `nul-zeichen` und `einsames-surrogat`: beides kann PostgreSQL in `jsonb` nicht speichern.
 * - `zu-tiefe-struktur`: `JSON.stringify` bricht bei einigen tausend Ebenen mit einem `RangeError` ab.
 *   Ohne eigene Grenze wuerde daraus ein unbenannter Serverfehler statt einer benannten Ablehnung.
 *
 * Geprueft wird rekursiv, einschliesslich der unbekannten Zusatzfelder von Elementen, die der Vertrag
 * bewusst unveraendert durchreicht, und einschliesslich der Objektschluessel.
 */
export type UnstorableReason =
  | 'nicht-endliche-zahl'
  | 'nul-zeichen'
  | 'einsames-surrogat'
  | 'zu-tiefe-struktur'

/**
 * Groesste zulaessige Verschachtelungstiefe eines Szenenwerts.
 *
 * Excalidraw-Szenen sind flach: Elemente stehen nebeneinander, tiefer als eine Punktliste in einem Element
 * wird es nicht. Der Wert liegt weit darueber und weit unter der Grenze, an der `JSON.stringify` oder diese
 * Rekursion selbst aufgeben.
 */
const MAX_SCENE_DEPTH = 256

/** Ein Codepunkt aus dem Surrogatbereich, also eine Haelfte ohne ihr Gegenstueck. Ein Paar matcht nicht. */
const LONE_SURROGATE = /\p{Cs}/u

function unstorableInText(value: string): UnstorableReason | null {
  if (value.includes('\u0000')) {
    return 'nul-zeichen'
  }
  return LONE_SURROGATE.test(value) ? 'einsames-surrogat' : null
}

/** Der erste Grund, aus dem sich `value` nicht verlustfrei speichern laesst, oder `null`. */
export function findUnstorableValue(value: unknown, depth = 0): UnstorableReason | null {
  if (depth > MAX_SCENE_DEPTH) {
    return 'zu-tiefe-struktur'
  }
  if (typeof value === 'number') {
    return isFiniteNumber(value) ? null : 'nicht-endliche-zahl'
  }
  if (typeof value === 'string') {
    return unstorableInText(value)
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const reason = findUnstorableValue(entry, depth + 1)
      if (reason !== null) {
        return reason
      }
    }
    return null
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const reason = unstorableInText(key) ?? findUnstorableValue(entry, depth + 1)
      if (reason !== null) {
        return reason
      }
    }
  }
  return null
}

export function serializeSceneSnapshot(snapshot: SceneSnapshot): string {
  return JSON.stringify(snapshot)
}

export function deserializeSceneSnapshot(raw: string): SceneSnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return parseSceneSnapshot(parsed)
}
