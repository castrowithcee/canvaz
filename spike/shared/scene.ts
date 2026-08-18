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

export function isSyncElement(value: unknown): value is SyncElement {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    value['id'].length > 0 &&
    typeof value['version'] === 'number' &&
    Number.isFinite(value['version']) &&
    typeof value['versionNonce'] === 'number' &&
    Number.isFinite(value['versionNonce']) &&
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
    typeof created !== 'number' ||
    typeof byteSize !== 'number' ||
    typeof storageKey !== 'string'
  ) {
    return null
  }
  return { id, mimeType, created, byteSize, storageKey }
}

function parseAppState(value: unknown): PersistedAppState | null {
  if (!isRecord(value)) {
    return null
  }
  const { viewBackgroundColor, gridSize, gridModeEnabled, name } = value
  if (
    typeof viewBackgroundColor !== 'string' ||
    !(gridSize === null || typeof gridSize === 'number') ||
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
  if (typeof boardId !== 'string' || boardId.length === 0 || typeof updatedAt !== 'number') {
    return null
  }
  const elements = parseSyncElements(value['elements'])
  const appState = parseAppState(value['appState'])
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
