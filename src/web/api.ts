/**
 * HTTP-Zugang der SPA.
 *
 * Duenne Schicht ueber `fetch`: gemeinsame Fehlerform, CSRF-Header fuer zustandsaendernde Anfragen und die
 * geteilten Vertragstypen. Tokenmaterial des Identity Providers kennt der Browser nicht; die Sitzung lebt
 * ausschliesslich im HttpOnly-Cookie und wird nie in `localStorage` oder `sessionStorage` abgelegt.
 */

import type {
  AddWorkspaceMemberRequest,
  AdminUsersResponse,
  BoardSceneResponse,
  BoardStatusView,
  BoardView,
  BoardsResponse,
  SaveSceneResponse,
  ChangeWorkspaceMemberRoleRequest,
  LogoutResponse,
  MeResponse,
  RemoveWorkspaceMemberRequest,
  RenameWorkspaceRequest,
  SetUserStatusRequest,
  SetWorkspaceStatusRequest,
  UserView,
  WorkspaceCandidatesResponse,
  WorkspaceMemberChangeResponse,
  WorkspaceMembersResponse,
  WorkspaceView,
  WorkspacesResponse,
} from '../contracts/api.js'
import {
  ADMIN_USER_STATUS_PATH,
  ADMIN_USERS_PATH,
  AUTH_LOGOUT_PATH,
  BOARD_ID_PARAM,
  BOARD_QUERY_PARAM,
  BOARD_RENAME_PATH,
  BOARD_SCENE_PATH,
  BOARD_STATUS_PARAM,
  BOARD_STATUS_PATH,
  BOARDS_PATH,
  CSRF_HEADER,
  ME_PATH,
  WORKSPACE_ID_PARAM,
  WORKSPACE_MEMBER_ADD_PATH,
  WORKSPACE_MEMBER_CANDIDATES_PATH,
  WORKSPACE_MEMBER_QUERY_PARAM,
  WORKSPACE_MEMBER_REMOVE_PATH,
  WORKSPACE_MEMBER_ROLE_PATH,
  WORKSPACE_MEMBERS_PATH,
  WORKSPACE_RENAME_PATH,
  WORKSPACE_STATUS_PATH,
  WORKSPACES_PATH,
} from '../contracts/api.js'

import type { SceneSnapshot } from '../contracts/scene.js'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Anfrage fehlgeschlagen (${String(response.status)})`
    throw new ApiError(response.status, message)
  }
  return (await response.json()) as T
}

/** `null` bedeutet: nicht angemeldet. Alles andere ist ein echter Fehler. */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await request<MeResponse>(ME_PATH)
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null
    }
    throw error
  }
}

function mutation(csrfToken: string, body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { [CSRF_HEADER]: csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

export async function logout(csrfToken: string): Promise<LogoutResponse> {
  return request<LogoutResponse>(AUTH_LOGOUT_PATH, mutation(csrfToken))
}

export async function fetchAdminUsers(): Promise<AdminUsersResponse> {
  return request<AdminUsersResponse>(ADMIN_USERS_PATH)
}

export async function setUserStatus(csrfToken: string, change: SetUserStatusRequest): Promise<UserView> {
  return request<UserView>(ADMIN_USER_STATUS_PATH, mutation(csrfToken, change))
}

function withWorkspace(path: string, workspaceId: string): string {
  return `${path}?${new URLSearchParams({ [WORKSPACE_ID_PARAM]: workspaceId }).toString()}`
}

export async function fetchWorkspaces(): Promise<WorkspacesResponse> {
  return request<WorkspacesResponse>(WORKSPACES_PATH)
}

export async function createWorkspace(csrfToken: string, name: string): Promise<WorkspaceView> {
  return request<WorkspaceView>(WORKSPACES_PATH, mutation(csrfToken, { name }))
}

export async function renameWorkspace(csrfToken: string, change: RenameWorkspaceRequest): Promise<WorkspaceView> {
  return request<WorkspaceView>(WORKSPACE_RENAME_PATH, mutation(csrfToken, change))
}

export async function setWorkspaceStatus(
  csrfToken: string,
  change: SetWorkspaceStatusRequest,
): Promise<WorkspaceView> {
  return request<WorkspaceView>(WORKSPACE_STATUS_PATH, mutation(csrfToken, change))
}

export async function fetchWorkspaceMembers(workspaceId: string): Promise<WorkspaceMembersResponse> {
  return request<WorkspaceMembersResponse>(withWorkspace(WORKSPACE_MEMBERS_PATH, workspaceId))
}

/** Gezielte Suche; ohne Suchbegriff gibt es serverseitig keine Treffer. */
export async function fetchMemberCandidates(
  workspaceId: string,
  query: string,
): Promise<WorkspaceCandidatesResponse> {
  const params = new URLSearchParams({
    [WORKSPACE_ID_PARAM]: workspaceId,
    [WORKSPACE_MEMBER_QUERY_PARAM]: query,
  })
  return request<WorkspaceCandidatesResponse>(`${WORKSPACE_MEMBER_CANDIDATES_PATH}?${params.toString()}`)
}

export async function addWorkspaceMember(csrfToken: string, change: AddWorkspaceMemberRequest): Promise<void> {
  await request<unknown>(WORKSPACE_MEMBER_ADD_PATH, mutation(csrfToken, change))
}

export async function changeWorkspaceMemberRole(
  csrfToken: string,
  change: ChangeWorkspaceMemberRoleRequest,
): Promise<WorkspaceMemberChangeResponse> {
  return request<WorkspaceMemberChangeResponse>(WORKSPACE_MEMBER_ROLE_PATH, mutation(csrfToken, change))
}

export async function removeWorkspaceMember(
  csrfToken: string,
  change: RemoveWorkspaceMemberRequest,
): Promise<WorkspaceMemberChangeResponse> {
  return request<WorkspaceMemberChangeResponse>(WORKSPACE_MEMBER_REMOVE_PATH, mutation(csrfToken, change))
}

/* ---------------------------------------------------------------------------------------------------- */
/* Boards und Szenen                                                                                     */
/* ---------------------------------------------------------------------------------------------------- */

/** Boards eines Arbeitsbereichs. `status` trennt die aktive Liste von der Archivansicht. */
export async function fetchBoards(
  workspaceId: string,
  options: { readonly status: BoardStatusView; readonly query: string },
): Promise<BoardsResponse> {
  const params = new URLSearchParams({
    [WORKSPACE_ID_PARAM]: workspaceId,
    [BOARD_STATUS_PARAM]: options.status,
  })
  if (options.query !== '') {
    params.set(BOARD_QUERY_PARAM, options.query)
  }
  return request<BoardsResponse>(`${BOARDS_PATH}?${params.toString()}`)
}

export async function createBoard(csrfToken: string, workspaceId: string, title: string): Promise<BoardView> {
  return request<BoardView>(BOARDS_PATH, mutation(csrfToken, { workspaceId, title }))
}

export async function renameBoard(csrfToken: string, boardId: string, title: string): Promise<BoardView> {
  return request<BoardView>(BOARD_RENAME_PATH, mutation(csrfToken, { boardId, title }))
}

export async function setBoardStatus(
  csrfToken: string,
  boardId: string,
  status: BoardStatusView,
): Promise<BoardView> {
  return request<BoardView>(BOARD_STATUS_PATH, mutation(csrfToken, { boardId, status }))
}

export async function fetchBoardScene(boardId: string): Promise<BoardSceneResponse> {
  const params = new URLSearchParams({ [BOARD_ID_PARAM]: boardId })
  return request<BoardSceneResponse>(`${BOARD_SCENE_PATH}?${params.toString()}`)
}

/**
 * Speichert die Szene auf der genannten Ausgangsversion. Ein 409 kommt als `ApiError` an und darf nie
 * stillschweigend wiederholt werden - er bedeutet, dass jemand anderes bereits geschrieben hat.
 */
export async function saveBoardScene(
  csrfToken: string,
  payload: { readonly boardId: string; readonly baseVersion: number; readonly scene: SceneSnapshot },
): Promise<SaveSceneResponse> {
  return request<SaveSceneResponse>(BOARD_SCENE_PATH, mutation(csrfToken, payload))
}
