/**
 * Der Zustand eines Boards, verdichtet fuer die schwebende Gruppe des Editors.
 *
 * Bisher standen Bearbeitungsmodus, Speicherstatus und Verbindung als drei ausformulierte Saetze
 * gleichrangig in der Leiste und verdraengten die Zeichenflaeche. Angezeigt wird jetzt **eine** kurze
 * Zeile; der ausformulierte Satz bleibt als Erlaeuterung daneben stehen und wird nur bei Bedarf gelesen.
 *
 * Diese Datei ist reine Rechnung ohne DOM und ohne React: sie waehlt aus den gleichzeitig moeglichen
 * Zustaenden den einen, der jetzt zaehlt. Die Reihenfolge ist die fachliche Dringlichkeit - was Arbeit
 * gefaehrdet, steht vor dem, was nur beschreibt.
 *
 * `critical` entscheidet, ob der Zustand angekuendigt wird. Ein gelungener Checkpoint ist sichtbar, wird
 * aber **nicht** vorgelesen: sonst spraeche eine Sprachausgabe waehrend des Zeichnens im Sekundentakt.
 * Konflikt, Fehlschlag und Verbindungsverlust sind das Gegenteil davon und werden gemeldet.
 */

import type { RealtimeStatus } from './realtime-client.js'

/** Speicherzustand des Editors, ohne seine Nutzlast. */
export type SaveKind = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'failed'

export type BoardStatus = {
  /** Kurzform fuer die schwebende Gruppe. */
  readonly text: string
  /** Der ausformulierte Satz - als Titel und fuer Hilfsmittel. */
  readonly detail: string
  readonly tone: 'neutral' | 'accent' | 'success' | 'danger'
  /** Wahr, wenn dieser Zustand Aufmerksamkeit verlangt und deshalb angekuendigt wird. */
  readonly critical: boolean
}

/**
 * Warum diese Ansicht nur liest - oder `null`, wenn sie es nicht tut.
 *
 * Sie behauptet dabei nichts: jeder Grund ist eine Angabe des Servers. Der Archivzustand steht in der
 * geladenen Boardsicht, das Schreibrecht kommt aus der Gastsession oder aus dem Boardraum.
 */
export function readOnlyReason(input: {
  readonly workspaceArchived: boolean
  readonly boardArchived: boolean
  readonly canWrite: boolean | null
  /** Wahr, wenn die Gastrolle selbst das Leserecht ist - dann ist sie der genauere Grund. */
  readonly guestViewer: boolean
  /** Nummer der gezeigten Version, wenn dies eine Vorschau ist. Sie ist der genaueste Grund von allen. */
  readonly previewOf: number | null
}): string | null {
  if (input.previewOf !== null) {
    return `dies ist die Vorschau von Version ${String(input.previewOf)}`
  }
  if (input.workspaceArchived) {
    return 'der Arbeitsbereich ist archiviert'
  }
  if (input.boardArchived) {
    return 'dieses Board ist archiviert'
  }
  if (input.canWrite === false) {
    return input.guestViewer
      ? 'dieser Freigabelink gibt nur Leserecht'
      : 'du hast fuer dieses Board kein Schreibrecht'
  }
  return null
}

/** Der Verbindungszustand in einem Satz. */
function connectionMessage(status: RealtimeStatus, attempt: number, resyncedAt: Date | null): string {
  switch (status) {
    case 'verbindet':
      return 'Verbindung wird aufgebaut …'
    case 'verbunden':
      return resyncedAt === null
        ? 'Live verbunden.'
        : `Live verbunden. Stand nach Wiederaufnahme um ${resyncedAt.toLocaleTimeString('de-DE')} abgeglichen.`
    case 'wiederverbinden':
      return `Verbindung verloren. Wiederverbindung laeuft (Versuch ${String(attempt)}).`
    case 'getrennt':
      return 'Nicht live verbunden. Aenderungen werden ueber die Speicherung gesichert.'
  }
}

function connectionStatus(
  status: RealtimeStatus,
  attempt: number,
  resyncedAt: Date | null,
): BoardStatus {
  const detail = connectionMessage(status, attempt, resyncedAt)
  switch (status) {
    case 'verbindet':
      return { text: 'Verbindet …', detail, tone: 'neutral', critical: false }
    case 'verbunden':
      return { text: 'Live', detail, tone: 'success', critical: false }
    case 'wiederverbinden':
      return { text: `Verbindung verloren (Versuch ${String(attempt)})`, detail, tone: 'danger', critical: true }
    case 'getrennt':
      return { text: 'Nicht live verbunden', detail, tone: 'danger', critical: true }
  }
}

/**
 * Der eine Zustand, der jetzt zaehlt.
 *
 * Reihenfolge: ein Konflikt und ein Fehlschlag stehen vor allem anderen - an ihnen haengt ungesicherte
 * Arbeit. Danach kommt die Verbindung, denn sie entscheidet, auf welchem Weg gesichert wird. Erst dann der
 * gewoehnliche Speicherstand. Eine Ansicht, die gar nichts aendern kann, zeigt nur ihre Verbindung.
 */
export function boardStatus(input: {
  readonly save: SaveKind
  /** Zeitpunkt der letzten Speicherung; `null`, wenn in dieser Sitzung noch nichts gespeichert wurde. */
  readonly savedAt: Date | null
  /** Meldung eines fehlgeschlagenen Speicherns. */
  readonly failure: string | null
  readonly connection: RealtimeStatus
  readonly attempt: number
  readonly resyncedAt: Date | null
  /** Diese Ansicht aendert das Board nicht - Vorschau, Archiv oder fehlendes Schreibrecht. */
  readonly viewOnly: boolean
  /** Wahr, wenn eine aufbewahrte Version gezeigt wird. */
  readonly preview: boolean
}): BoardStatus {
  if (input.save === 'conflict') {
    return {
      text: 'Konflikt',
      detail:
        'Dieses Board wurde inzwischen an anderer Stelle gespeichert. Deine Zeichnung ist noch da, wurde ' +
        'aber nicht uebernommen und hat nichts ueberschrieben.',
      tone: 'danger',
      critical: true,
    }
  }
  if (input.save === 'failed') {
    return {
      text: 'Nicht gespeichert',
      detail: `Speichern fehlgeschlagen. ${input.failure ?? ''}`.trim(),
      tone: 'danger',
      critical: true,
    }
  }
  if (input.preview) {
    return {
      text: 'Fester Stand',
      detail: 'Eine Vorschau zeigt einen festen Stand, ist nicht live verbunden und nimmt keine Aenderungen auf.',
      tone: 'neutral',
      critical: false,
    }
  }
  if (input.viewOnly) {
    return connectionStatus(input.connection, input.attempt, input.resyncedAt)
  }
  if (input.connection === 'wiederverbinden' || input.connection === 'getrennt') {
    return connectionStatus(input.connection, input.attempt, input.resyncedAt)
  }
  switch (input.save) {
    case 'dirty':
      return {
        text: 'Nicht gespeichert',
        detail: 'Nicht gespeicherte Aenderungen.',
        tone: 'accent',
        critical: false,
      }
    case 'saving':
      return { text: 'Speichert …', detail: 'Wird gespeichert …', tone: 'neutral', critical: false }
    case 'saved':
      return {
        text: input.savedAt === null ? 'Gespeichert' : `Gespeichert ${input.savedAt.toLocaleTimeString('de-DE')}`,
        detail:
          input.savedAt === null
            ? 'Gespeichert.'
            : `Gespeichert um ${input.savedAt.toLocaleTimeString('de-DE')}.`,
        tone: 'success',
        critical: false,
      }
    case 'idle':
      return connectionStatus(input.connection, input.attempt, input.resyncedAt)
  }
}

/** Eine Aktion der schwebenden Gruppe, die hervorgehoben werden kann. */
export type BoardAction = 'current' | 'reload' | 'save' | 'share'

/**
 * Welche Aktion die schwebende Gruppe hervorhebt - und ob "Jetzt speichern" ueberhaupt erscheint.
 *
 * Hervorgehoben ist **hoechstens eine** Aktion. Verlangt die Lage eine Handlung - zurueck zum aktuellen
 * Stand, nach einem Konflikt neu laden, ungesicherte Arbeit speichern -, ist sie es; die Freigabe bleibt
 * dann erreichbar, tritt aber zurueck. Ohne eine solche Handlung ist die Freigabe die Hauptaktion.
 *
 * "Jetzt speichern" erscheint nur, wo der Nutzer tatsaechlich handeln muss: nach einem Fehlschlag und mit
 * Aenderungen bei getrennter Strecke. Waehrend des Verbindungsaufbaus und eines laufenden
 * Wiederverbindungsversuchs nicht - dann traegt gleich wieder der Raum, und der Zustand steht ohnehin da.
 */
export function boardActions(input: {
  readonly save: SaveKind
  readonly connection: RealtimeStatus
  /** Diese Ansicht aendert das Board nicht - Vorschau, Archiv oder fehlendes Schreibrecht. */
  readonly viewOnly: boolean
  /** Wahr, wenn "Zum aktuellen Stand" angeboten wird. */
  readonly preview: boolean
  /** Wahr, wenn die Freigabe angeboten wird. */
  readonly shareable: boolean
}): { readonly saveNow: boolean; readonly primary: BoardAction | null } {
  const saveNow =
    !input.viewOnly &&
    (input.save === 'failed' || (input.save === 'dirty' && input.connection === 'getrennt'))
  const primary: BoardAction | null = input.preview
    ? 'current'
    : input.save === 'conflict'
      ? 'reload'
      : saveNow
        ? 'save'
        : input.shareable
          ? 'share'
          : null
  return { saveNow, primary }
}
