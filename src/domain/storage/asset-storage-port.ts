/**
 * Port fuer Binaerassets (Board-Bilder).
 *
 * **Ein reiner Byte-Speicher.** Alles Fachliche - Board- und Workspacebezug, MIME-Typ, Dateiname, Groesse,
 * Pruefsumme - steht in `board_assets` und damit in PostgreSQL. Der Port kennt nur Schluessel und Bytes.
 * Das haelt die beiden Adapter (`filesystem`, `s3`) auf demselben Vertrag: waere der MIME-Typ Teil des
 * Ports, muesste ihn das Dateisystem in einer zweiten Datei neben den Bytes fuehren und beide Seiten
 * koennten auseinanderlaufen. Die Datenbank ist die eine Wahrheit ueber die Metadaten.
 *
 * Ein Adapterwechsel ist damit reine Laufzeitkonfiguration: Domain, Routen und Datenbank sehen keinen
 * Unterschied.
 */

export type AssetStorageAdapter = 'filesystem' | 's3'

/** Der Schluessel verlaesst den erlaubten Namensraum. Immer ein Programmierfehler, nie eine Nutzereingabe. */
export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Ungueltiger Speicherschluessel: ${JSON.stringify(key)}`)
    this.name = 'InvalidStorageKeyError'
  }
}

/**
 * Erlaubte Schluesselform: Segmente aus Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich, getrennt
 * durch `/`. Jedes Segment beginnt mit einem Buchstaben oder einer Ziffer - damit sind `.`, `..` und
 * versteckte Dateien gar nicht erst formulierbar und ein Ausbruch aus dem Wurzelverzeichnis unmoeglich.
 */
const STORAGE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_STORAGE_KEY_LENGTH = 512

/** Prueft den Schluessel und gibt ihn zurueck. Jeder Adapter ruft das als Erstes auf, nicht der Aufrufer. */
export function assertStorageKey(key: string): string {
  const segments = key.split('/')
  if (
    key.length === 0 ||
    key.length > MAX_STORAGE_KEY_LENGTH ||
    !segments.every((segment) => STORAGE_KEY_SEGMENT.test(segment))
  ) {
    throw new InvalidStorageKeyError(key)
  }
  return key
}

/**
 * Schluessel eines Assets: Board, Dateikennung und Pruefsumme des Inhalts.
 *
 * Inhaltsadressiert und deshalb wiederholbar - dieselbe Datei im selben Board ergibt denselben Schluessel.
 * Ein abgebrochener Upload kann so nichts Halbes hinterlassen, das ein zweiter Versuch nicht ueberschreibt.
 *
 * **Die Dateikennung gehoert in den Schluessel.** `board_assets` fuehrt einen Datensatz je Dateikennung und
 * verlangt den Speicherschluessel instanzweit eindeutig; ohne sie wuerden zwei Kennungen mit identischem
 * Inhalt im selben Board auf denselben Schluessel fallen und einander in die Quere kommen. Zwei Kennungen
 * mit gleichem Inhalt sind ein gueltiger Fall, kein Konflikt - und ihre Bytes gehoeren jeweils genau einem
 * Datensatz, sodass keine Aufraeumung fremde Bytes treffen kann.
 */
export function buildAssetStorageKey(boardId: string, fileId: string, checksumSha256: string): string {
  return assertStorageKey(`boards/${boardId}/${fileId}/${checksumSha256}`)
}

export interface AssetStoragePort {
  /** Legt die Bytes unter `key` ab. Ein vorhandener Inhalt wird atomar ersetzt, nie teilweise. */
  put(key: string, bytes: Uint8Array): Promise<void>
  /** Bytes oder `null`, wenn unter `key` nichts liegt. */
  get(key: string): Promise<Uint8Array | null>
  /** Entfernt `key`. Ein unbekannter Schluessel ist kein Fehler. */
  delete(key: string): Promise<void>
}
