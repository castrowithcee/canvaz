/**
 * Realtime-Protokoll zwischen Browser und Boardraum.
 *
 * Geteilter Vertrag wie `api.ts`: beide Seiten importieren dieselben Typen, und **die Validierung steht
 * genau einmal hier**. Der Server nimmt keine Nachricht an, die nicht durch `parseClientMessage` gegangen
 * ist; ein unbekannter Typ, eine fehlerhafte Struktur oder ein fremder Boardbezug ergeben eine benannte
 * Ablehnung und lassen die Verbindung in ihrem bisherigen Zustand.
 *
 * ## Zustandsmaschine einer Verbindung
 *
 * ```
 * verbunden --join--> beigetreten --leave--> verbunden
 *     |                    |
 *     +--------------------+--> geschlossen (Socket zu, Sitzung ungueltig, Zugriff entzogen)
 * ```
 *
 * `verbunden` nimmt ausschliesslich `join` an, `beigetreten` alles andere. Eine Verbindung ist zu jedem
 * Zeitpunkt in hoechstens einem Raum; ein zweites `join` wird abgelehnt, statt den Raum stillschweigend zu
 * wechseln.
 *
 * ## Versionierung
 *
 * `REALTIME_PROTOCOL_VERSION` steht im `ready` des Servers und im `join` des Clients. Weichen sie ab, wird
 * der Beitritt abgelehnt - ein Browser mit altem Bundle nach einem Deployment soll neu laden und nicht mit
 * halb verstandenen Nachrichten weiterarbeiten.
 */

import type { BinaryFileRef, PersistedAppState, SceneSnapshot, SyncElement } from './scene.js'
import { parsePersistedAppState, parseSyncElements } from './scene.js'

export const REALTIME_PROTOCOL_VERSION = 1 as const

/* ---------------------------------------------------------------------------------------------------- */
/* Schliessgruende                                                                                       */
/* ---------------------------------------------------------------------------------------------------- */

/**
 * Alle anwendungsdefinierten Schliessgruende stehen hier, weil beide Seiten sie brauchen: der Server setzt
 * sie, und der Client entscheidet daran, ob er einen Wiederverbindungsversuch startet oder aufgibt.
 */

/** Die Sitzung wurde serverseitig ungueltig (Logout, Deaktivierung, Ablauf). Neu anmelden, nicht neu verbinden. */
export const SESSION_REVOKED_CLOSE_CODE = 4401

/**
 * Die Berechtigung fuer dieses Board ist entfallen. Bewusst getrennt von `SESSION_REVOKED_CLOSE_CODE` -
 * die Sitzung selbst bleibt gueltig, nur der Raum ist verloren.
 */
export const BOARD_ACCESS_REVOKED_CLOSE_CODE = 4403

/**
 * Der ausgehende Puffer dieser Verbindung ist nicht mehr abgeflossen. Ausdruecklich **kein** Endzustand:
 * genau dafuer gibt es den Rueckzugstakt und den vollstaendigen Abgleich beim Wiederbeitritt.
 */
export const SLOW_CLIENT_CLOSE_CODE = 4408

/** Eine Mengengrenze ist erreicht (Verbindungen je Nutzer, Nachrichtenrate). Ein Sofortversuch hilft nicht. */
export const TOO_MANY_CLOSE_CODE = 4429

/**
 * Standardcode fuer einen zu grossen Rahmen. Nicht von dieser Anwendung gesetzt, sondern von `ws` selbst,
 * sobald `maxPayload` ueberschritten wird - er steht hier, weil der Client ihn erkennen muss.
 */
export const MESSAGE_TOO_BIG_CLOSE_CODE = 1009

/**
 * Schliessgruende, nach denen ein erneuter Verbindungsversuch nichts aendern wuerde.
 *
 * Alles andere ist ein Netzproblem oder ein Neustart des Servers und wird mit Rueckzugstakt wiederholt.
 */
export const TERMINAL_CLOSE_CODES: readonly number[] = [
  SESSION_REVOKED_CLOSE_CODE,
  BOARD_ACCESS_REVOKED_CLOSE_CODE,
  TOO_MANY_CLOSE_CODE,
  MESSAGE_TOO_BIG_CLOSE_CODE,
]

/**
 * Hoechstzahl uebertragener Auswahlkennungen je Presence-Nachricht. Presence ist eine Anzeigehilfe; wer
 * mehr auswaehlt, wird angezeigt, aber nicht vollstaendig uebertragen.
 */
export const MAX_PRESENCE_SELECTION = 200

/** Hoechstzahl neuer Dateikennungen je Aenderungsnachricht. Ueblich ist null oder eine. */
export const MAX_CHANGE_FILE_IDS = 64

/**
 * Hoechstzahl Elemente je Aenderungsnachricht.
 *
 * Anders als bei Presence und Dateikennungen wird hier **nicht gekappt**: eine gekuerzte Elementliste waere
 * stiller Datenverlust. Die Nachricht wird benannt abgelehnt, und der Client teilt seinen Stand in mehrere
 * Nachrichten auf - der Wiederaufnahmefall nach einem Abbruch ist der einzige, in dem ueberhaupt viele
 * Elemente auf einmal anfallen.
 *
 * Der Wert liegt weit ueber jeder laufenden Aenderung (Excalidraw meldet einzelne Elemente) und weit unter
 * dem, was `maxPayload` ohnehin durchlaesst.
 */
export const MAX_CHANGE_ELEMENTS = 2_000

export type RealtimeErrorCode =
  /** Der Client spricht eine andere Protokollversion. */
  | 'protokoll-version'
  /** Struktur oder Feldtypen passen nicht zum Vertrag. */
  | 'ungueltige-nachricht'
  /** Der Nachrichtentyp ist unbekannt. */
  | 'unbekannter-typ'
  /** In diesem Verbindungszustand ist die Nachricht nicht vorgesehen. */
  | 'falscher-zustand'
  /** Das Board existiert nicht oder ist fuer diesen Nutzer nicht sichtbar. Beides ergibt dieselbe Antwort. */
  | 'board-nicht-gefunden'
  /** Sichtbar, aber ohne Schreibrecht. Die Aenderung wurde verworfen. */
  | 'kein-schreibrecht'
  /** Ein Wert der Szene laesst sich nicht speichern (NUL, einsames Surrogat, nicht endliche Zahl, zu tief). */
  | 'nicht-speicherbar'
  /** Der gespeicherte Stand liess sich nicht in den Szenenvertrag lesen. */
  | 'szene-beschaedigt'
  /** Mehr Elemente in einer Nachricht als `MAX_CHANGE_ELEMENTS`. Nichts wurde uebernommen. */
  | 'zu-viele-elemente'
  /** Die Nachrichtenrate dieser Verbindung ist ueberschritten. Die Nachricht wurde verworfen. */
  | 'zu-viele-nachrichten'
  /** Der Raumzustand wuerde durch diese Aenderung seine Obergrenze ueberschreiten. */
  | 'raum-zu-gross'
  /** Der Raum hat bereits die hoechstzulaessige Zahl gleichzeitiger Teilnehmer. */
  | 'raum-voll'
  /** Dieses Konto haelt bereits die hoechstzulaessige Zahl offener Verbindungen. */
  | 'zu-viele-verbindungen'
  /** Der ausgehende Puffer dieser Verbindung ist nicht mehr abgeflossen. */
  | 'zu-langsam'

export const REALTIME_ERROR_MESSAGES: Readonly<Record<RealtimeErrorCode, string>> = {
  'protokoll-version': 'Diese Seite ist veraltet. Bitte neu laden.',
  'ungueltige-nachricht': 'Die Nachricht entspricht nicht dem erwarteten Format',
  'unbekannter-typ': 'Unbekannter Nachrichtentyp',
  'falscher-zustand': 'In diesem Verbindungszustand ist die Nachricht nicht vorgesehen',
  'board-nicht-gefunden': 'Board nicht gefunden',
  'kein-schreibrecht': 'Keine Berechtigung, dieses Board zu aendern',
  'nicht-speicherbar': 'Die Aenderung enthaelt einen Wert, der sich nicht speichern laesst',
  'szene-beschaedigt': 'Die gespeicherte Szene ist beschaedigt und kann nicht geoeffnet werden',
  'zu-viele-elemente': 'Die Nachricht enthaelt zu viele Elemente auf einmal',
  'zu-viele-nachrichten': 'Zu viele Nachrichten in zu kurzer Zeit',
  'raum-zu-gross': 'Dieses Board hat seine Hoechstgroesse erreicht. Die Aenderung wurde nicht uebernommen.',
  'raum-voll': 'Dieses Board hat bereits die hoechstzulaessige Zahl gleichzeitiger Teilnehmer',
  'zu-viele-verbindungen': 'Dieses Konto hat bereits die hoechstzulaessige Zahl offener Verbindungen',
  'zu-langsam': 'Die Verbindung kommt nicht mehr hinterher und wird neu aufgebaut',
}

export type PointerPosition = {
  readonly x: number
  readonly y: number
}

/**
 * Was ein Teilnehmer von einem anderen sieht.
 *
 * Bewusst sparsam: eine fluechtige Kennung der Verbindung, der Anzeigename und der Zeigezustand. **Keine
 * E-Mail, keine Nutzerkennung, keine Rolle** - der Anzeigename steht ohnehin schon in der Mitgliederliste,
 * alles Weitere wuerde Presence zu einer Auskunft ueber Konten machen. `canWrite` ist keine Rolle, sondern
 * die Aussage, ob die Zeichnung dieses Teilnehmers ankommen kann.
 */
export type PresenceView = {
  readonly clientId: string
  readonly displayName: string
  readonly canWrite: boolean
  readonly pointer: PointerPosition | null
  readonly selectedElementIds: readonly string[]
}

/* ---------------------------------------------------------------------------------------------------- */
/* Client zum Server                                                                                     */
/* ---------------------------------------------------------------------------------------------------- */

export type JoinMessage = {
  readonly type: 'join'
  readonly protocolVersion: number
  readonly boardId: string
}

export type LeaveMessage = {
  readonly type: 'leave'
  readonly boardId: string
}

/**
 * Geaenderte Elemente eines Teilnehmers. Es werden nur die tatsaechlich veraenderten Elemente uebertragen;
 * welcher Stand gewinnt, entscheidet die Reconciliation und nicht die Reihenfolge der Nachrichten.
 *
 * `fileIds` nennt ausschliesslich Kennungen. Groesse, Typ und Speicherschluessel loest der Server aus
 * `board_assets` auf - der Client denkt sie sich nicht aus.
 */
export type SceneChangeMessage = {
  readonly type: 'scene-change'
  readonly boardId: string
  readonly elements: readonly SyncElement[]
  readonly appState: PersistedAppState | null
  readonly fileIds: readonly string[]
  /** Monotone Kennung der lokalen Aenderung; alte Clients duerfen das Feld noch auslassen. */
  readonly clientChangeSequence?: number
}

export type PresenceMessage = {
  readonly type: 'presence'
  readonly boardId: string
  readonly pointer: PointerPosition | null
  readonly selectedElementIds: readonly string[]
}

/** Bitte um den vollstaendigen Raumzustand. Traegt den Abgleich nach einem Abbruch und nach Backpressure. */
export type ResyncMessage = {
  readonly type: 'resync'
  readonly boardId: string
}

export type ClientMessage = JoinMessage | LeaveMessage | SceneChangeMessage | PresenceMessage | ResyncMessage

/* ---------------------------------------------------------------------------------------------------- */
/* Server zum Client                                                                                     */
/* ---------------------------------------------------------------------------------------------------- */

/** Erste Nachricht nach dem Upgrade: die Verbindung ist authentifiziert, aber noch in keinem Raum. */
export type ReadyMessage = {
  readonly type: 'ready'
  readonly protocolVersion: number
  readonly userId: string
}

export type JoinedMessage = {
  readonly type: 'joined'
  readonly boardId: string
  /** Fluechtige Kennung dieser Verbindung. Der Client erkennt daran sich selbst im Teilnehmerfeld. */
  readonly clientId: string
  readonly canWrite: boolean
  /** Zuletzt persistierte Szenenversion des Raums. */
  readonly version: number
  readonly scene: SceneSnapshot
  readonly peers: readonly PresenceView[]
}

/** Antwort auf `resync`: derselbe Inhalt wie `joined`, ohne den Beitritt zu wiederholen. */
export type SnapshotMessage = {
  readonly type: 'snapshot'
  readonly boardId: string
  readonly version: number
  readonly scene: SceneSnapshot
}

/** Weitergabe einer angenommenen Aenderung an die **anderen** Teilnehmer; nie an den Absender zurueck. */
export type SceneBroadcastMessage = {
  readonly type: 'scene-change'
  readonly boardId: string
  readonly elements: readonly SyncElement[]
  readonly appState: PersistedAppState | null
  /** Neu im Raum bekannte Bildreferenzen; die Bytes holt der Empfaenger ueber den autorisierten Endpunkt. */
  readonly files: readonly BinaryFileRef[]
}

/** Vollstaendiges Teilnehmerfeld. Bewusst keine Einzelereignisse: bei zehn Verbindungen ist die Liste klein. */
export type PresenceBroadcastMessage = {
  readonly type: 'presence'
  readonly boardId: string
  readonly peers: readonly PresenceView[]
}

/** Die effektive Berechtigung hat sich waehrend der Verbindung geaendert. */
export type AccessMessage = {
  readonly type: 'access'
  readonly boardId: string
  readonly canWrite: boolean
}

/** Ein Checkpoint wurde persistiert. Der Editor macht daraus seinen Speicherstatus. */
export type SavedMessage = {
  readonly type: 'saved'
  readonly boardId: string
  readonly version: number
  /** ISO-8601. */
  readonly savedAt: string
  /** Hoechste lokale Aenderungskennung dieser Verbindung, die in diesem Checkpoint enthalten ist. */
  readonly clientChangeSequence?: number
}

export type LeftMessage = {
  readonly type: 'left'
  readonly boardId: string
}

export type ErrorMessage = {
  readonly type: 'error'
  readonly code: RealtimeErrorCode
  readonly message: string
}

export type ServerMessage =
  | ReadyMessage
  | JoinedMessage
  | SnapshotMessage
  | SceneBroadcastMessage
  | PresenceBroadcastMessage
  | AccessMessage
  | SavedMessage
  | LeftMessage
  | ErrorMessage

/* ---------------------------------------------------------------------------------------------------- */
/* Validierung                                                                                           */
/* ---------------------------------------------------------------------------------------------------- */

export type ParsedClientMessage =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly code: RealtimeErrorCode }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parsePointer(value: unknown): PointerPosition | null | undefined {
  if (value === null) {
    return null
  }
  if (!isRecord(value) || !isFiniteNumber(value['x']) || !isFiniteNumber(value['y'])) {
    return undefined
  }
  return { x: value['x'], y: value['y'] }
}

/** Zeichenketten aus einer Liste, gekappt auf `limit`. `null` heisst: keine Liste oder falsche Elemente. */
function parseIdList(value: unknown, limit: number): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return null
    }
    if (ids.length < limit) {
      ids.push(entry)
    }
  }
  return ids
}

const INVALID = { ok: false, code: 'ungueltige-nachricht' } as const

/**
 * Einziger Weg von einem Rahmen zu einer Nachricht.
 *
 * Nimmt bewusst `string` statt eines Puffers entgegen: der Aufrufer entscheidet, ob ein Binaerrahmen
 * ueberhaupt zugelassen ist, und die Groessengrenze liegt bereits am WebSocket-Server.
 */
export function parseClientMessage(raw: string): ParsedClientMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return INVALID
  }
  if (!isRecord(parsed)) {
    return INVALID
  }
  const type = parsed['type']
  if (typeof type !== 'string') {
    return INVALID
  }
  switch (type) {
    case 'join': {
      const { protocolVersion, boardId } = parsed
      if (typeof boardId !== 'string' || boardId.length === 0 || !isFiniteNumber(protocolVersion)) {
        return INVALID
      }
      return { ok: true, message: { type: 'join', protocolVersion, boardId } }
    }
    case 'leave':
    case 'resync': {
      const boardId = parsed['boardId']
      if (typeof boardId !== 'string' || boardId.length === 0) {
        return INVALID
      }
      return { ok: true, message: { type, boardId } }
    }
    case 'scene-change': {
      const boardId = parsed['boardId']
      const elements = parseSyncElements(parsed['elements'])
      const rawAppState = parsed['appState']
      const appState = rawAppState === null ? null : parsePersistedAppState(rawAppState)
      const fileIds = parseIdList(parsed['fileIds'], MAX_CHANGE_FILE_IDS)
      const rawClientChangeSequence = parsed['clientChangeSequence']
      if (typeof boardId !== 'string' || boardId.length === 0 || elements === null || fileIds === null) {
        return INVALID
      }
      if (rawAppState !== null && appState === null) {
        return INVALID
      }
      if (
        rawClientChangeSequence !== undefined &&
        (!isFiniteNumber(rawClientChangeSequence) ||
          !Number.isInteger(rawClientChangeSequence) ||
          rawClientChangeSequence < 0)
      ) {
        return INVALID
      }
      if (elements.length > MAX_CHANGE_ELEMENTS) {
        // Bewusst eine Ablehnung statt einer Kappung: eine halbe Elementliste waere stiller Datenverlust.
        return { ok: false, code: 'zu-viele-elemente' }
      }
      return {
        ok: true,
        message: {
          type: 'scene-change',
          boardId,
          elements,
          appState,
          fileIds,
          ...(rawClientChangeSequence === undefined ? {} : { clientChangeSequence: rawClientChangeSequence }),
        },
      }
    }
    case 'presence': {
      const boardId = parsed['boardId']
      const pointer = parsePointer(parsed['pointer'])
      const selectedElementIds = parseIdList(parsed['selectedElementIds'], MAX_PRESENCE_SELECTION)
      if (typeof boardId !== 'string' || boardId.length === 0 || pointer === undefined || selectedElementIds === null) {
        return INVALID
      }
      return { ok: true, message: { type: 'presence', boardId, pointer, selectedElementIds } }
    }
    default:
      return { ok: false, code: 'unbekannter-typ' }
  }
}
