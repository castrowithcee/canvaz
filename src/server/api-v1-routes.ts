/**
 * Read operations of the automation API.
 *
 * Every operation checks, in this order and without caching: a valid key, the object lies in the key's
 * target (decided anew from the current folder tree and board placement), the effective level carries the
 * action, and the regular policies with a subject that has no system admin elevation. Outside the target and
 * invisible both answer like an invented id.
 */

import type { ServerResponse } from 'node:http'

import type { ApiV1Board, ApiV1Folder, ApiV1Workspace } from '../contracts/api-v1.js'
import {
  API_V1_BOARD_ID_PARAM,
  API_V1_BOARD_METADATA_PATH,
  API_V1_BOARDS_PATH,
  API_V1_FOLDER_ID_PARAM,
  API_V1_FOLDER_ROOT,
  API_V1_FOLDERS_PATH,
  API_V1_STATUS_PARAM,
  API_V1_WORKSPACE_ID_PARAM,
  API_V1_WORKSPACES_PATH,
} from '../contracts/api-v1.js'
import type { ApiV1BoardResponse, ApiV1BoardsResponse, ApiV1FoldersResponse, ApiV1WorkspacesResponse } from '../contracts/api-v1.js'
import type { Board, BoardStatus } from '../domain/board/model.js'
import { parseBoardStatus } from '../domain/board/model.js'
import type { BoardDecision } from '../domain/board/policy.js'
import { decideBoardAccess } from '../domain/board/policy.js'
import type { BoardAccess, BoardFilter, BoardViewer } from '../domain/board/repositories.js'
import type { Folder } from '../domain/folder/model.js'
import { isInFolderSubtree } from '../domain/folder/model.js'
import type { ApiKeyLevel, ResolvedApiKey } from '../domain/identity/api-key.js'
import { apiKeyLevelAllows, isBoardInApiKeyTarget } from '../domain/identity/api-key.js'
import type { Workspace, WorkspaceAccess } from '../domain/workspace/model.js'
import { decideWorkspaceAccess } from '../domain/workspace/policy.js'
import type { ApiKeyGuard } from './api-key-guard.js'
import type { AppContext } from './context.js'
import type { Route } from './http.js'
import { sendApiV1Error, sendJson } from './http.js'
import { readUuid } from './reply.js'
import { apiKeyBoardSubject } from './requester.js'

type Denial = { readonly status: 400 | 403 | 404; readonly code: 'bad_request' | 'forbidden' | 'not_found'; readonly message: string }

export const NOT_FOUND: Denial = { status: 404, code: 'not_found', message: 'Nicht gefunden' }
export const LEVEL_TOO_LOW: Denial = { status: 403, code: 'forbidden', message: 'Die Stufe des API-Keys reicht nicht' }
const FORBIDDEN: Denial = { status: 403, code: 'forbidden', message: 'Keine Berechtigung fuer diese Aktion' }
const BAD_STATUS: Denial = { status: 400, code: 'bad_request', message: 'status muss active oder archived sein' }

function isDenial(value: object): value is Denial {
  return 'code' in value
}

function sendDenial(response: ServerResponse, denial: Denial): void {
  sendApiV1Error(response, denial.status, denial.code, denial.message)
}

/** What of one workspace lies in the key's target, loaded fresh on every call. */
type Scope = {
  readonly access: WorkspaceAccess
  /** Folders of the target: all, the subtree, or none for a board key. */
  readonly folders: readonly Folder[]
  /** Whether boards directly in the workspace belong to the target. */
  readonly rootInTarget: boolean
  /** Only for a board key. */
  readonly board: BoardAccess | null
}

function toWorkspace(workspace: Workspace): ApiV1Workspace {
  return {
    id: workspace.id,
    name: workspace.name,
    status: workspace.status,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  }
}

export function toFolder(folder: Folder): ApiV1Folder {
  return {
    id: folder.id,
    workspaceId: folder.workspaceId,
    parentId: folder.parentId,
    name: folder.name,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
  }
}

export function toBoard(board: Board): ApiV1Board {
  return {
    id: board.id,
    workspaceId: board.workspaceId,
    folderId: board.folderId,
    title: board.title,
    status: board.status,
    sceneVersion: board.sceneVersion,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
  }
}

/** `authenticate` is shared with the write routes so that one rate limit counts every call of a key. */
export function createApiV1Routes(context: AppContext, authenticate: ApiKeyGuard): readonly Route[] {
  function viewerOf(key: ResolvedApiKey): BoardViewer {
    return { kind: 'user', userId: key.key.userId }
  }

  /** Steps 3 and 4; the caller has already established step 2. */
  function admit(key: ResolvedApiKey, required: ApiKeyLevel, decide: () => BoardDecision): Denial | null {
    if (!apiKeyLevelAllows(key.level, required)) {
      context.logger('warn', 'authorization.denied', {
        userId: key.key.userId,
        apiKeyId: key.key.id,
        reason: 'api-key-level',
      })
      return LEVEL_TOO_LOW
    }
    const decision = decide()
    if (decision.allowed) {
      return null
    }
    context.logger('warn', 'authorization.denied', {
      userId: key.key.userId,
      apiKeyId: key.key.id,
      reason: decision.reason,
    })
    return decision.reason === 'not-visible' || decision.reason === 'user-deactivated' ? NOT_FOUND : FORBIDDEN
  }

  async function resolveScope(key: ResolvedApiKey): Promise<Scope | null> {
    const { target } = key.key
    const userId = key.key.userId
    switch (target.kind) {
      case 'workspace': {
        const access = await context.workspaces.workspaces.findForUser(target.workspaceId, userId)
        if (access === null) {
          return null
        }
        const folders = await context.workspaces.folders.listForWorkspace(target.workspaceId)
        return { access, folders, rootInTarget: true, board: null }
      }
      case 'folder': {
        const root = await context.workspaces.folders.find(target.folderId)
        if (root === null) {
          return null
        }
        const access = await context.workspaces.workspaces.findForUser(root.workspaceId, userId)
        if (access === null) {
          return null
        }
        const all = await context.workspaces.folders.listForWorkspace(root.workspaceId)
        const folders = all.filter((folder) => isInFolderSubtree(all, folder.id, root.id))
        return { access, folders, rootInTarget: false, board: null }
      }
      case 'board': {
        const board = await context.boards.boards.findForViewer(target.boardId, viewerOf(key), context.now())
        if (board === null) {
          return null
        }
        return { access: { workspace: board.workspace, role: board.role }, folders: [], rootInTarget: false, board }
      }
    }
  }

  /** A board key reaches its workspace only through the board, so it is judged by the board policy. */
  function decideScope(key: ResolvedApiKey, scope: Scope): BoardDecision {
    const { access, board } = scope
    if (board !== null) {
      return decideBoardAccess(apiKeyBoardSubject(key, board), board.workspace, board.board, 'board:read')
    }
    return decideWorkspaceAccess(apiKeyBoardSubject(key, { role: access.role, boardRole: null }), access.workspace, {
      kind: 'workspace:read',
    })
  }

  /** Shared entry of the operations that name a workspace. */
  async function loadWorkspaceScope(key: ResolvedApiKey, rawWorkspaceId: string | null): Promise<Scope | Denial> {
    const workspaceId = readUuid(rawWorkspaceId)
    if (workspaceId === null) {
      return NOT_FOUND
    }
    const scope = await resolveScope(key)
    if (scope === null || scope.access.workspace.id !== workspaceId) {
      return NOT_FOUND
    }
    return admit(key, 'read', () => decideScope(key, scope)) ?? scope
  }

  /** Folder filter within the target; anything outside it answers like an invented folder. */
  function folderFilter(scope: Scope, raw: string | null): { readonly folder: BoardFilter['folder'] } | Denial {
    if (raw === null || raw === '') {
      return { folder: scope.rootInTarget ? null : { folderIds: scope.folders.map((folder) => folder.id) } }
    }
    if (raw === API_V1_FOLDER_ROOT) {
      return scope.rootInTarget ? { folder: { folderId: null } } : NOT_FOUND
    }
    const folderId = readUuid(raw)
    return folderId !== null && scope.folders.some((folder) => folder.id === folderId)
      ? { folder: { folderId } }
      : NOT_FOUND
  }

  return [
    {
      method: 'GET',
      path: API_V1_WORKSPACES_PATH,
      handle: async ({ request, response }) => {
        const key = await authenticate(request, response)
        if (key === null) {
          return
        }
        const scope = await resolveScope(key)
        const denial = scope === null ? NOT_FOUND : admit(key, 'read', () => decideScope(key, scope))
        // Nothing visible in the target is an empty list, not an error.
        if (denial !== null && denial.status !== 404) {
          sendDenial(response, denial)
          return
        }
        const body: ApiV1WorkspacesResponse = {
          workspaces: scope !== null && denial === null ? [toWorkspace(scope.access.workspace)] : [],
        }
        sendJson(response, 200, body)
      },
    },

    {
      method: 'GET',
      path: API_V1_FOLDERS_PATH,
      handle: async ({ request, response, url }) => {
        const key = await authenticate(request, response)
        if (key === null) {
          return
        }
        const scope = await loadWorkspaceScope(key, url.searchParams.get(API_V1_WORKSPACE_ID_PARAM))
        if (isDenial(scope)) {
          sendDenial(response, scope)
          return
        }
        const body: ApiV1FoldersResponse = { folders: scope.folders.map(toFolder) }
        sendJson(response, 200, body)
      },
    },

    {
      method: 'GET',
      path: API_V1_BOARDS_PATH,
      handle: async ({ request, response, url }) => {
        const key = await authenticate(request, response)
        if (key === null) {
          return
        }
        const scope = await loadWorkspaceScope(key, url.searchParams.get(API_V1_WORKSPACE_ID_PARAM))
        if (isDenial(scope)) {
          sendDenial(response, scope)
          return
        }
        const rawStatus = url.searchParams.get(API_V1_STATUS_PARAM)
        const status: BoardStatus | null = rawStatus === null ? 'active' : parseBoardStatus(rawStatus)
        if (status === null) {
          sendDenial(response, BAD_STATUS)
          return
        }
        const filter = folderFilter(scope, url.searchParams.get(API_V1_FOLDER_ID_PARAM))
        if (isDenial(filter)) {
          sendDenial(response, filter)
          return
        }
        if (scope.board !== null) {
          // A board key's target holds no folder, so any folder filter has already been refused above.
          const body: ApiV1BoardsResponse = {
            boards: scope.board.board.status === status ? [toBoard(scope.board.board)] : [],
          }
          sendJson(response, 200, body)
          return
        }
        const { access } = scope
        const entries = await context.boards.boards.listForWorkspace(access.workspace.id, key.key.userId, {
          status,
          title: '',
          folder: filter.folder,
        })
        const body: ApiV1BoardsResponse = {
          boards: entries
            .filter(
              (entry) =>
                decideBoardAccess(
                  apiKeyBoardSubject(key, { role: access.role, boardRole: entry.boardRole }),
                  access.workspace,
                  entry.board,
                  'board:read',
                ).allowed,
            )
            .map((entry) => toBoard(entry.board)),
        }
        sendJson(response, 200, body)
      },
    },

    {
      method: 'GET',
      path: API_V1_BOARD_METADATA_PATH,
      handle: async ({ request, response, url }) => {
        const key = await authenticate(request, response)
        if (key === null) {
          return
        }
        const boardId = readUuid(url.searchParams.get(API_V1_BOARD_ID_PARAM))
        const access =
          boardId === null ? null : await context.boards.boards.findForViewer(boardId, viewerOf(key), context.now())
        if (access === null) {
          sendDenial(response, NOT_FOUND)
          return
        }
        const folders =
          key.key.target.kind === 'folder' ? await context.workspaces.folders.listForWorkspace(access.board.workspaceId) : []
        if (!isBoardInApiKeyTarget(key.key.target, access.board, folders)) {
          sendDenial(response, NOT_FOUND)
          return
        }
        const denial = admit(key, 'read', () =>
          decideBoardAccess(apiKeyBoardSubject(key, access), access.workspace, access.board, 'board:read'),
        )
        if (denial !== null) {
          sendDenial(response, denial)
          return
        }
        const body: ApiV1BoardResponse = { board: toBoard(access.board) }
        sendJson(response, 200, body)
      },
    },
  ]
}
