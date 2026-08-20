/**
 * Papierkorb der Boards.
 *
 * Vier Endpunkte an einer Stelle, weil sie denselben Zustand betreffen: ein Board hineinlegen, den
 * Papierkorb eines Arbeitsbereichs ansehen, Boards zuruecknehmen und Boards sofort endgueltig entfernen.
 *
 * ## Zwei getrennte Zugaenge zu einem Board
 *
 * Ausserhalb des Papierkorbs fuehrt jeder Weg ueber `loadVisibleBoard`, und der liefert ein geloeschtes
 * Board **nie**. Innerhalb fuehrt jeder Weg ueber `findTrashedForUpdate`, und der liefert nur ein
 * geloeschtes. Beide Seiten schliessen sich in der Abfrage selbst aus; deshalb gibt es keinen Aufrufer, der
 * versehentlich in den falschen Zustand greift, und keine Rolle, die es koennte.
 *
 * ## Wer darf
 *
 * Loeschen, Zuruecknehmen und endgueltiges Entfernen tragen dieselbe Verantwortung wie die
 * Wiederherstellung eines frueheren Standes: der Board-Owner und die Verwaltung des Arbeitsbereichs. Sie
 * nehmen das Board allen weg, die es bisher sahen - das ist keine Bearbeitung, sondern ein Eingriff in den
 * Bestand. Entschieden wird das ausschliesslich in `decideBoardAccess`; die Papierkorbliste ist mit
 * derselben Entscheidung je Zeile gefiltert und zeigt niemandem ein Board, das er nicht zuruecknehmen darf.
 *
 * ## Eine Auswahl ist kein Alles-oder-nichts
 *
 * Zuruecknehmen und endgueltiges Entfernen nehmen eine Liste von Kennungen und beantworten **jede einzeln**.
 * Jede laeuft in ihrer eigenen Transaktion: ein Board, das inzwischen verschwunden ist oder das der
 * Anfragende nicht verantwortet, laesst die uebrigen unberuehrt.
 */

import type {
  BoardTrashEntryView,
  BoardTrashResponse,
  TrashActionResultView,
  TrashSelectionResponse,
} from '../contracts/api.js'
import {
  BOARD_TRASH_PATH,
  BOARD_TRASH_PURGE_PATH,
  BOARD_TRASH_RESTORE_PATH,
  MAX_TRASH_SELECTION,
  WORKSPACE_ID_PARAM,
} from '../contracts/api.js'
import type { BoardId } from '../domain/board/model.js'
import { trashPurgeAt } from '../domain/board/model.js'
import type { BoardAction } from '../domain/board/policy.js'
import { decideBoardAccess } from '../domain/board/policy.js'
import type { BoardAccess, BoardStore, TrashedBoardEntry } from '../domain/board/repositories.js'
import type { AuthenticatedSession } from '../domain/identity/model.js'
import type { Workspace, WorkspaceRole } from '../domain/workspace/model.js'
import { DENIALS, NOT_FOUND, createBoardGate, withoutBoard } from './board-access.js'
import type { AppContext } from './context.js'
import { requireSession } from './guard.js'
import type { Route } from './http.js'
import { sendError } from './http.js'
import type { Reply } from './reply.js'
import { fail, guardMutation, ok, readUuid, send } from './reply.js'
import { asRequester, boardSubject } from './requester.js'
import { purgeBoardInTransaction, removeAssetBytes } from './trash.js'

/** Der Papierkorb kennt genau diese eine Antwort auf ein Board, das es dort nicht (mehr) gibt. */
const TRASH_NOT_FOUND = 'Dieses Board liegt nicht im Papierkorb'

/**
 * Auswahl aus dem Anfragekoerper.
 *
 * `null` heisst: keine brauchbare Auswahl. Eine leere Liste gehoert dazu - sie waere eine Anfrage ohne
 * Gegenstand, und eine stille 200 darauf sagte faelschlich, es sei etwas geschehen.
 */
function readSelection(raw: unknown): readonly BoardId[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TRASH_SELECTION) {
    return null
  }
  const ids = raw.map((candidate) => readUuid(candidate))
  return ids.every((id): id is BoardId => id !== null) ? ids : null
}

export function createBoardTrashRoutes(context: AppContext): readonly Route[] {
  const { boards: store } = context
  const { deny, withLockedBoard } = createBoardGate(context)

  /**
   * Darf der Anfragende diese Zeile des Papierkorbs zuruecknehmen?
   *
   * **Dieselbe Funktion, die auch die Endpunkte befragt** - die Liste ist damit keine zweite Auslegung der
   * Regel, sondern ihre Anwendung auf jede Zeile. Ohne Protokollzeile: ein gefilterter Eintrag ist keine
   * abgelehnte Aktion, sondern einer, den es fuer diesen Anfragenden nicht gibt.
   */
  function mayHandle(
    auth: AuthenticatedSession,
    workspace: Workspace,
    entry: TrashedBoardEntry,
    role: WorkspaceRole | null,
  ): boolean {
    const subject = boardSubject(asRequester(auth), {
      role,
      boardRole: entry.boardRole,
      guestRole: null,
      board: entry.board,
    })
    return decideBoardAccess(subject, workspace, entry.board, 'board:restore').allowed
  }

  function toTrashEntryView(entry: TrashedBoardEntry): BoardTrashEntryView {
    return {
      id: entry.board.id,
      workspaceId: entry.board.workspaceId,
      title: entry.board.title,
      ownerUserId: entry.board.ownerId,
      ownerDisplayName: entry.ownerDisplayName,
      folderId: entry.board.folderId,
      folderName: entry.folderName,
      deletedByUserId: entry.deletedByUserId,
      deletedByDisplayName: entry.deletedByDisplayName,
      deletedAt: entry.deletedAt.toISOString(),
      purgeAt: trashPurgeAt(entry.deletedAt, context.config.trashRetentionDays).toISOString(),
      status: entry.board.status,
    }
  }

  /**
   * Ein Board des Papierkorbs unter der Zeilensperre laden und die Aktion entscheiden.
   *
   * Gemeinsamer Einstieg von Zuruecknehmen und endgueltigem Entfernen: beide brauchen genau dieselben vier
   * Schritte, und eine zweite Fassung waere die Stelle, an der eine der beiden einmal weniger prueft.
   */
  async function withTrashedBoard(
    boardId: BoardId,
    auth: AuthenticatedSession,
    action: BoardAction,
    run: (tx: BoardStore, access: BoardAccess) => Promise<Reply>,
  ): Promise<Reply> {
    return store.transaction(async (tx) => {
      const access = await tx.boards.findTrashedForUpdate(boardId, auth.user.id)
      if (access === null) {
        return fail(404, TRASH_NOT_FOUND)
      }
      // Sichtbarkeit zuerst: wer den Arbeitsbereich nicht sieht, bekommt dieselbe Antwort wie fuer eine
      // erfundene Kennung - `board:read` ist auf einem geloeschten Board fuer niemanden erlaubt, deshalb
      // entscheidet hier unmittelbar die Aktion selbst.
      const denial = deny(asRequester(auth), access.workspace, access, action)
      if (denial !== null) {
        // Ein Nichtmitglied darf nicht einmal erfahren, dass es das Board gab.
        return denial.status === DENIALS['not-visible'].status ? fail(404, TRASH_NOT_FOUND) : denial
      }
      return run(tx, access)
    })
  }

  /** Eine Auswahl abarbeiten: jede Kennung einzeln, jede mit eigener Transaktion und eigenem Ergebnis. */
  async function handleSelection(
    boardIds: readonly BoardId[],
    handle: (boardId: BoardId) => Promise<Reply>,
  ): Promise<TrashSelectionResponse> {
    const results: TrashActionResultView[] = []
    for (const boardId of boardIds) {
      const reply = await handle(boardId)
      results.push(
        reply.status < 300
          ? { boardId, ok: true, error: null }
          : { boardId, ok: false, error: (reply.body as { error?: string }).error ?? 'Fehlgeschlagen' },
      )
    }
    return { results }
  }

  return [
    /**
     * Papierkorb genau eines Arbeitsbereichs.
     *
     * Die Mitgliedschaft ist die Eintrittskarte wie bei jeder Boardliste; die Zeilen selbst sind zusaetzlich
     * je Board gefiltert. Wer die Bestandsverantwortung nicht traegt, bekommt eine leere Liste - und auf
     * jede Aktion eine Ablehnung.
     */
    {
      method: 'GET',
      path: BOARD_TRASH_PATH,
      handle: async ({ request, response, url }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        const workspaceId = readUuid(url.searchParams.get(WORKSPACE_ID_PARAM))
        if (workspaceId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        const access = await store.workspaces.findForUser(workspaceId, auth.user.id)
        if (access === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        const denial = deny(asRequester(auth), access.workspace, withoutBoard(access.role), 'board:read')
        if (denial !== null) {
          send(response, denial)
          return
        }
        const entries = await store.boards.listTrashed(workspaceId, auth.user.id)
        const body: BoardTrashResponse = {
          workspace: {
            id: access.workspace.id,
            name: access.workspace.name,
            status: access.workspace.status,
            role: access.role,
            createdAt: access.workspace.createdAt.toISOString(),
            updatedAt: access.workspace.updatedAt.toISOString(),
          },
          boards: entries
            .filter((entry) => mayHandle(auth, access.workspace, entry, access.role))
            .map(toTrashEntryView),
          retentionDays: context.config.trashRetentionDays,
        }
        send(response, ok(200, body))
      },
    },

    /**
     * Board in den Papierkorb legen.
     *
     * Geladen wird es ueber den gewoehnlichen Weg - es ist ja noch vorhanden - und unter derselben
     * Zeilensperre wie jede andere Boardaenderung. Die offenen Verbindungen fallen **nach dem Commit**:
     * eine zurueckgerollte Transaktion darf niemanden hinausgeworfen haben.
     */
    {
      method: 'POST',
      path: BOARD_TRASH_PATH,
      handle: async ({ request, response }) => {
        const trashed: { id: BoardId | null } = { id: null }
        await withLockedBoard(request, response, async (tx, auth, access) => {
          const denial = deny(asRequester(auth), access.workspace, access, 'board:trash')
          if (denial !== null) {
            return denial
          }
          const deletedAt = context.now()
          const board = await tx.boards.moveToTrash(access.board.id, deletedAt, auth.user.id)
          await tx.audit.record({
            actorId: auth.user.id,
            action: 'board.trashed',
            targetType: 'board',
            targetId: board.id,
            workspaceId: board.workspaceId,
            details: { title: board.title, folderId: board.folderId, status: board.status },
          })
          context.logger('info', 'board.trashed', {
            userId: auth.user.id,
            boardId: board.id,
            workspaceId: board.workspaceId,
          })
          const folder = board.folderId === null ? null : await tx.folders.find(board.folderId)
          trashed.id = board.id
          return ok(
            200,
            toTrashEntryView({
              board,
              ownerDisplayName: access.ownerDisplayName,
              boardRole: access.boardRole,
              folderName: folder?.name ?? null,
              deletedAt,
              deletedByUserId: auth.user.id,
              deletedByDisplayName: auth.user.displayName,
            }),
          )
        })
        if (trashed.id !== null) {
          // Fachlich unerreichbar heisst auch: jetzt und nicht beim naechsten Takt der Nachpruefung.
          context.rooms.closeBoard(trashed.id)
        }
      },
    },

    /**
     * Wiederherstellen aus dem Papierkorb.
     *
     * Der Archivzustand bleibt, wie er vor dem Loeschen war - er ist eine eigene Achse. Ist der
     * urspruengliche Ordner inzwischen weg, kehrt das Board **in den Arbeitsbereich** zurueck statt in einen
     * Fehler: eine Wiederherstellung soll nicht an der Gliederung scheitern.
     */
    {
      method: 'POST',
      path: BOARD_TRASH_RESTORE_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const boardIds = readSelection(guarded.body['boardIds'])
        if (boardIds === null) {
          sendError(response, 400, `boardIds muss 1 bis ${String(MAX_TRASH_SELECTION)} Boardkennungen enthalten`)
          return
        }
        const body = await handleSelection(boardIds, (boardId) =>
          withTrashedBoard(boardId, guarded.auth, 'board:restore', async (tx, access) => {
            const folder = access.board.folderId === null ? null : await tx.folders.find(access.board.folderId)
            const folderId = folder !== null && folder.workspaceId === access.workspace.id ? folder.id : null
            const board = await tx.boards.restoreFromTrash(access.board.id, folderId)
            await tx.audit.record({
              actorId: guarded.auth.user.id,
              action: 'board.restored',
              targetType: 'board',
              targetId: board.id,
              workspaceId: board.workspaceId,
              details: { title: board.title, folderId, status: board.status },
            })
            return ok(200, { boardId: board.id })
          }),
        )
        send(response, ok(200, body))
      },
    },

    /**
     * Sofortiges endgueltiges Loeschen.
     *
     * Reihenfolge und Vollstaendigkeit stehen in `trash.ts` und gelten hier genau wie im fristgesteuerten
     * Lauf. Die Bytes fallen erst nach dem Commit - und zwar ausserhalb der Schleife ueber die Auswahl, damit
     * ein Speicherfehler kein bereits entferntes Board zurueckbringt.
     */
    {
      method: 'POST',
      path: BOARD_TRASH_PURGE_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const boardIds = readSelection(guarded.body['boardIds'])
        if (boardIds === null) {
          sendError(response, 400, `boardIds muss 1 bis ${String(MAX_TRASH_SELECTION)} Boardkennungen enthalten`)
          return
        }
        const removed: { boardId: BoardId; keys: readonly string[] }[] = []
        const body = await handleSelection(boardIds, (boardId) =>
          withTrashedBoard(boardId, guarded.auth, 'board:purge', async (tx, access) => {
            const keys = await purgeBoardInTransaction(tx, access.board, guarded.auth.user.id, 'request')
            removed.push({ boardId, keys })
            context.logger('info', 'board.purged', {
              userId: guarded.auth.user.id,
              boardId,
              workspaceId: access.workspace.id,
            })
            return ok(200, { boardId })
          }),
        )
        for (const entry of removed) {
          await removeAssetBytes(context, entry.boardId, entry.keys)
        }
        send(response, ok(200, body))
      },
    },
  ]
}
