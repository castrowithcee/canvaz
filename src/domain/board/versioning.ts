/**
 * Ein frueherer oder fremder Stand wird zum neuen aktuellen Stand.
 *
 * Reiner Fachkern ohne IO. Die Funktion beantwortet genau eine Frage, und sie ist der Kern von
 * Wiederherstellung **und** Import: wie sieht ein Snapshot aus, der den aktuellen Stand ueberall ersetzt -
 * auch bei einem Client, der den bisherigen Stand noch im Browser haelt?
 *
 * ## Warum das Anheben der Elementversionen dazugehoert
 *
 * Der gesamte Abgleich entscheidet je Element ueber `version` und nicht ueber den Zeitpunkt
 * (`reconcileElements`). Wuerde eine Wiederherstellung die alten Elemente unveraendert zurueckschreiben,
 * traegt jeder verbundene Client die neueren Fassungen weiterhin mit hoeherer `version` - und der naechste
 * Abgleich machte die Wiederherstellung still wieder rueckgaengig. Deshalb bekommt jedes wiederhergestellte
 * Element mindestens die naechste Version nach der, die es im aktuellen Stand hatte.
 *
 * Das ist **kein** Element-Diff: es wird nichts verglichen und nichts zusammengefuehrt. Jedes Element des
 * Zielstands gilt, und was der aktuelle Stand darueber hinaus fuehrt, wird zum Tombstone - genau die
 * Aussage "dieser Stand ersetzt jenen".
 *
 * ## Was erhalten bleibt
 *
 * Die Dateiverweise beider Staende, weil Assets nie geloescht werden und ein Tombstone eines Bildelements
 * weiterhin auf seine Datei zeigt. Ein Verweis ins Leere entstuende sonst genau dann, wenn jemand einen
 * Stand von vor dem Einfuegen eines Bildes wiederherstellt und danach wieder vorwaerts geht.
 */

import type { SceneSnapshot, SyncElement } from '../../contracts/scene.js'
import { SCENE_SCHEMA_VERSION } from '../../contracts/scene.js'
import type { BoardId } from './model.js'

/**
 * Baut den Snapshot, der `current` durch `next` ersetzt.
 *
 * `current === null` heisst: das Board wurde noch nie gespeichert. Dann gibt es nichts zu ueberholen und
 * nichts zu beerdigen, und `next` gilt unveraendert.
 */
export function supersedeSnapshot(
  current: SceneSnapshot | null,
  next: SceneSnapshot,
  boardId: BoardId,
  updatedAt: number,
): SceneSnapshot {
  const previous = new Map<string, SyncElement>()
  for (const element of current?.elements ?? []) {
    previous.set(element.id, element)
  }

  const elements: SyncElement[] = []
  for (const element of next.elements) {
    const before = previous.get(element.id)
    previous.delete(element.id)
    if (before === undefined || element.version > before.version) {
      elements.push(element)
      continue
    }
    // Gleichstand reicht nicht: bei gleicher `version` entscheidet der `versionNonce`, und der ist auf
    // beiden Seiten derselbe. Eine Stufe darueber gewinnt der wiederhergestellte Stand eindeutig.
    elements.push({ ...element, version: before.version + 1 })
  }

  // Was nur der aktuelle Stand kennt, verschwindet nicht ersatzlos: eine Loeschung ist selbst Information
  // und muss den Weg zu jedem Client finden, sonst bringt der naechste Abgleich das Element zurueck.
  for (const element of previous.values()) {
    elements.push(element.isDeleted === true ? element : { ...element, isDeleted: true, version: element.version + 1 })
  }

  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    boardId,
    elements,
    appState: next.appState,
    files: { ...current?.files, ...next.files },
    updatedAt,
  }
}
