/**
 * Vertrag der persoenlichen Bibliothek.
 *
 * Eine Bibliothek ist eine Liste wiederverwendbarer Zeichnungsteile, die einem Nutzer gehoert und nicht
 * einem Board. Server, Persistenz und SPA kennen nur diese Typen; der Excalidraw-Adapter uebersetzt an genau
 * einer Stelle. Wie beim Szenenvertrag ist die Pruefung strukturell: unbekannte Felder von Eintraegen und
 * Elementen werden unveraendert durchgereicht, damit ein Upstream-Update nichts verliert.
 *
 * **Bilder gehoeren nicht hinein.** Ein Bildelement verweist ueber `fileId` auf Bytes, die im Board liegen und
 * nicht in der Bibliothek. Gespeichert waere es ein Rahmen ohne Inhalt - beschaedigt, ohne dass es jemand
 * merkt. Solche Eintraege werden deshalb benannt abgelehnt statt still verstuemmelt.
 */

import { findUnstorableValue } from './scene.js'

export type LibraryElement = {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
} & Record<string, unknown>

export type LibraryItem = {
  readonly id: string
  readonly status: 'published' | 'unpublished'
  /** Zeitpunkt der Aufnahme in Millisekunden seit Epoch. */
  readonly created: number
  readonly name?: string
  readonly elements: readonly LibraryElement[]
} & Record<string, unknown>

/** Warum eine Bibliothek nicht gespeichert wird. Jeder Grund hat genau einen Satz fuer die Anzeige. */
export type LibraryRejection = 'ungueltig' | 'bild-nicht-unterstuetzt' | 'nicht-speicherbar'

export const LIBRARY_REJECTION_MESSAGES: Readonly<Record<LibraryRejection, string>> = {
  ungueltig: 'Die Bibliothek hat kein gueltiges Format.',
  'bild-nicht-unterstuetzt':
    'Die Bibliothek enthaelt Bilder oder Dateien. Sie werden in der Bibliothek nicht gespeichert.',
  'nicht-speicherbar': 'Die Bibliothek enthaelt Werte, die sich nicht verlustfrei speichern lassen.',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLibraryElement(value: unknown): value is LibraryElement {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    value['id'].length > 0 &&
    typeof value['type'] === 'string' &&
    (value['isDeleted'] === undefined || typeof value['isDeleted'] === 'boolean')
  )
}

function isLibraryItem(value: unknown): value is LibraryItem {
  if (!isRecord(value)) {
    return false
  }
  const { id, status, created, name, elements } = value
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    (status === 'published' || status === 'unpublished') &&
    typeof created === 'number' &&
    Number.isFinite(created) &&
    (name === undefined || typeof name === 'string') &&
    Array.isArray(elements) &&
    elements.every(isLibraryElement) &&
    // Ein Eintrag ohne sichtbares Element verschwindet beim Laden im Editor; gespeichert waere er eine Leiche.
    elements.some((element: LibraryElement) => element.isDeleted !== true)
  )
}

/** Ein Element, dessen Inhalt nicht mitgespeichert wird: Bilder und alles andere mit Dateiverweis. */
function referencesFile(element: LibraryElement): boolean {
  return element.type === 'image' || (typeof element['fileId'] === 'string' && element['fileId'].length > 0)
}

/** Ob ein Eintrag Medien enthaelt, deren Bytes die Bibliothek nicht mitspeichert. */
export function hasUnsupportedMedia(item: LibraryItem): boolean {
  return item.elements.some(referencesFile)
}

/**
 * Prueft eine vollstaendige Bibliothek. Der erste Grund entscheidet; eine teilweise uebernommene Bibliothek
 * gibt es nicht.
 */
export function checkLibraryItems(
  value: unknown,
): { readonly ok: true; readonly items: readonly LibraryItem[] } | { readonly ok: false; readonly reason: LibraryRejection } {
  if (!Array.isArray(value) || !value.every(isLibraryItem)) {
    return { ok: false, reason: 'ungueltig' }
  }
  const items = value as readonly LibraryItem[]
  // Eintraege werden beim Zusammenfuehren ueber ihre Kennung abgeglichen; zwei gleiche waeren einer zu viel.
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    return { ok: false, reason: 'ungueltig' }
  }
  if (items.some(hasUnsupportedMedia)) {
    return { ok: false, reason: 'bild-nicht-unterstuetzt' }
  }
  if (findUnstorableValue(items) !== null) {
    return { ok: false, reason: 'nicht-speicherbar' }
  }
  return { ok: true, items }
}

/**
 * Vergleichswert eines Eintrags: Kennung, Name, Status und die Versionen seiner Elemente. Der Editor stellt
 * geladene Eintraege neu her; ein Vergleich des ganzen Objekts saehe darin eine Aenderung, die keine ist.
 */
export function libraryItemSignature(item: LibraryItem): string {
  return JSON.stringify([
    item.id,
    item.status,
    item.name ?? null,
    item.elements.map((element) => [element.id, element['version'] ?? null, element['versionNonce'] ?? null]),
  ])
}

export function sameLibrary(left: readonly LibraryItem[], right: readonly LibraryItem[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index]
      return other !== undefined && libraryItemSignature(item) === libraryItemSignature(other)
    })
  )
}

/**
 * Dreiwegezusammenfuehrung auf Ebene der Eintraege.
 *
 * `base` ist der zuletzt bestaetigte Stand, `local` der eigene, `remote` der inzwischen gespeicherte. Was
 * lokal entfernt wurde, verschwindet; was lokal neu oder geaendert ist, gewinnt. Alles andere kommt aus
 * `remote` - Eintraege eines anderen Fensters gehen damit nicht verloren. Neue lokale Eintraege stehen vorn,
 * wie der Editor sie auch selbst einsortiert.
 */
export function mergeLibraries(
  base: readonly LibraryItem[],
  local: readonly LibraryItem[],
  remote: readonly LibraryItem[],
): readonly LibraryItem[] {
  const baseById = new Map(base.map((item) => [item.id, item]))
  const localIds = new Set(local.map((item) => item.id))
  const merged = new Map(remote.map((item) => [item.id, item]))
  for (const id of baseById.keys()) {
    if (!localIds.has(id)) {
      merged.delete(id)
    }
  }
  const added: LibraryItem[] = []
  for (const item of local) {
    const before = baseById.get(item.id)
    if (before !== undefined && libraryItemSignature(before) === libraryItemSignature(item)) {
      continue
    }
    if (merged.has(item.id)) {
      merged.set(item.id, item)
    } else {
      added.push(item)
    }
  }
  return [...added, ...merged.values()]
}

/** Datei im Format `.excalidrawlib`, wie der Editor sie auch selbst exportiert und wieder oeffnet. */
export function serializeLibraryFile(items: readonly LibraryItem[], source: string): string {
  return JSON.stringify({ type: 'excalidrawlib', version: 2, source, libraryItems: items }, null, 2)
}
