/**
 * Port des Board-Editors.
 *
 * Der gesamte Kollaborationscode spricht nur mit diesem Interface. Excalidraw erscheint ausschliesslich in
 * seiner Adapterimplementierung; ein Editorwechsel oder ein Upstream-Bruch bleibt damit auf eine Datei
 * begrenzt.
 *
 * Presence (`showPeers`) und die Uebernahme entfernter Aenderungen sind bereits Teil des Ports; die
 * Realtime-Strecke, die sie fuellt, folgt in einem eigenen Issue. Die Boardansicht nutzt heute Laden,
 * Speichern und die lokale Aenderungsmeldung.
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
  /**
   * Kennungen der Dateien, die seit der letzten Meldung neu im Editor liegen. Bewusst nur die Kennungen:
   * Groesse und Speicherschluessel denkt sich der Client nicht aus, sie kommen mit der Antwort des Uploads.
   */
  readonly newFileIds: readonly string[]
}

export interface BoardEditorPort {
  /** Vollstaendiger geteilter Zustand inklusive Tombstones. */
  getElements(): readonly SyncElement[]
  /** Persistierte Teilmenge des Editorzustands. */
  getAppState(): PersistedAppState
  /**
   * Inhalt einer im Editor liegenden Datei als Data-URL, oder `null`. Der Aufrufer laedt sie damit hoch;
   * die Bytes verlassen den Editor ausschliesslich ueber diese Stelle.
   */
  getFileDataUrl(fileId: string): string | null
  /** Uebernimmt entfernte Elemente ohne die lokale Undo-Historie zu verschmutzen. */
  applyRemoteElements(elements: readonly SyncElement[]): void
  applyRemoteAppState(appState: PersistedAppState): void
  /** Legt eine geladene Datei in den Editor. Die Bytes kommen als Data-URL vom autorisierten Abrufendpunkt. */
  applyRemoteFileRef(file: BinaryFileRef, dataUrl: string): void
  showPeers(peers: readonly EditorPeer[]): void
  setReadOnly(readOnly: boolean): void
  onLocalChange(listener: (change: LocalChange) => void): () => void
}
