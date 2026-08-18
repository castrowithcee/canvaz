/**
 * Element-Reconciliation fuer den Zwei-Client-Sync.
 *
 * Eigenimplementierung, kein uebernommener Upstream-Code. Sie folgt dem in Excalidraw etablierten Prinzip:
 * jedes Element traegt eine monoton wachsende `version` und einen zufaelligen `versionNonce` als
 * deterministischen Gleichstandsbrecher. Dadurch konvergieren zwei Clients ohne zentrale Sequenznummer und
 * ohne Operational Transform.
 */

import type { SyncElement } from './scene.js'

/**
 * Entscheidet, ob das eingehende Element das vorhandene ersetzt.
 *
 * Deterministisch und symmetrisch: beide Seiten kommen unabhaengig zum selben Ergebnis.
 */
export function shouldReplace(local: SyncElement, incoming: SyncElement): boolean {
  if (incoming.version !== local.version) {
    return incoming.version > local.version
  }
  if (incoming.versionNonce !== local.versionNonce) {
    // Kleinerer Nonce gewinnt. Die Regel ist beliebig, aber auf allen Clients gleich.
    return incoming.versionNonce < local.versionNonce
  }
  return false
}

export type ReconcileResult = {
  readonly elements: readonly SyncElement[]
  /** IDs der tatsaechlich uebernommenen eingehenden Elemente. Leer bedeutet: nichts hat sich geaendert. */
  readonly appliedIds: ReadonlySet<string>
}

/**
 * Fuehrt lokale und eingehende Elemente zusammen.
 *
 * Geloeschte Elemente bleiben als Tombstone erhalten, damit eine Loeschung nicht durch einen aelteren
 * Client wiederbelebt wird. Die lokale z-Reihenfolge bleibt stabil; unbekannte eingehende Elemente werden
 * in ihrer Sendereihenfolge angehaengt.
 */
export function reconcileElements(
  local: readonly SyncElement[],
  incoming: readonly SyncElement[],
): ReconcileResult {
  const merged = new Map<string, SyncElement>()
  const order: string[] = []
  for (const element of local) {
    if (!merged.has(element.id)) {
      order.push(element.id)
    }
    merged.set(element.id, element)
  }

  const appliedIds = new Set<string>()
  for (const element of incoming) {
    const existing = merged.get(element.id)
    if (existing === undefined) {
      merged.set(element.id, element)
      order.push(element.id)
      appliedIds.add(element.id)
      continue
    }
    if (shouldReplace(existing, element)) {
      merged.set(element.id, element)
      appliedIds.add(element.id)
    }
  }

  const elements: SyncElement[] = []
  for (const id of order) {
    const element = merged.get(id)
    if (element !== undefined) {
      elements.push(element)
    }
  }
  return { elements, appliedIds }
}

/** Entfernt Tombstones fuer die Anzeige. Der geteilte Zustand behaelt sie. */
export function visibleElements(elements: readonly SyncElement[]): SyncElement[] {
  return elements.filter((element) => element.isDeleted !== true)
}
