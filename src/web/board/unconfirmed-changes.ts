/**
 * Merkliste der lokalen Aenderungen, die der Boardraum noch nicht als gespeichert bestaetigt hat.
 *
 * Sie ersetzt das fruehere erneute Senden des **gesamten** eigenen Stands nach jedem Beitritt. Das war
 * einfach, aber falsch: Excalidraw normalisiert eine geladene Szene (fehlender `index`, fehlende Werte) und
 * erhoeht dabei Elementversionen. Der volle Stand ging deshalb als Aenderung durch, und ein unveraendert
 * geoeffnetes Board bekam eine neue Version.
 *
 * Gemerkt wird je Element, je Datei und fuer den AppState die lokale Aenderungskennung, unter der er auf der
 * aktuellen Verbindung verschickt wurde - `0` heisst: auf ihr noch nicht verschickt. Ein Eintrag faellt erst
 * weg, wenn ein `saved` des Raums eine Kennung von mindestens dieser Hoehe bestaetigt, oder wenn der Raum
 * beim Beitritt genau diesen Stand schon traegt. Damit geht auch eine Aenderung, die verschickt, aber durch
 * einen Abbruch nie angenommen wurde, beim naechsten Beitritt erneut hinaus.
 *
 * Reine Buchfuehrung ohne Editor, Netz und React - deshalb in Node pruefbar.
 */

import type { SyncElement } from '../../contracts/scene.js'

export type UnsentChanges = {
  readonly elementIds: ReadonlySet<string>
  readonly appState: boolean
  readonly fileIds: readonly string[]
}

export class UnconfirmedChanges {
  readonly #elements = new Map<string, number>()
  readonly #files = new Map<string, number>()
  #appState: number | null = null

  /** Merkt eine lokale Aenderung. `sequence` ist ihre Aenderungskennung, oder `0`, wenn sie nicht hinausging. */
  note(elementIds: Iterable<string>, appState: boolean, fileIds: Iterable<string>, sequence: number): void {
    for (const id of elementIds) {
      this.#elements.set(id, sequence)
    }
    for (const id of fileIds) {
      this.#files.set(id, sequence)
    }
    if (appState) {
      this.#appState = sequence
    }
  }

  /**
   * Neuer Beitritt. Was der Raum schon genau so traegt, ist bei ihm angekommen; alles uebrige gilt als auf
   * dieser Verbindung noch nicht verschickt - auch was auf der alten verschickt, aber nie bestaetigt wurde.
   */
  rejoin(
    roomElements: readonly SyncElement[],
    roomFileIds: ReadonlySet<string>,
    appStateInRoom: boolean,
    localElements: readonly SyncElement[],
  ): void {
    const room = new Map(roomElements.map((element) => [element.id, element]))
    const local = new Map(localElements.map((element) => [element.id, element]))
    for (const id of this.#elements.keys()) {
      const inRoom = room.get(id)
      const mine = local.get(id)
      if (
        inRoom !== undefined &&
        mine !== undefined &&
        inRoom.version === mine.version &&
        inRoom.versionNonce === mine.versionNonce
      ) {
        this.#elements.delete(id)
      } else {
        this.#elements.set(id, 0)
      }
    }
    for (const id of this.#files.keys()) {
      if (roomFileIds.has(id)) {
        this.#files.delete(id)
      } else {
        this.#files.set(id, 0)
      }
    }
    if (this.#appState !== null) {
      this.#appState = appStateInRoom ? null : 0
    }
  }

  /** Was auf der aktuellen Verbindung noch nicht verschickt wurde. */
  unsent(): UnsentChanges {
    const offen = (eintraege: Map<string, number>): string[] =>
      [...eintraege].filter(([, sequence]) => sequence === 0).map(([id]) => id)
    return { elementIds: new Set(offen(this.#elements)), appState: this.#appState === 0, fileIds: offen(this.#files) }
  }

  /** Alles noch nicht Verschickte ging unter dieser Kennung hinaus. */
  markSent(sequence: number): void {
    const offen = this.unsent()
    this.note(offen.elementIds, offen.appState, offen.fileIds, sequence)
  }

  /** Ein `saved` bestaetigt alles, was unter einer Kennung bis `savedSequence` verschickt wurde. */
  confirm(savedSequence: number): void {
    const bestaetigt = (sequence: number): boolean => sequence > 0 && sequence <= savedSequence
    for (const [id, sequence] of this.#elements) {
      if (bestaetigt(sequence)) {
        this.#elements.delete(id)
      }
    }
    for (const [id, sequence] of this.#files) {
      if (bestaetigt(sequence)) {
        this.#files.delete(id)
      }
    }
    if (this.#appState !== null && bestaetigt(this.#appState)) {
      this.#appState = null
    }
  }

  get empty(): boolean {
    return this.#elements.size === 0 && this.#files.size === 0 && this.#appState === null
  }
}
