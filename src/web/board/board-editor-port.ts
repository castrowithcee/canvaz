/**
 * Port des Board-Editors.
 *
 * Der gesamte Kollaborationscode spricht nur mit diesem Interface. Excalidraw erscheint ausschliesslich in
 * seiner Adapterimplementierung; ein Editorwechsel oder ein Upstream-Bruch bleibt damit auf eine Datei
 * begrenzt.
 *
 * Presence (`showPeers`, `onPointerChange`) und die Uebernahme entfernter Aenderungen gehoeren zum Port,
 * weil der Editor sie darstellen und melden muss. Wie sie uebertragen werden, steht im Realtime-Vertrag und
 * nicht hier.
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
  readonly selectedElementIds: readonly string[]
}

/** Eigener Zeige- und Auswahlzustand. Fluechtig: er gehoert nie in den gespeicherten Boardzustand. */
export type LocalPresence = {
  readonly pointer: { readonly x: number; readonly y: number } | null
  readonly selectedElementIds: readonly string[]
}

export type LocalChange = {
  /** Nur die seit der letzten Meldung tatsaechlich veraenderten Elemente. */
  readonly changedElements: readonly SyncElement[]
  /** Der neue AppState, wenn er sich seit der letzten Meldung geaendert hat; sonst `null`. */
  readonly appState: PersistedAppState | null
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
  /** Meldet den eigenen Zeiger und die eigene Auswahl. Feuert in Bewegungsrate; der Aufrufer buendelt. */
  onPointerChange(listener: (presence: LocalPresence) => void): () => void
  setReadOnly(readOnly: boolean): void
  onLocalChange(listener: (change: LocalChange) => void): () => void
}
