/**
 * Boards und Szenenpersistenz.
 *
 * Dieselbe Bauweise wie die Workspacerouten: kein Rollenvergleich in der Route, sondern das Laden des
 * Datensatzes samt eigener Rolle, ein Aufruf von `decideBoardAccess` und die Uebersetzung der Ablehnung.
 * `decideBoardAccess` baut seinerseits auf `decideWorkspaceAccess` auf, sodass es weiterhin genau eine
 * Stelle gibt, die ueber die Sichtbarkeit eines Workspace entscheidet.
 *
 * Jede zustandsaendernde Route laeuft in einer Transaktion, die die Boardzeile sperrt; die Antwort entsteht
 * darin und wird erst nach dem Commit gesendet.
 *
 * Antwortwahl, wie in Issue 3 festgelegt:
 * - Wer das Board nicht sehen darf, bekommt **404** - ununterscheidbar von einer erfundenen Kennung. Das
 *   gilt auch fuer einen Systemadmin ohne Mitgliedschaft: Verwaltung ist kein Inhaltszugriff.
 * - Wer es sehen, die Aktion aber nicht ausfuehren darf, bekommt **403**.
 * - Eine Speicherung auf einer ueberholten Version bekommt **409** und ueberschreibt nichts.
 *
 * ## Gaeste
 *
 * Vier Endpunkte nehmen zusaetzlich zur internen Sitzung eine **Gastsession** an: Szene laden und
 * speichern, Bild abrufen und hochladen. Sie sind der Inhalt genau eines Boards - alles, was ein
 * Gastzugang je erreichen soll. Jede andere Boardroute verlangt weiterhin eine interne Sitzung und
 * antwortet einem Gast mit 401; eine Verwaltungsstrecke ist fuer ihn nicht vorhanden, nicht bloss verboten.
 * Innerhalb der vier Endpunkte entscheidet auch fuer ihn ausschliesslich `decideBoardAccess`.
 */

import { createHash } from 'node:crypto'

import type {
  BoardGrantChangeResponse,
  BoardGrantView,
  BoardGrantsResponse,
  BoardView,
  BoardsResponse,
  DashboardResponse,
  SceneResponse,
  SaveSceneResponse,
  SceneConflictResponse,
  UploadBoardAssetResponse,
  WorkspaceView,
} from '../contracts/api.js'
import {
  ASSET_FILE_ID_PARAM,
  ASSET_FILE_NAME_PARAM,
  BOARD_ASSETS_PATH,
  BOARD_FOLDER_PARAM,
  BOARD_FOLDER_PATH,
  BOARD_FOLDER_ROOT,
  BOARD_GRANT_ADD_PATH,
  BOARD_GRANT_REMOVE_PATH,
  BOARD_GRANT_ROLE_PATH,
  BOARD_GRANTS_PATH,
  BOARD_ID_PARAM,
  BOARD_OWNER_PATH,
  BOARD_QUERY_PARAM,
  BOARD_RENAME_PATH,
  BOARD_SCENE_PATH,
  BOARD_STATUS_PARAM,
  BOARD_STATUS_PATH,
  BOARD_WORKSPACE_PATH,
  BOARDS_PATH,
  BOARD_DASHBOARD_PATH,
  DASHBOARD_FILTER_PARAM,
  DASHBOARD_LIMIT,
  MAX_ASSET_FILE_ID_LENGTH,
  MAX_ASSET_FILE_NAME_LENGTH,
  WORKSPACE_ID_PARAM,
} from '../contracts/api.js'
import type { BinaryFileRef, SceneSnapshot, UnstorableReason } from '../contracts/scene.js'
import {
  createEmptySnapshot,
  findUnstorableValue,
  parseSceneSnapshot,
  serializeSceneSnapshot,
} from '../contracts/scene.js'
import type { BoardId, BoardStatus } from '../domain/board/model.js'
import {
  MAX_BOARD_TITLE_LENGTH,
  normalizeBoardTitle,
  parseBaseVersion,
  parseBoardGrantRole,
  parseBoardStatus,
  parseDashboardFilter,
} from '../domain/board/model.js'
import type { BoardAction } from '../domain/board/policy.js'
import type { BoardAccess, BoardAsset, BoardFilter, BoardGrantEntry, BoardStore } from '../domain/board/repositories.js'
import { BoardGrantConflictError, CorruptSceneError, SceneConflictError } from '../domain/board/repositories.js'
import type { FolderId } from '../domain/folder/model.js'
import type { AuthenticatedSession, UserId } from '../domain/identity/model.js'
import { buildAssetStorageKey } from '../domain/storage/asset-storage-port.js'
import { ALLOWED_IMAGE_TYPES, isAllowedImageType, sniffImageType } from '../domain/storage/image-type.js'
import type { Workspace, WorkspaceId, WorkspaceRole } from '../domain/workspace/model.js'
import type { MembershipTarget } from '../domain/workspace/repositories.js'
import { NOT_FOUND, createBoardGate, withoutBoard } from './board-access.js'
import { sceneResponseFor, toBoardView, toDashboardBoardView } from './board-views.js'
import type { AppContext } from './context.js'
import { requireCsrfToken, requireRequester, requireSession } from './guard.js'
import type { Route } from './http.js'
import { readBinaryBodyLimited, sendBytes, sendError } from './http.js'
import type { Reply } from './reply.js'
import { fail, guardBoardMutation, guardMutation, isReply, ok, readUuid, send } from './reply.js'
import type { Requester } from './requester.js'
import { asRequester, userOf, viewerOf } from './requester.js'

/** Laenger als jeder zulaessige Titel; alles darueber kann kein sinnvoller Filter sein. */
const MAX_FILTER_LENGTH = MAX_BOARD_TITLE_LENGTH

/**
 * Was die Anwendung nicht zuruecklesen kann, nimmt sie nicht an.
 *
 * Alle drei Faelle sind gueltiges JSON und kommen trotzdem nicht heil wieder: `1e400` wird beim Parsen zu
 * `Infinity` und beim Serialisieren zu `null`, NUL-Zeichen und einsame Surrogate kann `jsonb` nicht
 * speichern. Statt still zu veraendern oder beim Schreiben zu scheitern, wird der Grund benannt - die
 * Zeichnung bleibt dabei im Browser erhalten.
 */
const UNSTORABLE: Readonly<Record<UnstorableReason, string>> = {
  'nicht-endliche-zahl': 'Die Szene enthaelt eine nicht endliche Zahl, die sich nicht speichern laesst',
  'nul-zeichen': 'Die Szene enthaelt ein nicht speicherbares Zeichen (NUL)',
  'einsames-surrogat': 'Die Szene enthaelt ein nicht speicherbares Zeichen (einsames Surrogat)',
  'zu-tiefe-struktur': 'Die Szene ist zu tief verschachtelt, um sie zu speichern',
}

/**
 * Zulaessige Dateikennung.
 *
 * Sie kommt aus dem Editor und ist damit eine Eingabe von aussen. Erlaubt sind nur Zeichen, die weder in
 * einem Speicherschluessel noch in einer URI eine Sonderbedeutung haben - der abgeleitete Schluessel wird
 * dadurch nie zu einem Pfadwechsel. Der Schluessel selbst enthaelt sie ohnehin nicht: er entsteht aus
 * Boardkennung und Pruefsumme.
 */
const ASSET_FILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function normalizeAssetFileId(value: string | null): string | null {
  const candidate = value?.trim() ?? ''
  if (candidate.length === 0 || candidate.length > MAX_ASSET_FILE_ID_LENGTH || !ASSET_FILE_ID_PATTERN.test(candidate)) {
    return null
  }
  return candidate
}

/** Rein beschreibend. Steuerzeichen fliegen raus, damit der Name in keinem Protokoll etwas anrichten kann. */
function normalizeAssetFileName(value: string | null): string | null {
  let cleaned = ''
  for (const character of value ?? '') {
    const code = character.codePointAt(0) ?? 0
    if (code > 0x1f && code !== 0x7f) {
      cleaned += character
    }
  }
  const candidate = cleaned.trim().slice(0, MAX_ASSET_FILE_NAME_LENGTH)
  return candidate.length === 0 ? null : candidate
}

/** Der erste Teil des Content-Type-Kopfes, ohne Parameter wie `charset`. */
function declaredContentType(raw: string | undefined): string {
  return (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

function toFileRef(asset: BoardAsset): BinaryFileRef {
  return {
    id: asset.fileId,
    mimeType: asset.mimeType,
    created: asset.createdAt.getTime(),
    byteSize: asset.byteSize,
    storageKey: asset.storageKey,
  }
}

const FOLDER_NOT_FOUND = 'Ordner nicht gefunden'

/** Ein fremder und ein erfundener Arbeitsbereich sind fuer den Anfragenden dasselbe. */
const WORKSPACE_NOT_FOUND = 'Arbeitsbereich nicht gefunden'

/**
 * Ordnerfilter der Boardliste aus der Adresse.
 *
 * Drei Faelle und einer davon ungueltig: kein Parameter heisst **alle** Boards des Arbeitsbereichs,
 * `BOARD_FOLDER_ROOT` die Boards unmittelbar darin, eine Kennung genau diesen Ordner. `undefined` heisst:
 * kein gueltiger Wert - und wird wie ein unbekannter Ordner beantwortet.
 */
function readFolderFilter(raw: string | null): BoardFilter['folder'] | undefined {
  if (raw === null || raw === '') {
    return null
  }
  if (raw === BOARD_FOLDER_ROOT) {
    return { folderId: null }
  }
  const folderId = readUuid(raw)
  return folderId === null ? undefined : { folderId }
}

/**
 * Ordnerkennung aus dem Anfragekoerper. Ein fehlendes Feld und `null` bedeuten dasselbe - unmittelbar im
 * Arbeitsbereich -, alles andere muss eine gueltig geformte Kennung sein. `undefined` heisst: ungueltig.
 */
function readBoardFolderId(raw: unknown): FolderId | null | undefined {
  if (raw === null || raw === undefined) {
    return null
  }
  return readUuid(raw) ?? undefined
}

function toGrantView(grant: BoardGrantEntry): BoardGrantView {
  return {
    userId: grant.userId,
    displayName: grant.displayName,
    email: grant.email,
    role: grant.role,
    grantedAt: grant.createdAt.toISOString(),
  }
}

function toWorkspaceView(workspace: Workspace, role: WorkspaceRole | null): WorkspaceView {
  return {
    id: workspace.id,
    name: workspace.name,
    status: workspace.status,
    role,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  }
}

export function createBoardRoutes(context: AppContext): readonly Route[] {
  const { boards: store } = context
  // Laden, Sichtbarkeit und Uebersetzung der Ablehnung stehen an einer Stelle - dieselbe, die auch die
  // Routen der Freigabelinks benutzen.
  const { deny, loadVisibleBoard, withLockedBoard } = createBoardGate(context)

  /**
   * Zielnutzer einer Freigabe oder einer Uebertragung.
   *
   * Wird ausschliesslich **nach** der Berechtigungspruefung aufgerufen, sonst verriete die Antwort, welche
   * Nutzerkennungen es gibt. Status und Mitgliedschaft stammen aus derselben Transaktion wie der
   * Schreibvorgang; die Nutzerzeile ist dabei lesegesperrt. Eine Boardrolle ohne Mitgliedschaft im
   * Arbeitsbereich entsteht dadurch gar nicht erst - sie waere ohnehin wirkungslos, aber eben auch eine
   * Zeile, die etwas anderes behauptet.
   */
  async function requireGrantTarget(
    tx: BoardStore,
    access: BoardAccess,
    userId: UserId,
  ): Promise<{ readonly target: MembershipTarget } | Reply> {
    const target = await tx.workspaces.findUserForMembership(userId)
    if (target === null) {
      return fail(404, 'Unbekannter Nutzer')
    }
    if (target.status !== 'active') {
      return fail(400, 'Ein deaktivierter Nutzer kann weder eine Freigabe erhalten noch ein Board uebernehmen')
    }
    const membership = await tx.workspaces.findMembership(access.workspace.id, userId)
    if (membership === null) {
      return fail(400, 'Nur Mitglieder des Arbeitsbereichs koennen eine Boardrolle erhalten')
    }
    return { target }
  }

  /**
   * Gehoert der Zielordner zu diesem Arbeitsbereich? `null` heisst: ja - oder es ist gar keiner.
   *
   * Der zusammengesetzte Fremdschluessel wuerde eine Zuordnung ueber die Arbeitsbereichsgrenze ohnehin
   * verweigern; geprueft wird sie trotzdem hier, damit die Antwort eine benannte 404 ist und kein
   * Datenbankfehler - und damit ein fremder Ordner sich nicht von einem erfundenen unterscheiden laesst.
   */
  async function denyUnknownFolder(
    tx: BoardStore,
    workspaceId: WorkspaceId,
    folderId: FolderId | null,
  ): Promise<Reply | null> {
    if (folderId === null) {
      return null
    }
    const folder = await tx.folders.find(folderId)
    return folder !== null && folder.workspaceId === workspaceId ? null : fail(404, FOLDER_NOT_FOUND)
  }

  /** Nachweis einer Freigabeaenderung. Traegt Rollen und Bezuege, nie Boardinhalt. */
  async function recordGrantEvent(
    tx: BoardStore,
    auth: AuthenticatedSession,
    access: BoardAccess,
    action: string,
    userId: UserId,
    details: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<void> {
    await tx.audit.record({
      actorId: auth.user.id,
      action,
      targetType: 'board-grant',
      targetId: userId,
      workspaceId: access.workspace.id,
      details: { boardId: access.board.id, ...details },
    })
  }

  /**
   * Boardsicht nach einer Aenderung, die die eigene Rolle beruehren kann.
   *
   * Der Datensatz wird dafuer noch einmal ueber **denselben** Weg geladen wie ueberall sonst; die Zeile ist
   * in dieser Transaktion ohnehin gesperrt. Die Alternative waere, die neuen Rollen in der Route aus den
   * alten herzuleiten - und genau diese zweite Fassung soll es nicht geben.
   */
  async function reloadedBoardView(tx: BoardStore, requester: Requester, boardId: BoardId): Promise<BoardView> {
    const access = await tx.boards.findForUpdate(boardId, viewerOf(requester), context.now())
    if (access === null) {
      throw new Error('Board nach der Aenderung nicht mehr auffindbar')
    }
    return toBoardView(requester, access)
  }

  return [
    {
      method: 'GET',
      path: BOARDS_PATH,
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
        // Ohne Board entscheidet allein die Mitgliedschaft im Workspace; ein Systemadmin ohne Rolle bekommt
        // hier dieselbe 404 wie fuer eine erfundene Kennung.
        const denial = deny(asRequester(auth), access.workspace, withoutBoard(access.role), 'board:read')
        if (denial !== null) {
          send(response, denial)
          return
        }
        const status: BoardStatus = parseBoardStatus(url.searchParams.get(BOARD_STATUS_PARAM)) ?? 'active'
        const title = (url.searchParams.get(BOARD_QUERY_PARAM) ?? '').trim().slice(0, MAX_FILTER_LENGTH)
        const folder = readFolderFilter(url.searchParams.get(BOARD_FOLDER_PARAM))
        if (folder === undefined) {
          // Eine erfundene Ordnerkennung ist kein leerer Ordner, sondern keiner: dieselbe 404 wie fuer
          // einen fremden. Ein Ordnername verraet damit auch hier nichts.
          sendError(response, 404, FOLDER_NOT_FOUND)
          return
        }
        const found = await store.boards.listForWorkspace(workspaceId, auth.user.id, { status, title, folder })
        const requester = asRequester(auth)
        const body: BoardsResponse = {
          workspace: toWorkspaceView(access.workspace, access.role),
          // Jede Zeile traegt die Rollen desselben Ladevorgangs: die Mitgliedschaft aus dem Arbeitsbereich
          // und die eigene Boardrolle aus der Freigabezeile dieses Boards.
          boards: found.map((entry) =>
            toBoardView(requester, {
              board: entry.board,
              workspace: access.workspace,
              role: access.role,
              boardRole: entry.boardRole,
              guestRole: null,
              ownerDisplayName: entry.ownerDisplayName,
            }),
          ),
        }
        send(response, ok(200, body))
      },
    },

    /**
     * Arbeitsbereichsuebergreifende Boardliste des Dashboards.
     *
     * Die Berechtigung steht doppelt und an beiden richtigen Stellen: die Abfrage liefert ausschliesslich
     * Boards aus Arbeitsbereichen mit eigener Mitgliedschaft, und jede Zeile geht danach durch dieselbe
     * Policy wie ein einzeln geoeffnetes Board (`toBoardView` verlangt `board:read`). Ein Filter waehlt aus
     * dieser Menge aus und kann sie nicht erweitern.
     *
     * `requireSession` statt `requireRequester`: ein Gast kennt genau ein Board und hat kein Dashboard.
     */
    {
      method: 'GET',
      path: BOARD_DASHBOARD_PATH,
      handle: async ({ request, response, url }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        const kind = parseDashboardFilter(url.searchParams.get(DASHBOARD_FILTER_PARAM))
        const title = (url.searchParams.get(BOARD_QUERY_PARAM) ?? '').trim().slice(0, MAX_FILTER_LENGTH)
        const entries = await store.boards.listForDashboard(
          auth.user.id,
          { kind, title, limit: DASHBOARD_LIMIT },
          context.now(),
        )
        const requester = asRequester(auth)
        const body: DashboardResponse = {
          boards: entries.map((entry) =>
            toDashboardBoardView(
              requester,
              {
                board: entry.board,
                workspace: entry.workspace,
                role: entry.role,
                boardRole: entry.boardRole,
                guestRole: null,
                ownerDisplayName: entry.ownerDisplayName,
              },
              {
                workspaceName: entry.workspace.name,
                sharedInternally: entry.sharedInternally,
                sharedExternally: entry.sharedExternally,
              },
            ),
          ),
        }
        send(response, ok(200, body))
      },
    },

    {
      method: 'POST',
      path: BOARDS_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const workspaceId = readUuid(guarded.body['workspaceId'])
        const title = normalizeBoardTitle(guarded.body['title'])
        const folderId = readBoardFolderId(guarded.body['folderId'])
        if (workspaceId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        if (title === null) {
          sendError(response, 400, `Ein Titel mit 1 bis ${String(MAX_BOARD_TITLE_LENGTH)} Zeichen wird erwartet`)
          return
        }
        if (folderId === undefined) {
          sendError(response, 404, FOLDER_NOT_FOUND)
          return
        }
        const reply = await store.transaction(async (tx) => {
          // Die Workspacezeile wird gesperrt: eine gleichzeitige Archivierung des Workspace kann kein Board
          // mehr hinter sich anlegen lassen.
          const access = await tx.workspaces.findForUpdate(workspaceId, guarded.auth.user.id)
          if (access === null) {
            return fail(404, NOT_FOUND.message)
          }
          const denial = deny(asRequester(guarded.auth), access.workspace, withoutBoard(access.role), 'board:create')
          if (denial !== null) {
            return denial
          }
          const unbekannt = await denyUnknownFolder(tx, workspaceId, folderId)
          if (unbekannt !== null) {
            return unbekannt
          }
          // Der Ersteller wird Board-Owner.
          const board = await tx.boards.create(workspaceId, title, guarded.auth.user.id, folderId)
          await tx.audit.record({
            actorId: guarded.auth.user.id,
            action: 'board.created',
            targetType: 'board',
            targetId: board.id,
            workspaceId,
            details: { title: board.title, folderId },
          })
          // Frisch geladen statt aus der Anlage zusammengesetzt: die Rolle des Erstellers auf seinem neuen
          // Board entsteht damit auf demselben Weg wie jede andere.
          return ok(201, await reloadedBoardView(tx, asRequester(guarded.auth), board.id))
        })
        send(response, reply)
      },
    },

    {
      method: 'POST',
      path: BOARD_RENAME_PATH,
      handle: async ({ request, response }) => {
        await withLockedBoard(request, response, async (tx, auth, access, body) => {
          const title = normalizeBoardTitle(body['title'])
          if (title === null) {
            return fail(400, `Ein Titel mit 1 bis ${String(MAX_BOARD_TITLE_LENGTH)} Zeichen wird erwartet`)
          }
          const denial = deny(asRequester(auth), access.workspace, access, 'board:rename')
          if (denial !== null) {
            return denial
          }
          const renamed = await tx.boards.rename(access.board.id, title)
          await tx.audit.record({
            actorId: auth.user.id,
            action: 'board.renamed',
            targetType: 'board',
            targetId: renamed.id,
            workspaceId: renamed.workspaceId,
            details: { previousTitle: access.board.title, title: renamed.title },
          })
          return ok(200, toBoardView(asRequester(auth), { ...access, board: renamed }))
        })
      },
    },

    /**
     * Ordnerablage des Boards.
     *
     * Sie folgt der **Boardrolle** (`board:move`) und nicht der Workspacerolle: wer den Titel aendern darf,
     * darf das Board auch ablegen. Der Ordner selbst wird dabei nicht angefasst - seine Verwaltung ist eine
     * eigene Strecke mit eigener Berechtigung.
     */
    {
      method: 'POST',
      path: BOARD_FOLDER_PATH,
      handle: async ({ request, response }) => {
        await withLockedBoard(request, response, async (tx, auth, access, body) => {
          const folderId = readBoardFolderId(body['folderId'])
          if (folderId === undefined) {
            return fail(404, FOLDER_NOT_FOUND)
          }
          const denial = deny(asRequester(auth), access.workspace, access, 'board:move')
          if (denial !== null) {
            return denial
          }
          const unbekannt = await denyUnknownFolder(tx, access.workspace.id, folderId)
          if (unbekannt !== null) {
            return unbekannt
          }
          const moved = await tx.boards.setFolder(access.board.id, folderId)
          await tx.audit.record({
            actorId: auth.user.id,
            action: 'board.moved',
            targetType: 'board',
            targetId: moved.id,
            workspaceId: moved.workspaceId,
            details: { previousFolderId: access.board.folderId, folderId },
          })
          return ok(200, toBoardView(asRequester(auth), { ...access, board: moved }))
        })
      },
    },

    /**
     * Wechsel des Arbeitsbereichs.
     *
     * Eine andere Stufe als die Ordnerablage und deshalb ein eigener Endpunkt: das Board verlaesst seinen
     * bisherigen Arbeitsbereich, und fuer alle, die es dort sahen, ist das dasselbe wie ein Loeschen. Geprueft
     * wird deshalb **beidseitig** - `board:move-workspace` in der Quelle und `board:create` im Ziel, jeweils
     * gegen die dortige Mitgliedschaft. Ein Wechsel kann damit niemandem einen Zugang verschaffen, den der
     * Handelnde im Ziel nicht selbst haette.
     *
     * **Freigaben und Gastlinks bleiben nicht stillschweigend erhalten.** Interne Freigaben werden entzogen,
     * gueltige Gastlinks widerrufen: eine Freigabe gilt einem Mitglied des bisherigen Arbeitsbereichs, ein
     * Gastlink einem Empfaenger, der ein Board in genau diesem Arbeitsbereich bekommen hat. Beides in einen
     * anderen weiterzutragen waere eine Zugriffsentscheidung, die niemand getroffen hat. Die **Ownerschaft**
     * bleibt dagegen stehen - sie ist die Verantwortung fuer das Board und keine Freigabe; ohne Mitgliedschaft
     * im Ziel traegt sie ihrem Inhaber dort ohnehin nichts ein.
     */
    {
      method: 'POST',
      path: BOARD_WORKSPACE_PATH,
      handle: async ({ request, response }) => {
        const moved: { id: BoardId | null } = { id: null }
        await withLockedBoard(request, response, async (tx, auth, access, body) => {
          const targetId = readUuid(body['workspaceId'])
          const folderId = readBoardFolderId(body['folderId'])
          if (targetId === null) {
            return fail(404, WORKSPACE_NOT_FOUND)
          }
          if (folderId === undefined) {
            return fail(404, FOLDER_NOT_FOUND)
          }
          const denial = deny(asRequester(auth), access.workspace, access, 'board:move-workspace')
          if (denial !== null) {
            return denial
          }
          if (targetId === access.workspace.id) {
            // Derselbe Arbeitsbereich ist die Ordnerablage und nicht dieser Weg. Ein stiller Erfolg wuerde
            // hier zusaetzlich Freigaben und Gastlinks entziehen, ohne dass etwas gewechselt haette.
            return fail(400, 'Das Board liegt bereits in diesem Arbeitsbereich')
          }
          // Die Zielzeile wird gesperrt: eine gleichzeitige Archivierung nimmt kein Board mehr auf.
          const target = await tx.workspaces.findForUpdate(targetId, auth.user.id)
          if (target === null) {
            return fail(404, WORKSPACE_NOT_FOUND)
          }
          const targetDenial = deny(
            asRequester(auth),
            target.workspace,
            withoutBoard(target.role),
            'board:create',
          )
          if (targetDenial !== null) {
            return targetDenial
          }
          const unbekannt = await denyUnknownFolder(tx, targetId, folderId)
          if (unbekannt !== null) {
            return unbekannt
          }
          const removedGrants = await tx.grants.removeAllForBoard(access.board.id)
          const revokedLinks = await tx.shareLinks.revokeAllForBoard(access.board.id, context.now())
          const board = await tx.boards.setWorkspace(access.board.id, targetId, folderId)
          const details = {
            title: board.title,
            previousWorkspaceId: access.workspace.id,
            workspaceId: targetId,
            folderId,
            removedGrants,
            revokedShareLinks: revokedLinks.length,
          }
          // Zwei Nachweise, einer je Arbeitsbereich: das Protokoll der Quelle soll den Abgang zeigen und
          // nicht nur eine Luecke, das des Ziels den Zugang.
          await tx.audit.record({
            actorId: auth.user.id,
            action: 'board.workspace-left',
            targetType: 'board',
            targetId: board.id,
            workspaceId: access.workspace.id,
            details,
          })
          await tx.audit.record({
            actorId: auth.user.id,
            action: 'board.workspace-changed',
            targetType: 'board',
            targetId: board.id,
            workspaceId: targetId,
            details,
          })
          context.logger('info', 'board.workspace.changed', {
            userId: auth.user.id,
            boardId: board.id,
            previousWorkspaceId: access.workspace.id,
            workspaceId: targetId,
          })
          moved.id = board.id
          // Die eigene Rolle kann sich mit dem Arbeitsbereich aendern; die neue Sicht kommt deshalb aus
          // einem frischen Ladevorgang.
          return ok(200, await reloadedBoardView(tx, asRequester(auth), board.id))
        })
        if (moved.id !== null) {
          // Erst nach dem Commit: wer im Ziel nichts mehr darf und jeder Gast eines widerrufenen Links
          // verliert seine Verbindung sofort statt beim naechsten Takt der Nachpruefung.
          context.rooms.closeBoard(moved.id)
        }
      },
    },

    {
      method: 'POST',
      path: BOARD_STATUS_PATH,
      handle: async ({ request, response }) => {
        await withLockedBoard(request, response, async (tx, auth, access, body) => {
          const status = parseBoardStatus(body['status'])
          if (status === null) {
            return fail(400, 'status muss active oder archived sein')
          }
          const action: BoardAction = status === 'archived' ? 'board:archive' : 'board:unarchive'
          const denial = deny(asRequester(auth), access.workspace, access, action)
          if (denial !== null) {
            return denial
          }
          const updated = await tx.boards.setStatus(access.board.id, status)
          await tx.audit.record({
            actorId: auth.user.id,
            action: status === 'archived' ? 'board.archived' : 'board.unarchived',
            targetType: 'board',
            targetId: updated.id,
            workspaceId: updated.workspaceId,
            details: { status },
          })
          return ok(200, toBoardView(asRequester(auth), { ...access, board: updated }))
        })
      },
    },

    {
      method: 'GET',
      path: BOARD_SCENE_PATH,
      handle: async ({ request, response, url }) => {
        // Auch fuer einen Gast: sein Zugang ist genau dieses eine Board.
        const requester = await requireRequester(context, request, response)
        if (requester === null) {
          return
        }
        const boardId = readUuid(url.searchParams.get(BOARD_ID_PARAM))
        if (boardId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        const access = await loadVisibleBoard(store, requester, boardId, { lock: false })
        if (isReply(access)) {
          send(response, access)
          return
        }
        let latest
        try {
          latest = await store.scenes.findLatest(boardId)
        } catch (error) {
          if (!(error instanceof CorruptSceneError)) {
            throw error
          }
          // Ein beschaedigter Stand wird gemeldet, nie als leeres Board geoeffnet - sonst wuerde die naechste
          // Speicherung die Zeichnung endgueltig ueberschreiben.
          context.logger('error', 'board.scene.corrupt', { boardId, version: error.version })
          send(response, fail(500, 'Die gespeicherte Szene ist beschaedigt und kann nicht geoeffnet werden'))
          return
        }
        const body: SceneResponse = sceneResponseFor(
          requester,
          access,
          latest?.version ?? 0,
          // Version 0 heisst: noch nie gespeichert. Der leere Ausgangsstand ist kein Ersatz fuer einen
          // fehlgeschlagenen Ladevorgang, sondern der tatsaechliche Inhalt eines neuen Boards.
          latest?.snapshot ?? createEmptySnapshot(boardId, access.board.createdAt.getTime()),
        )
        send(response, ok(200, body))
      },
    },

    {
      method: 'POST',
      path: BOARD_SCENE_PATH,
      handle: async ({ request, response }) => {
        // Auch fuer einen Gast; ob er speichern darf, entscheidet `scene:write` in der Policy.
        const guarded = await guardBoardMutation(context, request, response, context.config.maxSceneBytes)
        if (guarded === null) {
          return
        }
        const boardId = readUuid(guarded.body['boardId'])
        if (boardId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        const baseVersion = parseBaseVersion(guarded.body['baseVersion'])
        if (baseVersion === null) {
          sendError(response, 400, 'baseVersion muss eine nicht negative ganze Zahl sein')
          return
        }
        const scene: SceneSnapshot | null = parseSceneSnapshot(guarded.body['scene'])
        if (scene === null || scene.boardId !== boardId) {
          sendError(response, 400, 'Die Szene entspricht nicht dem erwarteten Format')
          return
        }
        // Vor dem Serialisieren: `JSON.stringify` selbst scheitert an zu tiefer Verschachtelung, und ein
        // unbenannter Serverfehler waere genau das, was diese Pruefung verhindern soll. Geprueft wird der
        // geparste Snapshot, nicht der Anfragekoerper - also genau das, was gespeichert wuerde,
        // einschliesslich der unbekannten Zusatzfelder, die der Vertrag unveraendert durchreicht.
        const unstorable = findUnstorableValue(scene)
        if (unstorable !== null) {
          sendError(response, 400, UNSTORABLE[unstorable])
          return
        }
        const serialized = serializeSceneSnapshot(scene)
        if (Buffer.byteLength(serialized) > context.config.maxSceneBytes) {
          sendError(response, 413, 'Die Szene ist zu gross')
          return
        }

        const reply = await store.transaction(async (tx) => {
          const access = await loadVisibleBoard(tx, guarded.requester, boardId, { lock: true })
          if (isReply(access)) {
            return access
          }
          const denial = deny(guarded.requester, access.workspace, access, 'scene:write')
          if (denial !== null) {
            return denial
          }
          // Optimistische Versionspruefung hinter der Zeilensperre: die zweite gleichzeitige Speicherung
          // sieht den bereits erhoehten Stand und ueberschreibt nichts.
          if (access.board.sceneVersion !== baseVersion) {
            const conflict: SceneConflictResponse = {
              error: 'Die Szene wurde inzwischen geaendert. Bitte neu laden.',
              currentVersion: access.board.sceneVersion,
            }
            return ok(409, conflict)
          }
          const version = baseVersion + 1
          let saved
          try {
            // Ein Gast ist kein Nutzer und steht deshalb nicht in der Autorenspalte; die Version selbst
            // entsteht ueber genau denselben Weg wie jede andere.
            saved = await tx.scenes.append(boardId, version, scene, userOf(guarded.requester)?.id ?? null)
          } catch (error) {
            if (!(error instanceof SceneConflictError)) {
              throw error
            }
            const conflict: SceneConflictResponse = {
              error: 'Die Szene wurde inzwischen geaendert. Bitte neu laden.',
              currentVersion: version,
            }
            return ok(409, conflict)
          }
          await tx.boards.setSceneVersion(boardId, version)
          await tx.scenes.prune(boardId, context.config.sceneVersionRetention)
          const body: SaveSceneResponse = { version, savedAt: saved.createdAt.toISOString() }
          return ok(200, body)
        })
        send(response, reply)
      },
    },

    /* ------------------------------------------------------------------------------------------------ */
    /* Interne Freigaben                                                                                 */
    /* ------------------------------------------------------------------------------------------------ */

    /**
     * Freigabeliste eines Boards.
     *
     * Sichtbar fuer jeden, der das Board sehen darf - genau wie die Mitgliederliste eines Arbeitsbereichs.
     * Wer eine Rolle einer Freigabe traegt, ist ohnehin Mitglied desselben Arbeitsbereichs; die Liste
     * verraet also niemanden, den der Fragende nicht schon kennt.
     */
    {
      method: 'GET',
      path: BOARD_GRANTS_PATH,
      handle: async ({ request, response, url }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        const boardId = readUuid(url.searchParams.get(BOARD_ID_PARAM))
        if (boardId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        const access = await loadVisibleBoard(store, asRequester(auth), boardId, { lock: false })
        if (isReply(access)) {
          send(response, access)
          return
        }
        const grants = await store.grants.listForBoard(boardId)
        const body: BoardGrantsResponse = {
          board: toBoardView(asRequester(auth), access),
          grants: grants.map(toGrantView),
        }
        send(response, ok(200, body))
      },
    },

    /**
     * Board an einen vorhandenen internen Nutzer freigeben.
     *
     * Der Zielnutzer wird erst **nach** der Berechtigungspruefung gelesen, sonst verriete die Antwort,
     * welche Nutzerkennungen es gibt. Sein Status und seine Mitgliedschaft kommen aus derselben
     * Transaktion, in der geschrieben wird: eine gleichzeitige Deaktivierung oder ein gleichzeitiger
     * Mitgliedschaftsentzug hinterlaesst so keine Freigabe auf einem ueberholten Stand.
     */
    {
      method: 'POST',
      path: BOARD_GRANT_ADD_PATH,
      handle: async ({ request, response }) => {
        await withLockedBoard(request, response, async (tx, auth, access, body) => {
          const userId = readUuid(body['userId'])
          const role = parseBoardGrantRole(body['role'])
          if (userId === null || role === null) {
            return fail(400, 'userId und eine gueltige Rolle (editor oder viewer) werden erwartet')
          }
          const denial = deny(asRequester(auth), access.workspace, access, 'grant:manage')
          if (denial !== null) {
            return denial
          }
          if (userId === access.board.ownerId) {
            // Der Owner traegt seine Rolle in `boards.owner_user_id`. Eine Freigabezeile daneben waere
            // wirkungslos und beim naechsten Ownerwechsel eine stille Herabstufung.
            return fail(409, 'Der Board-Owner braucht keine Freigabe')
          }
          const found = await requireGrantTarget(tx, access, userId)
          if (isReply(found)) {
            return found
          }
          let added
          try {
            added = await tx.grants.add(access.board.id, access.workspace.id, userId, role)
          } catch (error) {
            if (!(error instanceof BoardGrantConflictError)) {
              throw error
            }
            return fail(409, 'Fuer diesen Nutzer besteht bereits eine Freigabe')
          }
          await recordGrantEvent(tx, auth, access, 'board-grant.added', userId, { role: added.role })
          const created: BoardGrantChangeResponse = { userId, role: added.role }
          return ok(201, created)
        })
      },
    },

    {
      method: 'POST',
      path: BOARD_GRANT_ROLE_PATH,
      handle: async ({ request, response }) => {
        await withLockedBoard(request, response, async (tx, auth, access, body) => {
          const userId = readUuid(body['userId'])
          const nextRole = parseBoardGrantRole(body['role'])
          if (userId === null || nextRole === null) {
            return fail(400, 'userId und eine gueltige Rolle (editor oder viewer) werden erwartet')
          }
          const denial = deny(asRequester(auth), access.workspace, access, 'grant:manage')
          if (denial !== null) {
            return denial
          }
          const grant = await tx.grants.find(access.board.id, userId)
          if (grant === null) {
            return fail(404, 'Freigabe nicht gefunden')
          }
          if (grant.role === nextRole) {
            const unchanged: BoardGrantChangeResponse = { userId, role: nextRole }
            return ok(200, unchanged)
          }
          const updated = await tx.grants.setRole(access.board.id, userId, nextRole)
          await recordGrantEvent(tx, auth, access, 'board-grant.role-changed', userId, {
            previousRole: grant.role,
            role: updated.role,
          })
          const changed: BoardGrantChangeResponse = { userId, role: updated.role }
          return ok(200, changed)
        })
      },
    },

    /**
     * Freigabe entziehen.
     *
     * Danach gilt fuer diesen Nutzer wieder seine Workspace-Mitgliedschaft - eine Freigabe ist eine
     * Verfeinerung und kein zweites Tor. Die Ownerschaft laesst sich so **nicht** abgeben: ein Board ohne
     * Owner soll es nie geben, deshalb gibt es dafuer nur die Uebertragung.
     */
    {
      method: 'POST',
      path: BOARD_GRANT_REMOVE_PATH,
      handle: async ({ request, response }) => {
        await withLockedBoard(request, response, async (tx, auth, access, body) => {
          const userId = readUuid(body['userId'])
          if (userId === null) {
            return fail(400, 'userId wird erwartet')
          }
          const denial = deny(asRequester(auth), access.workspace, access, 'grant:manage')
          if (denial !== null) {
            return denial
          }
          if (userId === access.board.ownerId) {
            return fail(409, 'Die Ownerschaft kann nicht entzogen werden. Uebertrage sie stattdessen.')
          }
          const grant = await tx.grants.find(access.board.id, userId)
          if (grant === null) {
            return fail(404, 'Freigabe nicht gefunden')
          }
          await tx.grants.remove(access.board.id, userId)
          await recordGrantEvent(tx, auth, access, 'board-grant.removed', userId, { previousRole: grant.role })
          context.logger('info', 'board.grant.removed', {
            actorId: auth.user.id,
            userId,
            boardId: access.board.id,
          })
          const removed: BoardGrantChangeResponse = { userId, role: null }
          return ok(200, removed)
        })
      },
    },

    /**
     * Ownerschaft uebertragen.
     *
     * Genau ein Owner, jederzeit: `boards.owner_user_id` wird unter der Zeilensperre ersetzt, nicht
     * ergaenzt. Zwei gleichzeitige Uebertragungen sind dadurch serialisiert, und der bisherige Owner faellt
     * im selben Schritt auf seine Mitgliedschaft zurueck. Eine Freigabezeile des neuen Owners waere von
     * diesem Moment an wirkungslos und beim naechsten Wechsel eine stille Ueberraschung - sie faellt weg.
     */
    {
      method: 'POST',
      path: BOARD_OWNER_PATH,
      handle: async ({ request, response }) => {
        await withLockedBoard(request, response, async (tx, auth, access, body) => {
          const userId = readUuid(body['userId'])
          if (userId === null) {
            return fail(400, 'userId wird erwartet')
          }
          const denial = deny(asRequester(auth), access.workspace, access, 'board:transfer-ownership')
          if (denial !== null) {
            return denial
          }
          if (userId === access.board.ownerId) {
            return ok(200, toBoardView(asRequester(auth), access))
          }
          const found = await requireGrantTarget(tx, access, userId)
          if (isReply(found)) {
            return found
          }
          await tx.grants.remove(access.board.id, userId)
          const updated = await tx.boards.setOwner(access.board.id, userId)
          await tx.audit.record({
            actorId: auth.user.id,
            action: 'board.ownership-transferred',
            targetType: 'board',
            targetId: updated.id,
            workspaceId: updated.workspaceId,
            details: { previousOwnerId: access.board.ownerId, ownerId: userId },
          })
          context.logger('info', 'board.ownership.transferred', {
            actorId: auth.user.id,
            boardId: updated.id,
            ownerId: userId,
          })
          // Die Uebertragung aendert die eigene Rolle: der bisherige Owner faellt auf seine Mitgliedschaft
          // zurueck. Die neue Sicht kommt deshalb aus einem frischen Ladevorgang.
          return ok(200, await reloadedBoardView(tx, asRequester(auth), updated.id))
        })
      },
    },

    /**
     * Upload einer Bilddatei.
     *
     * Die Bytes stehen roh im Anfragekoerper, Board, Dateikennung und Dateiname in der Abfragezeichenfolge.
     * Geprueft wird in dieser Reihenfolge: Sitzung, CSRF-Token, Koerpergroesse, tatsaechlicher Inhalt,
     * Berechtigung. Der behauptete Content-Type entscheidet nichts - er muss mit den erkannten Signaturbytes
     * uebereinstimmen, sonst ist die Datei nicht das, was sie zu sein vorgibt.
     *
     * **Nichts Halbes:** Die Bytes gehen erst in den Speicher, wenn die Berechtigung feststeht und kein
     * Datensatz dagegen spricht; der Metadatensatz entsteht in derselben Transaktion. Scheitert sie oder ihr
     * Commit, werden die eben geschriebenen Bytes wieder entfernt.
     */
    {
      method: 'POST',
      path: BOARD_ASSETS_PATH,
      handle: async ({ request, response, url }) => {
        const requester = await requireRequester(context, request, response)
        if (requester === null) {
          return
        }
        if (!requireCsrfToken(context, request, response, requester)) {
          return
        }
        const body = await readBinaryBodyLimited(request, context.config.storage.maxAssetBytes)
        if (!body.ok) {
          if (body.reason === 'too-large') {
            sendError(response, 413, 'Das Bild ist zu gross')
          } else if (body.reason === 'aborted') {
            // Nichts wurde gespeichert. Der Client soll den vollstaendigen Transfer wiederholen.
            sendError(response, 400, 'Der Transfer wurde abgebrochen')
          } else {
            sendError(response, 400, 'Es wurden keine Bilddaten gesendet')
          }
          return
        }
        const boardId = readUuid(url.searchParams.get(BOARD_ID_PARAM))
        if (boardId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        const fileId = normalizeAssetFileId(url.searchParams.get(ASSET_FILE_ID_PARAM))
        if (fileId === null) {
          sendError(response, 400, 'Es wird eine gueltige Dateikennung erwartet')
          return
        }
        const declared = declaredContentType(request.headers['content-type'])
        const detected = sniffImageType(body.bytes)
        // Zwei getrennte Gruende, eine Antwort: der behauptete Typ ist nicht erlaubt, oder der Inhalt ist ein
        // anderer als behauptet. Eine PNG-Endung mit ausfuehrbarem Inhalt scheitert am zweiten Fall.
        if (!isAllowedImageType(declared) || detected === null || detected !== declared) {
          sendError(response, 415, `Erlaubt sind ausschliesslich Bilder dieser Typen: ${ALLOWED_IMAGE_TYPES.join(', ')}`)
          return
        }
        const checksum = createHash('sha256').update(body.bytes).digest('hex')
        const storageKey = buildAssetStorageKey(boardId, fileId, checksum)
        const fileName = normalizeAssetFileName(url.searchParams.get(ASSET_FILE_NAME_PARAM))

        let written = false
        try {
          const reply = await store.transaction(async (tx) => {
            const access = await loadVisibleBoard(tx, requester, boardId, { lock: true })
            if (isReply(access)) {
              return access
            }
            // Ein Bild ist Inhalt des Boards: es darf hochladen, wer die Szene speichern darf. Damit gilt in
            // einem archivierten Board oder Arbeitsbereich dieselbe Unveraenderlichkeit wie fuer die Szene,
            // und ein `guest-viewer` laedt so wenig hoch, wie er speichert.
            const denial = deny(requester, access.workspace, access, 'scene:write')
            if (denial !== null) {
              return denial
            }
            const existing = await tx.assets.findByFileId(boardId, fileId)
            if (existing !== null) {
              if (existing.checksumSha256 !== checksum) {
                return fail(409, 'Zu dieser Dateikennung ist bereits ein anderer Inhalt gespeichert')
              }
              // Derselbe Inhalt unter derselben Kennung: der Upload ist bereits geschehen. Kein zweiter
              // Schreibvorgang, kein zweiter Datensatz, dieselbe Antwort.
              const unchanged: UploadBoardAssetResponse = { file: toFileRef(existing) }
              return ok(200, unchanged)
            }
            await context.storage.put(storageKey, body.bytes)
            written = true
            const recorded = await tx.assets.record({
              boardId,
              workspaceId: access.workspace.id,
              fileId,
              fileName,
              mimeType: detected,
              byteSize: body.bytes.byteLength,
              checksumSha256: checksum,
              storageKey,
            })
            const created: UploadBoardAssetResponse = { file: toFileRef(recorded) }
            return ok(201, created)
          })
          send(response, reply)
        } catch (error) {
          if (written) {
            // **Kein Loeschen als Kompensation.** Ein Schluessel gehoert zwar genau dieser Datei in diesem
            // Board, aber ein gleichzeitiger zweiter Versuch derselben Datei meint dieselben Bytes; eine
            // Loeschung koennte sie unter seinem Datensatz wegziehen. Der Schluessel ist inhaltsadressiert,
            // deshalb schreibt ein Wiederholungsversuch genau ihn erneut und es waechst kein Muell.
            // qatlas-dev: verwaiste Bytes bleiben liegen und werden benannt; ein Aufraeumlauf braucht
            // dieselbe gesonderte Entscheidung wie das Hard Delete.
            context.logger('error', 'board.asset.orphan', { boardId, storageKey, cause: String(error) })
          }
          throw error
        }
      },
    },

    /**
     * Abruf der Bytes.
     *
     * **Kein oeffentlicher und kein vorsignierter Weg.** Jeder Abruf laeuft ueber dieselbe Sitzung und
     * dieselbe Entscheidung wie das Oeffnen des Boards; eine geratene Kennung sieht aus wie eine fremde. Wer
     * die Berechtigung verliert, verliert damit im selben Augenblick auch den Zugriff auf die Bilder.
     */
    {
      method: 'GET',
      path: BOARD_ASSETS_PATH,
      handle: async ({ request, response, url }) => {
        const requester = await requireRequester(context, request, response)
        if (requester === null) {
          return
        }
        const boardId = readUuid(url.searchParams.get(BOARD_ID_PARAM))
        if (boardId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        // Der Abruf haengt an derselben Entscheidung wie das Oeffnen des Boards: ein Gast erreicht damit die
        // Bilder **seines** Boards und die keines anderen.
        const access = await loadVisibleBoard(store, requester, boardId, { lock: false })
        if (isReply(access)) {
          send(response, access)
          return
        }
        const fileId = normalizeAssetFileId(url.searchParams.get(ASSET_FILE_ID_PARAM))
        const asset = fileId === null ? null : await store.assets.findByFileId(boardId, fileId)
        if (asset === null) {
          sendError(response, 404, 'Bild nicht gefunden')
          return
        }
        const bytes = await context.storage.get(asset.storageKey)
        if (bytes === null) {
          // Der Metadatensatz sagt, dass es die Bytes gibt. Fehlen sie, ist der Speicher beschaedigt - das
          // wird gemeldet und nicht als "nicht vorhanden" verkleidet.
          context.logger('error', 'board.asset.missing', { boardId, assetId: asset.id })
          sendError(response, 500, 'Das Bild fehlt im Speicher und kann nicht ausgeliefert werden')
          return
        }
        sendBytes(response, bytes, {
          // Der gespeicherte Typ, nie der beim Upload behauptete: er wurde aus dem Inhalt gewonnen.
          contentType: asset.mimeType,
          // Berechtigungsabhaengiger Inhalt gehoert in keinen Zwischenspeicher - auch nicht in einen
          // privaten. qatlas-dev: bewusst kein ETag; erst messen, wenn wiederholtes Laden stoert.
          cacheControl: 'private, no-store',
        })
      },
    },
  ]
}
