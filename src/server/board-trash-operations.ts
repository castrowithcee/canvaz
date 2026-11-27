/**
 * Trash operations shared by the internal routes and the automation API.
 *
 * Same cut as the board operations: the caller authenticates and opens the transaction; the operation loads
 * the trashed board under its row lock where needed, decides the policy, applies the effect and records the
 * audit event. Purge is deliberately not here: it stays with the internal routes.
 */

import type { BoardTrashEntryView } from '../contracts/api.js'
import type { Board, BoardId } from '../domain/board/model.js'
import { trashPurgeAt } from '../domain/board/model.js'
import type { BoardAction } from '../domain/board/policy.js'
import { decideBoardAccess } from '../domain/board/policy.js'
import type { BoardAccess, BoardStore, TrashedBoardEntry } from '../domain/board/repositories.js'
import type { Workspace, WorkspaceAccess } from '../domain/workspace/model.js'
import { withoutBoard } from './board-access.js'
import type { Actor, BoardFailure } from './board-operations.js'
import { createBoardOperations } from './board-operations.js'
import type { AppContext } from './context.js'

export type TrashFailure = BoardFailure | { readonly kind: 'not-found' }

export function isTrashFailure<T extends object>(value: T | TrashFailure): value is TrashFailure {
  return 'kind' in value
}

export type TrashedBoard = {
  readonly board: Board
  readonly deletedAt: Date
  /** `null`: the board sits directly in the workspace. */
  readonly folderName: string | null
}

export type TrashOperations = {
  /**
   * The workspace's trash, filtered per row by `board:restore`; a denied `board:read` fails. The caller has
   * loaded the actor's workspace access.
   */
  listTrash(actor: Actor, access: WorkspaceAccess): Promise<readonly TrashedBoardEntry[] | BoardFailure>
  /** Row of the list as the contract shows it. */
  toTrashEntryView(entry: TrashedBoardEntry): BoardTrashEntryView
  /**
   * Loads a trashed board under its row lock and decides `action`. `not-found` for an unknown id; a denial
   * stays a denial so the caller picks the answer. Valid inside a transaction only.
   */
  loadTrashed(tx: BoardStore, actor: Actor, boardId: BoardId, action: BoardAction): Promise<BoardAccess | TrashFailure>
  /**
   * The caller holds the board row lock and has established that the actor may see the board. After commit
   * the caller closes open connections with `rooms.closeBoard`.
   */
  trashBoard(tx: BoardStore, actor: Actor, access: BoardAccess): Promise<TrashedBoard | BoardFailure>
  /** Loads, decides `board:restore` and restores; a missing folder returns the board to the workspace root. */
  restoreBoard(tx: BoardStore, actor: Actor, boardId: BoardId): Promise<Board | TrashFailure>
}

export function createTrashOperations(context: AppContext): TrashOperations {
  const { boards: store } = context
  const boardOperations = createBoardOperations(context)

  /** The list is the policy applied per row, not a second reading of it; a filtered row logs nothing. */
  function mayHandle(actor: Actor, workspace: Workspace, entry: TrashedBoardEntry, role: WorkspaceAccess['role']): boolean {
    const subject = actor.subject({ role, boardRole: entry.boardRole, guestRole: null, board: entry.board })
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

  async function loadTrashed(
    tx: BoardStore,
    actor: Actor,
    boardId: BoardId,
    action: BoardAction,
  ): Promise<BoardAccess | TrashFailure> {
    const access = await tx.boards.findTrashedForUpdate(boardId, actor.userId)
    if (access === null) {
      return { kind: 'not-found' }
    }
    // `board:read` is allowed for nobody on a deleted board, so the action itself decides here.
    return boardOperations.decide(actor, access.workspace, access, action) ?? access
  }

  return {
    toTrashEntryView,
    loadTrashed,

    async listTrash(actor, access) {
      const denial = boardOperations.decide(actor, access.workspace, withoutBoard(access.role), 'board:read')
      if (denial !== null) {
        return denial
      }
      const entries = await store.boards.listTrashed(access.workspace.id, actor.userId)
      return entries.filter((entry) => mayHandle(actor, access.workspace, entry, access.role))
    },

    async trashBoard(tx, actor, access) {
      const denial = boardOperations.decide(actor, access.workspace, access, 'board:trash')
      if (denial !== null) {
        return denial
      }
      const deletedAt = context.now()
      const board = await tx.boards.moveToTrash(access.board.id, deletedAt, actor.userId)
      await tx.audit.record({
        actorId: actor.userId,
        action: 'board.trashed',
        targetType: 'board',
        targetId: board.id,
        workspaceId: board.workspaceId,
        details: { title: board.title, folderId: board.folderId, status: board.status, ...actor.auditDetails },
      })
      context.logger('info', 'board.trashed', {
        userId: actor.userId,
        boardId: board.id,
        workspaceId: board.workspaceId,
      })
      const folder = board.folderId === null ? null : await tx.folders.find(board.folderId)
      return { board, deletedAt, folderName: folder?.name ?? null }
    },

    async restoreBoard(tx, actor, boardId) {
      const access = await loadTrashed(tx, actor, boardId, 'board:restore')
      if (isTrashFailure(access)) {
        return access
      }
      const folder = access.board.folderId === null ? null : await tx.folders.find(access.board.folderId)
      const folderId = folder !== null && folder.workspaceId === access.workspace.id ? folder.id : null
      const board = await tx.boards.restoreFromTrash(access.board.id, folderId)
      await tx.audit.record({
        actorId: actor.userId,
        action: 'board.restored',
        targetType: 'board',
        targetId: board.id,
        workspaceId: board.workspaceId,
        details: { title: board.title, folderId, status: board.status, ...actor.auditDetails },
      })
      return board
    },
  }
}
