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
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  BoardSceneResponse,
  BoardView,
  BoardsResponse,
  SaveSceneResponse,
  SceneConflictResponse,
  UploadBoardAssetResponse,
  WorkspaceView,
} from '../contracts/api.js'
import {
  ASSET_FILE_ID_PARAM,
  ASSET_FILE_NAME_PARAM,
  BOARD_ASSETS_PATH,
  BOARD_ID_PARAM,
  BOARD_QUERY_PARAM,
  BOARD_RENAME_PATH,
  BOARD_SCENE_PATH,
  BOARD_STATUS_PARAM,
  BOARD_STATUS_PATH,
  BOARDS_PATH,
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
import type { Board, BoardId, BoardStatus } from '../domain/board/model.js'
import {
  MAX_BOARD_TITLE_LENGTH,
  SCENE_VERSION_RETENTION,
  normalizeBoardTitle,
  parseBaseVersion,
  parseBoardStatus,
} from '../domain/board/model.js'
import type { BoardAction, BoardDenialReason } from '../domain/board/policy.js'
import { decideBoardAccess } from '../domain/board/policy.js'
import type { BoardAccess, BoardAsset, BoardStore } from '../domain/board/repositories.js'
import { CorruptSceneError, SceneConflictError } from '../domain/board/repositories.js'
import type { AuthenticatedSession } from '../domain/identity/model.js'
import { buildAssetStorageKey } from '../domain/storage/asset-storage-port.js'
import { ALLOWED_IMAGE_TYPES, isAllowedImageType, sniffImageType } from '../domain/storage/image-type.js'
import type { Workspace, WorkspaceRole } from '../domain/workspace/model.js'
import type { PolicySubject } from '../domain/workspace/policy.js'
import type { AppContext } from './context.js'
import { requireCsrfToken, requireSession } from './guard.js'
import type { Route } from './http.js'
import { readBinaryBodyLimited, sendBytes, sendError } from './http.js'
import type { Reply } from './reply.js'
import { fail, guardMutation, isReply, ok, readUuid, send } from './reply.js'

/** Laenger als jeder zulaessige Titel; alles darueber kann kein sinnvoller Filter sein. */
const MAX_FILTER_LENGTH = MAX_BOARD_TITLE_LENGTH

const DENIALS: Readonly<Record<BoardDenialReason, { readonly status: number; readonly message: string }>> = {
  'not-visible': { status: 404, message: 'Board nicht gefunden' },
  'user-deactivated': { status: 404, message: 'Board nicht gefunden' },
  'insufficient-role': { status: 403, message: 'Keine Berechtigung fuer diese Aktion' },
  'workspace-archived': { status: 403, message: 'Der Arbeitsbereich ist archiviert und kann nicht geaendert werden' },
  'board-archived': { status: 403, message: 'Das Board ist archiviert und kann nicht geaendert werden' },
}

const NOT_FOUND = DENIALS['not-visible']

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

function toBoardView(board: Board, ownerDisplayName: string): BoardView {
  return {
    id: board.id,
    workspaceId: board.workspaceId,
    title: board.title,
    status: board.status,
    ownerUserId: board.ownerId,
    ownerDisplayName,
    sceneVersion: board.sceneVersion,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
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

  function subjectOf(auth: AuthenticatedSession, role: WorkspaceRole | null): PolicySubject {
    return { user: auth.user, workspaceRole: role }
  }

  /**
   * Einziger Weg zu einer Entscheidung. `null` heisst erlaubt; sonst steht die Ablehnung als fertige Antwort
   * bereit, und der Aufrufer beendet sich.
   */
  function deny(
    auth: AuthenticatedSession,
    workspace: Workspace,
    role: WorkspaceRole | null,
    board: Board | null,
    action: BoardAction,
  ): Reply | null {
    const decision = decideBoardAccess(subjectOf(auth, role), workspace, board, action)
    if (decision.allowed) {
      return null
    }
    const { status, message } = DENIALS[decision.reason]
    context.logger('warn', 'authorization.denied', {
      userId: auth.user.id,
      workspaceId: workspace.id,
      ...(board === null ? {} : { boardId: board.id }),
      action,
      reason: decision.reason,
    })
    return fail(status, message)
  }

  /**
   * Laedt das Board samt Workspace und eigener Rolle und setzt die Sichtbarkeit durch. Eine unbekannte und
   * eine nicht sichtbare Kennung ergeben dieselbe 404.
   */
  async function loadVisibleBoard(
    tx: BoardStore,
    auth: AuthenticatedSession,
    boardId: BoardId,
    options: { readonly lock: boolean },
  ): Promise<BoardAccess | Reply> {
    const access = options.lock
      ? await tx.boards.findForUpdate(boardId, auth.user.id)
      : await tx.boards.findForUser(boardId, auth.user.id)
    if (access === null) {
      return fail(404, NOT_FOUND.message)
    }
    return deny(auth, access.workspace, access.role, access.board, 'board:read') ?? access
  }

  /** Gemeinsamer Einstieg der zustandsaendernden Boardrouten: Sitzung, CSRF, Kennung, Sperre, Sichtbarkeit. */
  async function withLockedBoard(
    request: IncomingMessage,
    response: ServerResponse,
    run: (
      tx: BoardStore,
      auth: AuthenticatedSession,
      access: BoardAccess,
      body: Record<string, unknown>,
    ) => Promise<Reply>,
  ): Promise<void> {
    const guarded = await guardMutation(context, request, response)
    if (guarded === null) {
      return
    }
    const boardId = readUuid(guarded.body['boardId'])
    if (boardId === null) {
      sendError(response, 404, NOT_FOUND.message)
      return
    }
    const reply = await store.transaction(async (tx) => {
      const access = await loadVisibleBoard(tx, guarded.auth, boardId, { lock: true })
      if (isReply(access)) {
        return access
      }
      return run(tx, guarded.auth, access, guarded.body)
    })
    send(response, reply)
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
        const denial = deny(auth, access.workspace, access.role, null, 'board:read')
        if (denial !== null) {
          send(response, denial)
          return
        }
        const status: BoardStatus = parseBoardStatus(url.searchParams.get(BOARD_STATUS_PARAM)) ?? 'active'
        const title = (url.searchParams.get(BOARD_QUERY_PARAM) ?? '').trim().slice(0, MAX_FILTER_LENGTH)
        const found = await store.boards.listForWorkspace(workspaceId, { status, title })
        const body: BoardsResponse = {
          workspace: toWorkspaceView(access.workspace, access.role),
          boards: found.map((entry) => toBoardView(entry.board, entry.ownerDisplayName)),
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
        if (workspaceId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        if (title === null) {
          sendError(response, 400, `Ein Titel mit 1 bis ${String(MAX_BOARD_TITLE_LENGTH)} Zeichen wird erwartet`)
          return
        }
        const reply = await store.transaction(async (tx) => {
          // Die Workspacezeile wird gesperrt: eine gleichzeitige Archivierung des Workspace kann kein Board
          // mehr hinter sich anlegen lassen.
          const access = await tx.workspaces.findForUpdate(workspaceId, guarded.auth.user.id)
          if (access === null) {
            return fail(404, NOT_FOUND.message)
          }
          const denial = deny(guarded.auth, access.workspace, access.role, null, 'board:create')
          if (denial !== null) {
            return denial
          }
          // Der Ersteller wird Board-Owner.
          const board = await tx.boards.create(workspaceId, title, guarded.auth.user.id)
          await tx.audit.record({
            actorId: guarded.auth.user.id,
            action: 'board.created',
            targetType: 'board',
            targetId: board.id,
            workspaceId,
            details: { title: board.title },
          })
          return ok(201, toBoardView(board, guarded.auth.user.displayName))
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
          const denial = deny(auth, access.workspace, access.role, access.board, 'board:rename')
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
          return ok(200, toBoardView(renamed, access.ownerDisplayName))
        })
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
          const denial = deny(auth, access.workspace, access.role, access.board, action)
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
          return ok(200, toBoardView(updated, access.ownerDisplayName))
        })
      },
    },

    {
      method: 'GET',
      path: BOARD_SCENE_PATH,
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
        const access = await loadVisibleBoard(store, auth, boardId, { lock: false })
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
        const body: BoardSceneResponse = {
          board: toBoardView(access.board, access.ownerDisplayName),
          version: latest?.version ?? 0,
          // Version 0 heisst: noch nie gespeichert. Der leere Ausgangsstand ist kein Ersatz fuer einen
          // fehlgeschlagenen Ladevorgang, sondern der tatsaechliche Inhalt eines neuen Boards.
          scene: latest?.snapshot ?? createEmptySnapshot(boardId, access.board.createdAt.getTime()),
        }
        send(response, ok(200, body))
      },
    },

    {
      method: 'POST',
      path: BOARD_SCENE_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response, context.config.maxSceneBytes)
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
          const access = await loadVisibleBoard(tx, guarded.auth, boardId, { lock: true })
          if (isReply(access)) {
            return access
          }
          const denial = deny(guarded.auth, access.workspace, access.role, access.board, 'scene:write')
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
            saved = await tx.scenes.append(boardId, version, scene, guarded.auth.user.id)
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
          await tx.scenes.prune(boardId, SCENE_VERSION_RETENTION)
          const body: SaveSceneResponse = { version, savedAt: saved.createdAt.toISOString() }
          return ok(200, body)
        })
        send(response, reply)
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
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        if (!requireCsrfToken(context, request, response, auth)) {
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
            const access = await loadVisibleBoard(tx, auth, boardId, { lock: true })
            if (isReply(access)) {
              return access
            }
            // Ein Bild ist Inhalt des Boards: es darf hochladen, wer die Szene speichern darf. Damit gilt in
            // einem archivierten Board oder Arbeitsbereich dieselbe Unveraenderlichkeit wie fuer die Szene.
            const denial = deny(auth, access.workspace, access.role, access.board, 'scene:write')
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
            // callbell-dev: verwaiste Bytes bleiben liegen und werden benannt; ein Aufraeumlauf braucht
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
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        const boardId = readUuid(url.searchParams.get(BOARD_ID_PARAM))
        if (boardId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        const access = await loadVisibleBoard(store, auth, boardId, { lock: false })
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
          // privaten. callbell-dev: bewusst kein ETag; erst messen, wenn wiederholtes Laden stoert.
          cacheControl: 'private, no-store',
        })
      },
    },
  ]
}
