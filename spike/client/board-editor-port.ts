/**
 * Port des Board-Editors.
 *
 * Der gesamte Kollaborationscode spricht nur mit diesem Interface. Excalidraw erscheint ausschliesslich in
 * seiner Adapterimplementierung; ein Editorwechsel oder ein Upstream-Bruch bleibt damit auf eine Datei
 * begrenzt.
 */

import type { BinaryFileRef, PersistedAppState, SyncElement } from '../shared/scene.js'
import type { Peer } from '../shared/protocol.js'

export type LocalChange = {
  /** Nur die seit der letzten Meldung tatsaechlich veraenderten Elemente. */
  readonly changedElements: readonly SyncElement[]
  readonly appState: PersistedAppState
  readonly newFiles: readonly BinaryFileRef[]
}

export interface BoardEditorPort {
  /** Vollstaendiger geteilter Zustand inklusive Tombstones. */
  getElements(): readonly SyncElement[]
  /** Uebernimmt entfernte Elemente ohne die lokale Undo-Historie zu verschmutzen. */
  applyRemoteElements(elements: readonly SyncElement[]): void
  applyRemoteAppState(appState: PersistedAppState): void
  applyRemoteFileRef(file: BinaryFileRef): void
  showPeers(peers: readonly Peer[]): void
  setReadOnly(readOnly: boolean): void
  onLocalChange(listener: (change: LocalChange) => void): () => void
}
