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
  AuthMethodsResponse,
  ChangePasswordRequest,
  CreateInvitationResponse,
  CreateUserRequest,
  CreateUserResponse,
  LocalLoginRequest,
  LocalLoginResponse,
  RedeemInvitationRequest,
  ResetPasswordRequest,
  BoardGrantChangeResponse,
  BoardGrantRoleView,
  BoardGrantsResponse,
  BoardShareLinkView,
  BoardShareLinksResponse,
  BoardVersionSceneResponse,
  BoardVersionsResponse,
  ImportBoardSceneResponse,
  RestoreBoardVersionResponse,
  BoardStatusView,
  BoardTrashEntryView,
  BoardTrashResponse,
  BoardView,
  BoardsResponse,
  CreateFolderRequest,
  FolderView,
  FoldersResponse,
  MoveFolderRequest,
  RemoveFolderResponse,
  RenameFolderRequest,
  CreateBoardShareLinkRequest,
  CreateBoardShareLinkResponse,
  DashboardFilterView,
  DashboardResponse,
  GuestSessionResponse,
  SaveSceneResponse,
  SceneResponse,
  TrashSelectionResponse,
  UploadBoardAssetResponse,
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
  ADMIN_USER_CREATE_PATH,
  ADMIN_USER_INVITATION_PATH,
  ADMIN_USER_INVITATION_REVOKE_PATH,
  ADMIN_USER_PASSWORD_PATH,
  ADMIN_USER_STATUS_PATH,
  ADMIN_USERS_PATH,
  ASSET_FILE_ID_PARAM,
  AUTH_INVITATION_REDEEM_PATH,
  AUTH_LOCAL_LOGIN_PATH,
  AUTH_LOCAL_PASSWORD_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_METHODS_PATH,
  BOARD_ASSETS_PATH,
  BOARD_DASHBOARD_PATH,
  BOARD_FOLDER_PARAM,
  BOARD_FOLDER_PATH,
  BOARD_EXPORT_PATH,
  BOARD_GRANT_ADD_PATH,
  BOARD_GRANT_REMOVE_PATH,
  BOARD_GRANT_ROLE_PATH,
  BOARD_GRANTS_PATH,
  BOARD_GUEST_JOIN_PATH,
  BOARD_GUEST_SESSION_PATH,
  BOARD_ID_PARAM,
  BOARD_IMPORT_PATH,
  BOARD_OWNER_PATH,
  BOARD_QUERY_PARAM,
  BOARD_RENAME_PATH,
  BOARD_SCENE_PATH,
  BOARD_SHARE_LINK_CREATE_PATH,
  BOARD_SHARE_LINK_REVOKE_PATH,
  BOARD_SHARE_LINKS_PATH,
  BOARD_STATUS_PARAM,
  BOARD_STATUS_PATH,
  BOARD_TRASH_PATH,
  BOARD_TRASH_PURGE_PATH,
  BOARD_TRASH_RESTORE_PATH,
  BOARD_VERSION_PARAM,
  BOARD_VERSION_RESTORE_PATH,
  BOARD_VERSION_SCENE_PATH,
  BOARD_VERSIONS_PATH,
  BOARD_WORKSPACE_PATH,
  BOARDS_PATH,
  CSRF_HEADER,
  DASHBOARD_FILTER_PARAM,
  FOLDER_MOVE_PATH,
  FOLDER_REMOVE_PATH,
  FOLDER_RENAME_PATH,
  FOLDERS_PATH,
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

/**
 * Welche Anmeldewege diese Instanz hat. Oeffentlich und ohne Sitzung: die Anmeldeseite fragt sie, bevor sie
 * irgendetwas anbietet.
 */
export async function fetchAuthMethods(): Promise<AuthMethodsResponse> {
  return request<AuthMethodsResponse>(AUTH_METHODS_PATH)
}

/**
 * Die drei unangemeldeten Anmeldestrecken tragen kein CSRF-Token: es gibt noch keine Sitzung, an die es
 * gebunden waere. Der Server prueft stattdessen die Herkunft.
 */
function anonymousPost(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

export async function localLogin(credentials: LocalLoginRequest): Promise<LocalLoginResponse> {
  return request<LocalLoginResponse>(AUTH_LOCAL_LOGIN_PATH, anonymousPost(credentials))
}

export async function changePassword(change: ChangePasswordRequest): Promise<LocalLoginResponse> {
  return request<LocalLoginResponse>(AUTH_LOCAL_PASSWORD_PATH, anonymousPost(change))
}

export async function redeemInvitation(redemption: RedeemInvitationRequest): Promise<LocalLoginResponse> {
  return request<LocalLoginResponse>(AUTH_INVITATION_REDEEM_PATH, anonymousPost(redemption))
}

export async function fetchAdminUsers(): Promise<AdminUsersResponse> {
  return request<AdminUsersResponse>(ADMIN_USERS_PATH)
}

export async function createUser(csrfToken: string, account: CreateUserRequest): Promise<CreateUserResponse> {
  return request<CreateUserResponse>(ADMIN_USER_CREATE_PATH, mutation(csrfToken, account))
}

export async function resetUserPassword(csrfToken: string, reset: ResetPasswordRequest): Promise<UserView> {
  return request<UserView>(ADMIN_USER_PASSWORD_PATH, mutation(csrfToken, reset))
}

export async function createUserInvitation(csrfToken: string, userId: string): Promise<CreateInvitationResponse> {
  return request<CreateInvitationResponse>(ADMIN_USER_INVITATION_PATH, mutation(csrfToken, { userId }))
}

export async function revokeUserInvitation(csrfToken: string, userId: string): Promise<UserView> {
  return request<UserView>(ADMIN_USER_INVITATION_REVOKE_PATH, mutation(csrfToken, { userId }))
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

/**
 * Boards eines Arbeitsbereichs. `status` trennt die aktive Liste von der Archivansicht.
 *
 * `folder` waehlt den Ordner: `null` heisst alle Boards des Arbeitsbereichs, `BOARD_FOLDER_ROOT` die ohne
 * Ordner, eine Kennung genau diesen einen. Gefiltert wird serverseitig; im Browser wird nichts nachgesiebt.
 */
export async function fetchBoards(
  workspaceId: string,
  options: { readonly status: BoardStatusView; readonly query: string; readonly folder?: string | null },
): Promise<BoardsResponse> {
  const params = new URLSearchParams({
    [WORKSPACE_ID_PARAM]: workspaceId,
    [BOARD_STATUS_PARAM]: options.status,
  })
  if (options.query !== '') {
    params.set(BOARD_QUERY_PARAM, options.query)
  }
  if (options.folder !== undefined && options.folder !== null) {
    params.set(BOARD_FOLDER_PARAM, options.folder)
  }
  return request<BoardsResponse>(`${BOARDS_PATH}?${params.toString()}`)
}

/* ---------------------------------------------------------------------------------------------------- */
/* Ordner                                                                                                */
/* ---------------------------------------------------------------------------------------------------- */

/** Der vollstaendige Ordnerbaum eines Arbeitsbereichs als flache Liste mit Elternbezug. */
export async function fetchFolders(workspaceId: string): Promise<FoldersResponse> {
  return request<FoldersResponse>(withWorkspace(FOLDERS_PATH, workspaceId))
}

export async function createFolder(csrfToken: string, folder: CreateFolderRequest): Promise<FolderView> {
  return request<FolderView>(FOLDERS_PATH, mutation(csrfToken, folder))
}

export async function renameFolder(csrfToken: string, change: RenameFolderRequest): Promise<FolderView> {
  return request<FolderView>(FOLDER_RENAME_PATH, mutation(csrfToken, change))
}

export async function moveFolder(csrfToken: string, change: MoveFolderRequest): Promise<FolderView> {
  return request<FolderView>(FOLDER_MOVE_PATH, mutation(csrfToken, change))
}

/** Entfernt den Ordner. Sein Inhalt rueckt an seinen Platz; die Antwort nennt, wie viel umgehaengt wurde. */
export async function removeFolder(csrfToken: string, folderId: string): Promise<RemoveFolderResponse> {
  return request<RemoveFolderResponse>(FOLDER_REMOVE_PATH, mutation(csrfToken, { folderId }))
}

/** Legt das Board in einen Ordner; `null` legt es unmittelbar in den Arbeitsbereich. */
export async function moveBoardToFolder(
  csrfToken: string,
  boardId: string,
  folderId: string | null,
): Promise<BoardView> {
  return request<BoardView>(BOARD_FOLDER_PATH, mutation(csrfToken, { boardId, folderId }))
}

/**
 * Verschiebt das Board in einen **anderen** Arbeitsbereich.
 *
 * Eine andere Aktion als die Ordnerablage und deshalb ein eigener Aufruf: interne Freigaben entfallen dabei
 * und gueltige Gastlinks werden widerrufen. Ohne `folderId` liegt das Board im Ziel unmittelbar im
 * Arbeitsbereich.
 */
export async function moveBoardToWorkspace(
  csrfToken: string,
  change: { readonly boardId: string; readonly workspaceId: string; readonly folderId?: string | null },
): Promise<BoardView> {
  return request<BoardView>(BOARD_WORKSPACE_PATH, mutation(csrfToken, change))
}

/* ---------------------------------------------------------------------------------------------------- */
/* Papierkorb                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

/**
 * Papierkorb eines Arbeitsbereichs. Die Liste ist serverseitig auf das gefiltert, was der Anfragende auch
 * zuruecknehmen darf; im Browser wird nichts nachgesiebt.
 */
export async function fetchBoardTrash(workspaceId: string): Promise<BoardTrashResponse> {
  return request<BoardTrashResponse>(withWorkspace(BOARD_TRASH_PATH, workspaceId))
}

/** Legt das Board in den Papierkorb. Es verschwindet damit sofort aus jeder Liste und jedem Zugriff. */
export async function trashBoard(csrfToken: string, boardId: string): Promise<BoardTrashEntryView> {
  return request<BoardTrashEntryView>(BOARD_TRASH_PATH, mutation(csrfToken, { boardId }))
}

/**
 * Nimmt eine Auswahl aus dem Papierkorb zurueck. Ein Board ist die Auswahl mit einem.
 *
 * Die Antwort ist **immer** 200 und nennt je Kennung ein eigenes Ergebnis: eine Auswahl ist kein
 * Alles-oder-nichts, und die Ansicht zeigt deshalb die Teilergebnisse.
 */
export async function restoreBoardsFromTrash(
  csrfToken: string,
  boardIds: readonly string[],
): Promise<TrashSelectionResponse> {
  return request<TrashSelectionResponse>(BOARD_TRASH_RESTORE_PATH, mutation(csrfToken, { boardIds }))
}

/** Entfernt eine Auswahl sofort endgueltig. Dieselbe Form der Antwort wie beim Zuruecknehmen. */
export async function purgeBoardsFromTrash(
  csrfToken: string,
  boardIds: readonly string[],
): Promise<TrashSelectionResponse> {
  return request<TrashSelectionResponse>(BOARD_TRASH_PURGE_PATH, mutation(csrfToken, { boardIds }))
}

/**
 * Arbeitsbereichsuebergreifende Boardliste des Dashboards.
 *
 * Filter und Suche gehen beide an den Server; im Browser wird nichts nachgefiltert. Ein Filter waehlt
 * serverseitig aus den ohnehin zugaenglichen Boards aus.
 */
export async function fetchDashboard(options: {
  readonly filter: DashboardFilterView | null
  readonly query: string
}): Promise<DashboardResponse> {
  const params = new URLSearchParams()
  if (options.filter !== null) {
    params.set(DASHBOARD_FILTER_PARAM, options.filter)
  }
  if (options.query !== '') {
    params.set(BOARD_QUERY_PARAM, options.query)
  }
  const suffix = params.size === 0 ? '' : `?${params.toString()}`
  return request<DashboardResponse>(`${BOARD_DASHBOARD_PATH}${suffix}`)
}

export async function createBoard(
  csrfToken: string,
  workspaceId: string,
  title: string,
  folderId: string | null,
): Promise<BoardView> {
  return request<BoardView>(BOARDS_PATH, mutation(csrfToken, { workspaceId, title, folderId }))
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

/**
 * Szene eines Boards. Die Antwort ist die Vereinigung beider Sichten: `viewer` unterscheidet die
 * Mitgliedsantwort von der reduzierten Gastantwort, und der Aufrufer muss darauf verzweigen.
 */
export async function fetchBoardScene(boardId: string): Promise<SceneResponse> {
  const params = new URLSearchParams({ [BOARD_ID_PARAM]: boardId })
  return request<SceneResponse>(`${BOARD_SCENE_PATH}?${params.toString()}`)
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

/* ---------------------------------------------------------------------------------------------------- */
/* Versionsverlauf, Export und Import                                                                    */
/* ---------------------------------------------------------------------------------------------------- */

/** Versionshistorie eines Boards. Die Antwort nennt auch, ob die eigene Rolle wiederherstellen darf. */
export async function fetchBoardVersions(boardId: string): Promise<BoardVersionsResponse> {
  const params = new URLSearchParams({ [BOARD_ID_PARAM]: boardId })
  return request<BoardVersionsResponse>(`${BOARD_VERSIONS_PATH}?${params.toString()}`)
}

/** Genau eine Version zum Ansehen. Sie wird dadurch nicht zum aktuellen Stand. */
export async function fetchBoardVersionScene(
  boardId: string,
  version: number,
): Promise<BoardVersionSceneResponse> {
  const params = new URLSearchParams({
    [BOARD_ID_PARAM]: boardId,
    [BOARD_VERSION_PARAM]: String(version),
  })
  return request<BoardVersionSceneResponse>(`${BOARD_VERSION_SCENE_PATH}?${params.toString()}`)
}

/**
 * Stellt eine fruehere Version als neuen aktuellen Stand her.
 *
 * `baseVersion` ist der Stand, den die Ansicht gerade zeigt. Ein 409 heisst: inzwischen hat jemand anderes
 * gespeichert - dann wurde **nichts** geschrieben, und die Bestaetigung ist ein zweiter Aufruf mit der vom
 * Server genannten Version.
 */
export async function restoreBoardVersion(
  csrfToken: string,
  change: { readonly boardId: string; readonly version: number; readonly baseVersion: number },
): Promise<RestoreBoardVersionResponse> {
  return request<RestoreBoardVersionResponse>(BOARD_VERSION_RESTORE_PATH, mutation(csrfToken, change))
}

/** Der Inhalt der `.excalidraw`-Datei dieses Boards, Bilder eingebettet. */
export async function fetchBoardExport(boardId: string): Promise<unknown> {
  const params = new URLSearchParams({ [BOARD_ID_PARAM]: boardId })
  return request<unknown>(`${BOARD_EXPORT_PATH}?${params.toString()}`)
}

/** Uebernimmt eine `.excalidraw`-Datei als neuen Stand. Derselbe Konfliktschutz wie bei einer Speicherung. */
export async function importBoardScene(
  csrfToken: string,
  change: { readonly boardId: string; readonly baseVersion: number; readonly file: unknown },
): Promise<ImportBoardSceneResponse> {
  return request<ImportBoardSceneResponse>(BOARD_IMPORT_PATH, mutation(csrfToken, change))
}

/* ---------------------------------------------------------------------------------------------------- */
/* Interne Boardfreigaben                                                                                */
/* ---------------------------------------------------------------------------------------------------- */

/** Freigabeliste eines Boards. Lesbar fuer jeden, der das Board sehen darf. */
export async function fetchBoardGrants(boardId: string): Promise<BoardGrantsResponse> {
  const params = new URLSearchParams({ [BOARD_ID_PARAM]: boardId })
  return request<BoardGrantsResponse>(`${BOARD_GRANTS_PATH}?${params.toString()}`)
}

export async function shareBoard(
  csrfToken: string,
  change: { readonly boardId: string; readonly userId: string; readonly role: BoardGrantRoleView },
): Promise<BoardGrantChangeResponse> {
  return request<BoardGrantChangeResponse>(BOARD_GRANT_ADD_PATH, mutation(csrfToken, change))
}

export async function changeBoardGrantRole(
  csrfToken: string,
  change: { readonly boardId: string; readonly userId: string; readonly role: BoardGrantRoleView },
): Promise<BoardGrantChangeResponse> {
  return request<BoardGrantChangeResponse>(BOARD_GRANT_ROLE_PATH, mutation(csrfToken, change))
}

export async function revokeBoardGrant(
  csrfToken: string,
  change: { readonly boardId: string; readonly userId: string },
): Promise<BoardGrantChangeResponse> {
  return request<BoardGrantChangeResponse>(BOARD_GRANT_REMOVE_PATH, mutation(csrfToken, change))
}

/** Uebertraegt die Ownerschaft. Die Antwort ist das Board mit seinem neuen Owner. */
export async function transferBoardOwnership(
  csrfToken: string,
  change: { readonly boardId: string; readonly userId: string },
): Promise<BoardView> {
  return request<BoardView>(BOARD_OWNER_PATH, mutation(csrfToken, change))
}

/* ---------------------------------------------------------------------------------------------------- */
/* Oeffentliche Gastfreigaben                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

export async function fetchBoardShareLinks(boardId: string): Promise<BoardShareLinksResponse> {
  const params = new URLSearchParams({ [BOARD_ID_PARAM]: boardId })
  return request<BoardShareLinksResponse>(`${BOARD_SHARE_LINKS_PATH}?${params.toString()}`)
}

/**
 * Legt einen Freigabelink an. Das Klartexttoken steht **genau einmal** in `url` dieser Antwort; es wird
 * deshalb nirgends abgelegt, sondern nur so lange im Zustand der Ansicht gehalten, wie sie es anzeigt.
 */
export async function createBoardShareLink(
  csrfToken: string,
  change: CreateBoardShareLinkRequest,
): Promise<CreateBoardShareLinkResponse> {
  return request<CreateBoardShareLinkResponse>(BOARD_SHARE_LINK_CREATE_PATH, mutation(csrfToken, change))
}

export async function revokeBoardShareLink(
  csrfToken: string,
  change: { readonly boardId: string; readonly shareLinkId: string },
): Promise<BoardShareLinkView> {
  return request<BoardShareLinkView>(BOARD_SHARE_LINK_REVOKE_PATH, mutation(csrfToken, change))
}

/**
 * Beitritt ueber einen Freigabelink.
 *
 * Der einzige Aufruf ohne CSRF-Token: es gibt noch keine Sitzung, an die eines gebunden waere. Der Server
 * prueft dafuer die Herkunft. Das Token bleibt im Speicher dieser Seite und wird nirgends abgelegt.
 */
export async function joinBoardAsGuest(token: string, displayName: string): Promise<GuestSessionResponse> {
  return request<GuestSessionResponse>(BOARD_GUEST_JOIN_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, displayName }),
  })
}

/** `null` bedeutet: kein gueltiger Gastzugang. Alles andere ist ein echter Fehler. */
export async function fetchGuestSession(): Promise<GuestSessionResponse | null> {
  try {
    return await request<GuestSessionResponse>(BOARD_GUEST_SESSION_PATH)
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null
    }
    throw error
  }
}

/* ---------------------------------------------------------------------------------------------------- */
/* Bildassets                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

/**
 * Zerlegt eine Data-URL des Editors in Typ und Bytes.
 *
 * Der Upload traegt die rohen Bytes, nicht die Base64-Zeichenkette: das spart ein Drittel Uebertragung und
 * der Server prueft ohnehin den tatsaechlichen Inhalt. `atob` und eine Schleife reichen dafuer; eine
 * Bibliothek dafuer waere ein Paket fuer sechs Zeilen.
 */
function decodeDataUrl(dataUrl: string): { readonly mimeType: string; readonly body: ArrayBuffer } {
  const comma = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) {
    throw new ApiError(0, 'Das Bild liegt in einer unerwarteten Form vor.')
  }
  const mimeType = dataUrl.slice('data:'.length, comma).split(';')[0] ?? ''
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return { mimeType, body: bytes.buffer }
}

function assetQuery(boardId: string, fileId: string): string {
  return new URLSearchParams({ [BOARD_ID_PARAM]: boardId, [ASSET_FILE_ID_PARAM]: fileId }).toString()
}

/**
 * Laedt ein Bild zu einem Board hoch und liefert die Referenz, mit der die Szene es fuehrt.
 *
 * Idempotent: derselbe Inhalt unter derselben Kennung ergibt dieselbe Antwort, ohne ein zweites Mal zu
 * speichern.
 */
export async function uploadBoardAsset(
  csrfToken: string,
  boardId: string,
  fileId: string,
  dataUrl: string,
): Promise<UploadBoardAssetResponse> {
  const { mimeType, body } = decodeDataUrl(dataUrl)
  return request<UploadBoardAssetResponse>(`${BOARD_ASSETS_PATH}?${assetQuery(boardId, fileId)}`, {
    method: 'POST',
    headers: { [CSRF_HEADER]: csrfToken, 'content-type': mimeType },
    body,
  })
}

/**
 * Holt die Bytes eines Bildes ueber den autorisierten Endpunkt und macht daraus eine Data-URL fuer den
 * Editor. Es gibt keine oeffentliche Bild-URL: die Sitzung entscheidet bei jedem einzelnen Abruf.
 */
export async function fetchBoardAssetDataUrl(boardId: string, fileId: string): Promise<string> {
  const response = await fetch(`${BOARD_ASSETS_PATH}?${assetQuery(boardId, fileId)}`, {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Das Bild konnte nicht geladen werden (${String(response.status)}).`)
  }
  const blob = await response.blob()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(String(reader.result))
    }
    reader.onerror = () => {
      reject(new ApiError(0, 'Das Bild konnte nicht gelesen werden.'))
    }
    reader.readAsDataURL(blob)
  })
}
