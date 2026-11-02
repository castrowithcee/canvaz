/**
 * Versioned automation API contract. Kept apart from the SPA contract so internal views can change without
 * breaking tools.
 */

export const API_V1_BASE_PATH = '/api/v1'

export const API_V1_WORKSPACES_PATH = `${API_V1_BASE_PATH}/workspaces`
export const API_V1_FOLDERS_PATH = `${API_V1_BASE_PATH}/folders`
export const API_V1_BOARDS_PATH = `${API_V1_BASE_PATH}/boards`
export const API_V1_BOARD_METADATA_PATH = `${API_V1_BASE_PATH}/boards/metadata`

export const API_V1_WORKSPACE_ID_PARAM = 'workspaceId'
export const API_V1_BOARD_ID_PARAM = 'boardId'
/** Exact folder, or `API_V1_FOLDER_ROOT` for boards directly in the workspace. */
export const API_V1_FOLDER_ID_PARAM = 'folderId'
export const API_V1_FOLDER_ROOT = 'root'
/** `active` (default) or `archived`. */
export const API_V1_STATUS_PARAM = 'status'

export type ApiV1ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'rate_limited'
  | 'internal_error'

export type ApiV1Error = {
  readonly code: ApiV1ErrorCode
  readonly message: string
}

export type ApiV1Workspace = {
  readonly id: string
  readonly name: string
  readonly status: 'active' | 'archived'
  /** ISO-8601. */
  readonly createdAt: string
  readonly updatedAt: string
}

export type ApiV1Folder = {
  readonly id: string
  readonly workspaceId: string
  /** `null`: directly in the workspace. May name a folder outside the key's target. */
  readonly parentId: string | null
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type ApiV1Board = {
  readonly id: string
  readonly workspaceId: string
  readonly folderId: string | null
  readonly title: string
  readonly status: 'active' | 'archived'
  /** `0`: never saved. */
  readonly sceneVersion: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type ApiV1WorkspacesResponse = { readonly workspaces: readonly ApiV1Workspace[] }
export type ApiV1FoldersResponse = { readonly folders: readonly ApiV1Folder[] }
export type ApiV1BoardsResponse = { readonly boards: readonly ApiV1Board[] }
export type ApiV1BoardResponse = { readonly board: ApiV1Board }

/** Write operations: `POST` with a JSON body; ids travel in the body. */
export const API_V1_BOARD_RENAME_PATH = `${API_V1_BASE_PATH}/boards/rename`
export const API_V1_BOARD_MOVE_PATH = `${API_V1_BASE_PATH}/boards/move`

/** `POST API_V1_BOARDS_PATH`. Without `folderId` (or `null`) the board lands directly in the workspace. */
export type ApiV1CreateBoardRequest = {
  readonly workspaceId: string
  readonly title: string
  readonly folderId?: string | null
}

export type ApiV1RenameBoardRequest = { readonly boardId: string; readonly title: string }

/** `folderId` is required; `null` moves the board directly into the workspace. */
export type ApiV1MoveBoardRequest = { readonly boardId: string; readonly folderId: string | null }

/** `POST API_V1_FOLDERS_PATH`. Without `parentId` (or `null`) the folder lands directly in the workspace. */
export type ApiV1CreateFolderRequest = {
  readonly workspaceId: string
  readonly name: string
  readonly parentId?: string | null
}

export type ApiV1FolderResponse = { readonly folder: ApiV1Folder }
