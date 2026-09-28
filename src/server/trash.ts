/**
 * Endgueltiges Entfernen eines Boards und die Aufbewahrungsfrist des Papierkorbs.
 *
 * Zwei Wege fuehren hierher - die ausdrueckliche Entscheidung eines Berechtigten und der fristgesteuerte
 * Lauf -, und beide benutzen **dieselbe** Reihenfolge. Sie steht deshalb genau einmal da: eine zweite
 * Fassung waere die Stelle, an der der eine Weg eines Tages etwas zuruecklaesst, das der andere entfernt.
 *
 * ## Die Reihenfolge und ihr Grund
 *
 * 1. **Speicherschluessel lesen**, solange die Assetdatensaetze noch da sind. Danach gibt es keine Liste
 *    mehr, aus der sich die Bytes finden liessen.
 * 2. **Nachweis schreiben**, solange der Arbeitsbereichsbezug noch existiert. Ein Auditereignis nach dem
 *    Loeschen haette keinen Arbeitsbereich mehr, auf den es zeigen koennte.
 * 3. **Boardzeile loeschen.** Szenenversionen, Assetdatensaetze, interne Freigaben, Gastlinks und offene
 *    Gastsessions haengen mit `on delete cascade` daran und fallen in derselben Anweisung weg - die
 *    Vollstaendigkeit garantiert die Datenbank und nicht eine Aufzaehlung im Anwendungscode.
 * 4. **Bytes entfernen, erst nach dem Commit.** Umgekehrt waere ein zurueckgerollter Commit ein Board mit
 *    Datensaetzen, deren Bilder fehlen. Bricht der Prozess zwischen Commit und Loeschung ab, bleiben Bytes
 *    ohne Datensatz liegen; sie sind dann von aussen unerreichbar (jeder Abruf laeuft ueber den
 *    Assetdatensatz) und werden benannt protokolliert.
 */

import type { BoardId } from '../domain/board/model.js'
import { trashDeadline } from '../domain/board/model.js'
import type { Board } from '../domain/board/model.js'
import type { BoardStore } from '../domain/board/repositories.js'
import type { UserId } from '../domain/identity/model.js'
import type { AppContext } from './context.js'

/**
 * Warum ein Board endgueltig verschwindet.
 *
 * Steht im Nachweis, weil beide Faelle fachlich verschieden sind: `request` hat eine handelnde Person,
 * `retention` ist die Frist selbst - dort ist `actorId` `null`, und der Grund sagt, dass niemand vergessen
 * wurde, sondern niemand gehandelt hat.
 */
export type PurgeReason = 'request' | 'retention'

/**
 * Entfernt ein Board endgueltig **innerhalb einer laufenden Transaktion**, in der seine Zeile bereits
 * gesperrt ist. Liefert die Speicherschluessel, deren Bytes nach dem Commit zu entfernen sind.
 */
export async function purgeBoardInTransaction(
  tx: BoardStore,
  board: Board,
  actorId: UserId | null,
  reason: PurgeReason,
): Promise<readonly string[]> {
  const storageKeys = await tx.assets.listStorageKeys(board.id)
  await tx.audit.record({
    actorId,
    action: 'board.purged',
    targetType: 'board',
    targetId: board.id,
    workspaceId: board.workspaceId,
    // Metadaten der Loeschung, nie Boardinhalt. Der Titel bleibt, weil ein Nachweis ohne ihn nur noch eine
    // Kennung waere, zu der es nichts mehr nachzuschlagen gibt.
    details: {
      title: board.title,
      reason,
      deletedAt: board.deletedAt?.toISOString() ?? null,
      assets: storageKeys.length,
    },
  })
  await tx.boards.purge(board.id)
  return storageKeys
}

/**
 * Entfernt die Bytes der Assets. Erst nach dem Commit aufzurufen.
 *
 * Ein Fehler wird benannt und nicht verschluckt - aber er laesst das bereits entfernte Board entfernt: der
 * fachliche Vorgang ist abgeschlossen, und die liegen gebliebenen Bytes sind ein Betriebsproblem und kein
 * halb geloeschtes Board.
 */
export async function removeAssetBytes(
  context: AppContext,
  boardId: BoardId,
  storageKeys: readonly string[],
): Promise<void> {
  for (const key of storageKeys) {
    try {
      await context.storage.delete(key)
    } catch (error) {
      context.logger('error', 'board.asset.purge.failed', { boardId, storageKey: key, cause: String(error) })
    }
  }
}

/**
 * Hoechstzahl der Boards je fristgesteuertem Lauf.
 *
 * Der Lauf soll eine Datenbank nicht minutenlang beschaeftigen. Was nicht hineinpasst, kommt beim naechsten
 * Takt dran - die Frist ist eine Obergrenze der Aufbewahrung und keine Zusage auf die Sekunde.
 */
const RETENTION_BATCH = 100

/** Takt des Laufs. Eine Stunde ist fein genug fuer eine Frist von Tagen und kostet nichts. */
const RETENTION_INTERVAL_MS = 3_600_000

/**
 * Der fristgesteuerte Lauf: entfernt jedes Board, dessen Aufbewahrungsfrist abgelaufen ist.
 *
 * **Kein Worker und keine Queue.** Der Betriebsvertrag dieser Instanz kennt genau einen Anwendungsprozess;
 * ein Intervall darin ist dafuer der vorgesehene Weg und braucht weder Koordination noch zusaetzliche
 * Infrastruktur.
 *
 * Die Zeitgrenze kommt aus `context.now()` - deshalb ist der Lauf in Tests mit gesetzter Uhr aufrufbar, ohne
 * dass jemand vierzehn Tage wartet. Jedes Board bekommt seine **eigene** Transaktion: ein Board, das
 * inzwischen wiederhergestellt oder von Hand entfernt wurde, laesst die uebrigen unberuehrt.
 */
export async function runTrashRetention(context: AppContext): Promise<readonly BoardId[]> {
  const deadline = trashDeadline(context.now(), context.config.trashRetentionDays)
  const expired = await context.boards.boards.listExpiredTrash(deadline, RETENTION_BATCH)
  const purged: BoardId[] = []
  for (const entry of expired) {
    const storageKeys = await context.boards.transaction(async (tx) => {
      // Unter der Zeilensperre noch einmal pruefen: zwischen Liste und Sperre kann jemand
      // wiederhergestellt oder selbst endgueltig geloescht haben.
      const board = await tx.boards.lockTrashed(entry.boardId)
      if (board === null || board.deletedAt === null || board.deletedAt.getTime() > deadline.getTime()) {
        return null
      }
      return purgeBoardInTransaction(tx, board, null, 'retention')
    })
    if (storageKeys === null) {
      continue
    }
    await removeAssetBytes(context, entry.boardId, storageKeys)
    purged.push(entry.boardId)
    context.logger('info', 'board.trash.expired', {
      boardId: entry.boardId,
      workspaceId: entry.workspaceId,
      deletedAt: entry.deletedAt.toISOString(),
    })
  }
  return purged
}

/**
 * Startet den fristgesteuerten Lauf im Anwendungsprozess und liefert seinen Stopp.
 *
 * Einmal sofort und danach im Takt: nach einem Neustart soll eine laengst abgelaufene Frist nicht noch eine
 * Stunde warten. Das Intervall haelt den Prozess nicht am Leben (`unref`), damit ein geordnetes Beenden
 * nicht auf den naechsten Takt wartet.
 */
export function startTrashRetention(context: AppContext): () => void {
  const run = (): void => {
    void runTrashRetention(context).catch((error: unknown) => {
      context.logger('error', 'board.trash.retention.failed', { cause: String(error) })
    })
  }
  run()
  const timer = setInterval(run, RETENTION_INTERVAL_MS)
  timer.unref()
  return () => {
    clearInterval(timer)
  }
}
