/**
 * Board operations shared by the internal routes and the automation API.
 *
 * Each operation runs inside the caller's transaction, after the caller has loaded and locked the record:
 * it decides the policy, applies the effect and records the audit event. How the actor authenticated, and
 * how a failure becomes an HTTP answer, stays with the caller.
 */

import type { Board } from '../domain/board/model.js'
import type { BoardAction, BoardDenialReason, BoardSubject } from '../domain/board/policy.js'
import { decideBoardAccess } from '../domain/board/policy.js'
import type { BoardAccess, BoardStore } from '../domain/board/repositories.js'
import type { FolderId } from '../domain/folder/model.js'
import type { AuthenticatedSession, UserId } from '../domain/identity/model.js'
import type { Workspace, WorkspaceAccess, WorkspaceId } from '../domain/workspace/model.js'
import { withoutBoard } from './board-access.js'
import type { AppContext } from './context.js'
import type { LogFields } from './log.js'
import type { BoardRoles } from './requester.js'
import { asRequester, boardSubject, requesterFields } from './requester.js'

/** Who acts. An internal session and an API key differ only here. */
export type Actor = {
  readonly userId: UserId
  subject(roles: BoardRoles): BoardSubject
  /** Names the actor in `authorization.denied`; never a secret. */
  readonly logFields: LogFields
  /** Added to the details of every audit event; never a secret. */
  readonly auditDetails: LogFields
}

export function sessionActor(auth: AuthenticatedSession): Actor {
  const requester = asRequester(auth)
  return {
    userId: auth.user.id,
    subject: (roles) => boardSubject(requester, roles),
    logFields: requesterFields(requester),
    auditDetails: {},
  }
}

export type BoardFailure =
  | { readonly kind: 'denied'; readonly reason: BoardDenialReason }
  | { readonly kind: 'folder-not-found' }

export function isBoardFailure(value: Board | BoardFailure): value is BoardFailure {
  return 'kind' in value
}

/**
 * Whether the folder belongs to this workspace; `null` (the root) always does. A foreign folder must answer
 * like an invented one, and as a named 404 rather than a foreign key error.
 */
export async function isFolderOfWorkspace(
  tx: BoardStore,
  workspaceId: WorkspaceId,
  folderId: FolderId | null,
): Promise<boolean> {
  if (folderId === null) {
    return true
  }
  const folder = await tx.folders.find(folderId)
  return folder !== null && folder.workspaceId === workspaceId
}

export type BoardOperations = {
  decide(actor: Actor, workspace: Workspace, roles: BoardRoles, action: BoardAction): BoardFailure | null
  /** The caller holds the workspace row lock, so a concurrent archive cannot slip a board in behind it. */
  createBoard(
    tx: BoardStore,
    actor: Actor,
    access: WorkspaceAccess,
    title: string,
    folderId: FolderId | null,
  ): Promise<Board | BoardFailure>
  /** The caller holds the board row lock and has established that the actor may see the board. */
  renameBoard(tx: BoardStore, actor: Actor, access: BoardAccess, title: string): Promise<Board | BoardFailure>
  /** Placement within the board's workspace; same caller duties as `renameBoard`. */
  moveBoard(
    tx: BoardStore,
    actor: Actor,
    access: BoardAccess,
    folderId: FolderId | null,
  ): Promise<Board | BoardFailure>
}

export function createBoardOperations(context: AppContext): BoardOperations {
  function decide(actor: Actor, workspace: Workspace, roles: BoardRoles, action: BoardAction): BoardFailure | null {
    const decision = decideBoardAccess(actor.subject(roles), workspace, roles.board, action)
    if (decision.allowed) {
      return null
    }
    context.logger('warn', 'authorization.denied', {
      ...actor.logFields,
      workspaceId: workspace.id,
      ...(roles.board === null ? {} : { boardId: roles.board.id }),
      action,
      reason: decision.reason,
    })
    return { kind: 'denied', reason: decision.reason }
  }

  return {
    decide,

    async createBoard(tx, actor, access, title, folderId) {
      const denial = decide(actor, access.workspace, withoutBoard(access.role), 'board:create')
      if (denial !== null) {
        return denial
      }
      if (!(await isFolderOfWorkspace(tx, access.workspace.id, folderId))) {
        return { kind: 'folder-not-found' }
      }
      const board = await tx.boards.create(access.workspace.id, title, actor.userId, folderId)
      await tx.audit.record({
        actorId: actor.userId,
        action: 'board.created',
        targetType: 'board',
        targetId: board.id,
        workspaceId: access.workspace.id,
        details: { title: board.title, folderId, ...actor.auditDetails },
      })
      return board
    },

    async renameBoard(tx, actor, access, title) {
      const denial = decide(actor, access.workspace, access, 'board:rename')
      if (denial !== null) {
        return denial
      }
      const renamed = await tx.boards.rename(access.board.id, title)
      await tx.audit.record({
        actorId: actor.userId,
        action: 'board.renamed',
        targetType: 'board',
        targetId: renamed.id,
        workspaceId: renamed.workspaceId,
        details: { previousTitle: access.board.title, title: renamed.title, ...actor.auditDetails },
      })
      return renamed
    },

    async moveBoard(tx, actor, access, folderId) {
      const denial = decide(actor, access.workspace, access, 'board:move')
      if (denial !== null) {
        return denial
      }
      if (!(await isFolderOfWorkspace(tx, access.workspace.id, folderId))) {
        return { kind: 'folder-not-found' }
      }
      const moved = await tx.boards.setFolder(access.board.id, folderId)
      await tx.audit.record({
        actorId: actor.userId,
        action: 'board.moved',
        targetType: 'board',
        targetId: moved.id,
        workspaceId: moved.workspaceId,
        details: { previousFolderId: access.board.folderId, folderId, ...actor.auditDetails },
      })
      return moved
    },
  }
}
