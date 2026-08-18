/**
 * Port des Board-Editors.
 *
 * Der gesamte Kollaborationscode spricht nur mit diesem Interface. Excalidraw erscheint ausschliesslich in
 * seiner Adapterimplementierung; ein Editorwechsel oder ein Upstream-Bruch bleibt damit auf eine Datei
 * begrenzt.
 *
 * Aus dem Spike uebernommen und noch unverdrahtet: die Board- und Realtime-Strecke folgt in einem eigenen
 * Issue. Bis dahin haelt der Port fest, was ein Editor koennen muss.
 */

import type { BinaryFileRef, PersistedAppState, SyncElement } from '../../contracts/scene.js'

/**
 * Anzeigbare Mitbearbeiter. Bewusst hier und nicht im Realtime-Protokoll definiert: der Port beschreibt,
 * was der Editor darstellen muss, nicht wie die Information uebertragen wird.
 */
export type EditorPeer = {
  readonly clientId: string
  readonly displayName: string
  readonly readOnly: boolean
  readonly pointer: { readonly x: number; readonly y: number } | null
}

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
  showPeers(peers: readonly EditorPeer[]): void
  setReadOnly(readOnly: boolean): void
  onLocalChange(listener: (change: LocalChange) => void): () => void
}
