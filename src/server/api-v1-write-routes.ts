/**
 * Write operations of the automation API: create boards and folders, rename and place boards.
 *
 * Same order as the read operations, decided anew inside the transaction that holds the lock: a valid key,
 * every affected place lies in the key's target, the level `edit`, then the regular policies with a subject
 * that has no system admin elevation. The effect itself is the shared operation the internal routes use.
 * Outside the target and invisible both answer like an invented id.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ApiV1BoardResponse, ApiV1Error, ApiV1ErrorCode, ApiV1FolderResponse } from '../contracts/api-v1.js'
import {
  API_V1_BOARD_MOVE_PATH,
  API_V1_BOARD_RENAME_PATH,
  API_V1_BOARDS_PATH,
  API_V1_FOLDERS_PATH,
} from '../contracts/api-v1.js'
import { MAX_BOARD_TITLE_LENGTH, normalizeBoardTitle } from '../domain/board/model.js'
import type { BoardDenialReason } from '../domain/board/policy.js'
import type { Folder, FolderId } from '../domain/folder/model.js'
import { MAX_FOLDER_NAME_LENGTH, normalizeFolderName } from '../domain/folder/model.js'
import type { FolderRepository } from '../domain/folder/repositories.js'
import type { ApiKeyTarget, ResolvedApiKey } from '../domain/identity/api-key.js'
import { apiKeyLevelAllows, isBoardInApiKeyTarget, isPlaceInApiKeyTarget } from '../domain/identity/api-key.js'
import type { WorkspaceId } from '../domain/workspace/model.js'
import type { ApiKeyGuard } from './api-key-guard.js'
import { LEVEL_TOO_LOW, NOT_FOUND, toBoard, toFolder } from './api-v1-routes.js'
import { DENIALS } from './board-access.js'
import type { Actor, BoardFailure } from './board-operations.js'
import { createBoardOperations, isBoardFailure } from './board-operations.js'
import type { AppContext } from './context.js'
import type { FolderFailure } from './folder-operations.js'
import { FOLDER_VIOLATIONS, createFolderOperations, isFolderFailure } from './folder-operations.js'
import type { Route } from './http.js'
import { readJsonBodyLimited, sendApiV1Error } from './http.js'
import type { Reply } from './reply.js'
import { ok, readUuid, send } from './reply.js'
import { apiKeyBoardSubject } from './requester.js'

const MAX_BODY_BYTES = 16_384

type Refusal = { readonly status: number; readonly code: ApiV1ErrorCode; readonly message: string }

const TITLE_EXPECTED: Refusal = {
  status: 400,
  code: 'bad_request',
  message: `Ein Titel mit 1 bis ${String(MAX_BOARD_TITLE_LENGTH)} Zeichen wird erwartet`,
}
const NAME_EXPECTED: Refusal = {
  status: 400,
  code: 'bad_request',
  message: `Ein Name mit 1 bis ${String(MAX_FOLDER_NAME_LENGTH)} Zeichen wird erwartet`,
}
const FOLDER_ID_EXPECTED: Refusal = {
  status: 400,
  code: 'bad_request',
  message: 'folderId wird erwartet, null fuer die Wurzel des Arbeitsbereichs',
}

function refuse(refusal: Refusal): Reply {
  const body: ApiV1Error = { code: refusal.code, message: refusal.message }
  return { status: refusal.status, body }
}

function sendRefusal(response: ServerResponse, refusal: Refusal): void {
  sendApiV1Error(response, refusal.status, refusal.code, refusal.message)
}

/** Absent and `null` mean the workspace root; `undefined` means malformed. */
function readPlacement(raw: unknown): FolderId | null | undefined {
  return raw === null || raw === undefined ? null : (readUuid(raw) ?? undefined)
}

function denialRefusal(reason: BoardDenialReason): Refusal {
  return reason === 'not-visible' || reason === 'user-deactivated'
    ? NOT_FOUND
    : { status: 403, code: 'forbidden', message: DENIALS[reason].message }
}

function boardFailureRefusal(failure: BoardFailure): Refusal {
  return failure.kind === 'folder-not-found' ? NOT_FOUND : denialRefusal(failure.reason)
}

function folderFailureRefusal(failure: FolderFailure): Refusal {
  if (failure.kind === 'denied') {
    return denialRefusal(failure.reason)
  }
  const { status, message } = FOLDER_VIOLATIONS[failure.violation]
  return status === 404 ? NOT_FOUND : { status, code: 'conflict', message }
}

function apiKeyActor(key: ResolvedApiKey): Actor {
  return {
    userId: key.key.userId,
    subject: (roles) => apiKeyBoardSubject(key, roles),
    logFields: { userId: key.key.userId, apiKeyId: key.key.id },
    auditDetails: { apiKeyId: key.key.id },
  }
}

/** Only a folder target needs the tree; it is read inside the caller's transaction. */
async function targetFolders(
  folders: FolderRepository,
  target: ApiKeyTarget,
  workspaceId: WorkspaceId,
): Promise<readonly Folder[]> {
  return target.kind === 'folder' ? folders.listForWorkspace(workspaceId) : []
}

export function createApiV1WriteRoutes(context: AppContext, authenticate: ApiKeyGuard): readonly Route[] {
  const boardOperations = createBoardOperations(context)
  const folderOperations = createFolderOperations(context)

  function levelRefusal(key: ResolvedApiKey): Refusal | null {
    if (apiKeyLevelAllows(key.level, 'edit')) {
      return null
    }
    context.logger('warn', 'authorization.denied', {
      userId: key.key.userId,
      apiKeyId: key.key.id,
      reason: 'api-key-level',
    })
    return LEVEL_TOO_LOW
  }

  async function readBody(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null> {
    const body = await readJsonBodyLimited(request, MAX_BODY_BYTES)
    if (!body.ok) {
      sendApiV1Error(
        response,
        400,
        'bad_request',
        body.reason === 'too-large' ? 'Der Anfragekoerper ist zu gross' : 'Ungueltiger Anfragekoerper',
      )
      return null
    }
    return body.body
  }

  return [
    {
      method: 'POST',
      path: API_V1_BOARDS_PATH,
      handle: async ({ request, response }) => {
        const key = await authenticate(request, response)
        const body = key === null ? null : await readBody(request, response)
        if (key === null || body === null) {
          return
        }
        const workspaceId = readUuid(body['workspaceId'])
        const title = normalizeBoardTitle(body['title'])
        const folderId = readPlacement(body['folderId'])
        if (workspaceId === null || folderId === undefined) {
          sendRefusal(response, NOT_FOUND)
          return
        }
        if (title === null) {
          sendRefusal(response, TITLE_EXPECTED)
          return
        }
        const reply = await context.boards.transaction(async (tx) => {
          const access = await tx.workspaces.findForUpdate(workspaceId, key.key.userId)
          if (access === null) {
            return refuse(NOT_FOUND)
          }
          const folders = await targetFolders(tx.folders, key.key.target, workspaceId)
          if (!isPlaceInApiKeyTarget(key.key.target, { workspaceId, folderId }, folders)) {
            return refuse(NOT_FOUND)
          }
          const level = levelRefusal(key)
          if (level !== null) {
            return refuse(level)
          }
          const board = await boardOperations.createBoard(tx, apiKeyActor(key), access, title, folderId)
          if (isBoardFailure(board)) {
            return refuse(boardFailureRefusal(board))
          }
          const created: ApiV1BoardResponse = { board: toBoard(board) }
          return ok(201, created)
        })
        send(response, reply)
      },
    },

    {
      method: 'POST',
      path: API_V1_BOARD_RENAME_PATH,
      handle: async ({ request, response }) => {
        const key = await authenticate(request, response)
        const body = key === null ? null : await readBody(request, response)
        if (key === null || body === null) {
          return
        }
        const boardId = readUuid(body['boardId'])
        const title = normalizeBoardTitle(body['title'])
        if (boardId === null) {
          sendRefusal(response, NOT_FOUND)
          return
        }
        if (title === null) {
          sendRefusal(response, TITLE_EXPECTED)
          return
        }
        const reply = await context.boards.transaction(async (tx) => {
          const access = await tx.boards.findForUpdate(boardId, { kind: 'user', userId: key.key.userId }, context.now())
          if (access === null) {
            return refuse(NOT_FOUND)
          }
          const folders = await targetFolders(tx.folders, key.key.target, access.board.workspaceId)
          if (!isBoardInApiKeyTarget(key.key.target, access.board, folders)) {
            return refuse(NOT_FOUND)
          }
          const level = levelRefusal(key)
          if (level !== null) {
            return refuse(level)
          }
          const renamed = await boardOperations.renameBoard(tx, apiKeyActor(key), access, title)
          if (isBoardFailure(renamed)) {
            return refuse(boardFailureRefusal(renamed))
          }
          const result: ApiV1BoardResponse = { board: toBoard(renamed) }
          return ok(200, result)
        })
        send(response, reply)
      },
    },

    {
      method: 'POST',
      path: API_V1_BOARD_MOVE_PATH,
      handle: async ({ request, response }) => {
        const key = await authenticate(request, response)
        const body = key === null ? null : await readBody(request, response)
        if (key === null || body === null) {
          return
        }
        const boardId = readUuid(body['boardId'])
        const folderId = readPlacement(body['folderId'])
        if (boardId === null || folderId === undefined) {
          sendRefusal(response, NOT_FOUND)
          return
        }
        // A forgotten field must not silently move the board to the root.
        if (!('folderId' in body)) {
          sendRefusal(response, FOLDER_ID_EXPECTED)
          return
        }
        const reply = await context.boards.transaction(async (tx) => {
          const access = await tx.boards.findForUpdate(boardId, { kind: 'user', userId: key.key.userId }, context.now())
          if (access === null) {
            return refuse(NOT_FOUND)
          }
          const { target } = key.key
          const workspaceId = access.board.workspaceId
          const folders = await targetFolders(tx.folders, target, workspaceId)
          if (
            !isBoardInApiKeyTarget(target, access.board, folders) ||
            !isPlaceInApiKeyTarget(target, { workspaceId, folderId }, folders)
          ) {
            return refuse(NOT_FOUND)
          }
          const level = levelRefusal(key)
          if (level !== null) {
            return refuse(level)
          }
          const moved = await boardOperations.moveBoard(tx, apiKeyActor(key), access, folderId)
          if (isBoardFailure(moved)) {
            return refuse(boardFailureRefusal(moved))
          }
          const result: ApiV1BoardResponse = { board: toBoard(moved) }
          return ok(200, result)
        })
        send(response, reply)
      },
    },

    {
      method: 'POST',
      path: API_V1_FOLDERS_PATH,
      handle: async ({ request, response }) => {
        const key = await authenticate(request, response)
        const body = key === null ? null : await readBody(request, response)
        if (key === null || body === null) {
          return
        }
        const workspaceId = readUuid(body['workspaceId'])
        const name = normalizeFolderName(body['name'])
        const parentId = readPlacement(body['parentId'])
        if (workspaceId === null || parentId === undefined) {
          sendRefusal(response, NOT_FOUND)
          return
        }
        if (name === null) {
          sendRefusal(response, NAME_EXPECTED)
          return
        }
        const reply = await context.workspaces.transaction(async (tx) => {
          const access = await tx.workspaces.findForUpdate(workspaceId, key.key.userId)
          if (access === null) {
            return refuse(NOT_FOUND)
          }
          const folders = await targetFolders(tx.folders, key.key.target, workspaceId)
          if (!isPlaceInApiKeyTarget(key.key.target, { workspaceId, folderId: parentId }, folders)) {
            return refuse(NOT_FOUND)
          }
          const level = levelRefusal(key)
          if (level !== null) {
            return refuse(level)
          }
          const created = await folderOperations.createFolder(tx, apiKeyActor(key), access, parentId, name)
          if (isFolderFailure(created)) {
            return refuse(folderFailureRefusal(created))
          }
          const result: ApiV1FolderResponse = { folder: toFolder(created) }
          return ok(201, result)
        })
        send(response, reply)
      },
    },
  ]
}
