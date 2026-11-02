/**
 * Folder operations shared by the internal routes and the automation API.
 *
 * Same cut as the board operations: the caller authenticates, loads and locks the workspace row; the
 * operation decides the policy, checks the placement against the folder set read under that lock, applies
 * the effect and records the audit event.
 */

import type { Folder, FolderId, FolderViolation } from '../domain/folder/model.js'
import { MAX_FOLDER_DEPTH, checkFolderPlacement } from '../domain/folder/model.js'
import type { WorkspaceAccess } from '../domain/workspace/model.js'
import type { DenialReason } from '../domain/workspace/policy.js'
import { decideWorkspaceAccess } from '../domain/workspace/policy.js'
import type { WorkspaceStore } from '../domain/workspace/repositories.js'
import { withoutBoard } from './board-access.js'
import type { Actor } from './board-operations.js'
import type { AppContext } from './context.js'

export const FOLDER_NOT_FOUND = 'Ordner nicht gefunden'

/**
 * Answers to the four placement invariants. A foreign parent answers exactly like an invented one, so the
 * answer never reveals that it exists elsewhere. The other three are conflicts with a tree the requester
 * can see anyway, so they name their reason.
 */
export const FOLDER_VIOLATIONS: Readonly<
  Record<FolderViolation, { readonly status: 404 | 409; readonly message: string }>
> = {
  'fremder-arbeitsbereich': { status: 404, message: FOLDER_NOT_FOUND },
  zyklus: { status: 409, message: 'Ein Ordner kann nicht unter sich selbst oder einen seiner Unterordner wandern' },
  'name-doppelt': { status: 409, message: 'An dieser Stelle gibt es bereits einen Ordner mit diesem Namen' },
  'zu-tief': {
    status: 409,
    message: `Ordner lassen sich hoechstens ${String(MAX_FOLDER_DEPTH)} Ebenen tief verschachteln`,
  },
}

export type FolderFailure =
  | { readonly kind: 'denied'; readonly reason: DenialReason }
  | { readonly kind: 'violation'; readonly violation: FolderViolation }

export function isFolderFailure(value: Folder | FolderFailure): value is FolderFailure {
  return 'kind' in value
}

export type FolderOperations = {
  /** The caller holds the workspace row lock; without it two moves could close a cycle together. */
  createFolder(
    tx: WorkspaceStore,
    actor: Actor,
    access: WorkspaceAccess,
    parentId: FolderId | null,
    name: string,
  ): Promise<Folder | FolderFailure>
}

export function createFolderOperations(context: AppContext): FolderOperations {
  return {
    async createFolder(tx, actor, access, parentId, name) {
      const workspaceId = access.workspace.id
      const decision = decideWorkspaceAccess(actor.subject(withoutBoard(access.role)), access.workspace, {
        kind: 'folder:manage',
      })
      if (!decision.allowed) {
        context.logger('warn', 'authorization.denied', {
          ...actor.logFields,
          workspaceId,
          action: 'folder:manage',
          reason: decision.reason,
        })
        return { kind: 'denied', reason: decision.reason }
      }
      const folders = await tx.folders.listForWorkspace(workspaceId)
      const violation = checkFolderPlacement(folders, { id: null, workspaceId, parentId, name })
      if (violation !== null) {
        return { kind: 'violation', violation }
      }
      const created = await tx.folders.create(workspaceId, parentId, name)
      await tx.audit.record({
        actorId: actor.userId,
        action: 'folder.created',
        targetType: 'board-folder',
        targetId: created.id,
        workspaceId,
        details: { name: created.name, parentId, ...actor.auditDetails },
      })
      return created
    },
  }
}
