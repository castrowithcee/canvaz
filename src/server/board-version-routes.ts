/**
 * Versionsverlauf, Vorschau, Wiederherstellung, Export und Import.
 *
 * Dieselbe Bauweise wie die uebrigen Boardrouten: Datensatz samt aller Rollen laden, **ein** Aufruf von
 * `decideBoardAccess` ueber `createBoardGate`, Uebersetzung der Ablehnung. Es gibt hier keinen
 * Rollenvergleich und keine zweite Entscheidungsstelle.
 *
 * ## Ausschliesslich interne Sitzungen
 *
 * Alle fuenf Endpunkte verlangen eine interne Sitzung; ein Gast bekommt **401** und damit dieselbe Antwort
 * wie ueberall sonst ausserhalb der vier Inhaltsendpunkte. Historie, Wiederherstellung und der Export eines
 * ganzen Boards samt aller Bilder in eine Datei sind Verwaltung des Boards und nicht der Inhalt der
 * Zeichenflaeche, den ein Freigabelink oeffnet. Die Gastgrenze bleibt damit unveraendert bei genau vier
 * Endpunkten.
 *
 * ## Wiederherstellen loescht nichts
 *
 * Eine Wiederherstellung schreibt eine **neue** Version mit dem Inhalt der alten. Die Historie bleibt
 * vollstaendig, und der Weg zurueck ist derselbe Weg noch einmal. Damit der wiederhergestellte Stand auch
 * bei einem Client ankommt, der den bisherigen noch im Browser haelt, hebt `supersedeSnapshot` die
 * Elementversionen an - sonst machte der naechste Abgleich die Wiederherstellung still rueckgaengig.
 *
 * ## Ein Restore ueberschreibt keinen unerkannt neueren Stand
 *
 * Wie jede Speicherung nennt der Aufruf die Version, die der Anfragende gesehen hat. Weicht sie ab, kommt
 * **409** mit der aktuellen Version zurueck und es wird nichts geschrieben. Erst ein zweiter Aufruf mit
 * dieser Version ist die ausdrueckliche Bestaetigung.
 */

import { createHash } from 'node:crypto'

import type {
  BoardSceneVersionView,
  BoardVersionSceneResponse,
  BoardVersionsResponse,
  ImportBoardSceneResponse,
  RestoreBoardVersionResponse,
  SceneConflictResponse,
} from '../contracts/api.js'
import {
  BOARD_EXPORT_PATH,
  BOARD_ID_PARAM,
  BOARD_IMPORT_PATH,
  BOARD_VERSION_PARAM,
  BOARD_VERSION_RESTORE_PATH,
  BOARD_VERSION_SCENE_PATH,
  BOARD_VERSIONS_PATH,
} from '../contracts/api.js'
import type { BinaryFileRef, SceneSnapshot } from '../contracts/scene.js'
import {
  SCENE_SCHEMA_VERSION,
  createEmptySnapshot,
  findUnstorableValue,
  serializeSceneSnapshot,
} from '../contracts/scene.js'
import type { ExcalidrawFile, ExcalidrawImportProblem, ParsedExcalidrawFile } from '../domain/board/excalidraw-file.js'
import { parseExcalidrawFile, toExcalidrawFile } from '../domain/board/excalidraw-file.js'
import { parseBaseVersion } from '../domain/board/model.js'
import { effectiveBoardRole, mayRestoreBoard } from '../domain/board/policy.js'
import { visibleElements } from '../domain/board/reconcile.js'
import type { BoardAccess, BoardStore, SceneVersionSummary } from '../domain/board/repositories.js'
import { CorruptSceneError, SceneConflictError } from '../domain/board/repositories.js'
import { supersedeSnapshot } from '../domain/board/versioning.js'
import type { AuthenticatedSession, UserId } from '../domain/identity/model.js'
import { buildAssetStorageKey } from '../domain/storage/asset-storage-port.js'
import { isAllowedImageType, sniffImageType } from '../domain/storage/image-type.js'
import { NOT_FOUND, createBoardGate } from './board-access.js'
import { toBoardView } from './board-views.js'
import type { AppContext } from './context.js'
import { requireSession } from './guard.js'
import type { Route } from './http.js'
import { sendError } from './http.js'
import type { Reply } from './reply.js'
import { fail, guardMutation, isReply, ok, readUuid, send } from './reply.js'
import { asRequester, boardSubject } from './requester.js'

/** Jede Ablehnung einer Importdatei bekommt einen Satz, der sagt, was an ihr nicht stimmt. */
const IMPORT_PROBLEMS: Readonly<Record<ExcalidrawImportProblem, string>> = {
  'kein-excalidraw': 'Die Datei ist keine Excalidraw-Datei',
  'unbekannte-formatversion': 'Die Datei hat eine Formatversion, die diese Instanz nicht liest',
  'ungueltige-elemente': 'Die Zeichenelemente der Datei entsprechen nicht dem erwarteten Format',
  'ungueltiger-appstate': 'Die Ansichtsangaben der Datei entsprechen nicht dem erwarteten Format',
  'ungueltige-datei': 'Ein eingebettetes Bild der Datei entspricht nicht dem erwarteten Format',
  'externe-assetreferenz':
    'Die Datei verweist auf ein Bild ausserhalb der Datei. Nur eingebettete Bilder werden uebernommen',
  'gefaehrlicher-link': 'Die Datei enthaelt einen Verweis mit ausfuehrbarem Inhalt',
  'zu-viele-dateien': 'Die Datei enthaelt mehr Bilder, als ein Import uebernimmt',
}

/**
 * Zulaessige Dateikennung eines eingebetteten Bildes.
 *
 * Dieselbe Form wie beim Upload: der abgeleitete Speicherschluessel darf nie zu einem Pfadwechsel werden.
 * Eine Importdatei kommt von aussen und ist keine bessere Quelle als eine Abfragezeichenfolge.
 */
const IMPORT_FILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_IMPORT_FILE_ID_LENGTH = 255

function toVersionView(summary: SceneVersionSummary): BoardSceneVersionView {
  return {
    version: summary.version,
    authorDisplayName: summary.authorDisplayName,
    createdAt: summary.createdAt.toISOString(),
    elementCount: summary.elementCount,
    byteSize: summary.byteSize,
  }
}

function toFileRef(asset: {
  readonly fileId: string
  readonly mimeType: string
  readonly createdAt: Date
  readonly byteSize: number
  readonly storageKey: string
}): BinaryFileRef {
  return {
    id: asset.fileId,
    mimeType: asset.mimeType,
    created: asset.createdAt.getTime(),
    byteSize: asset.byteSize,
    storageKey: asset.storageKey,
  }
}

/**
 * Ergebnis einer ersetzenden Transaktion: die fertige Antwort und - nur bei Erfolg - der neue Stand.
 *
 * Beides zusammen, weil der Boardraum **nach** dem Commit benachrichtigt werden muss und die Antwort erst
 * danach hinausgeht. Eine Variable ausserhalb der Transaktion waere dasselbe in unklarer Form.
 */
type SupersedeOutcome = {
  readonly reply: Reply
  /** `null` heisst: es wurde nichts geschrieben - Ablehnung, Konflikt oder ein fehlender Stand. */
  readonly applied: { readonly version: number; readonly snapshot: SceneSnapshot } | null
}

/** Eine ganze Zahl aus der Abfragezeichenfolge; `null` heisst: keine gueltige Versionsnummer. */
function readVersion(raw: string | null): number | null {
  const value = Number(raw ?? '')
  return raw !== null && raw.trim() !== '' && Number.isInteger(value) && value >= 1 ? value : null
}

export function createBoardVersionRoutes(context: AppContext): readonly Route[] {
  const { boards: store } = context
  const { deny, loadVisibleBoard } = createBoardGate(context)

  /** Darf der Anfragende auf diesem Board wiederherstellen? Dieselbe Policy, die auch der Endpunkt befragt. */
  function mayRestore(access: BoardAccess, auth: AuthenticatedSession): boolean {
    const requester = asRequester(auth)
    const effective = effectiveBoardRole(boardSubject(requester, access), access.workspace, access.board)
    return effective !== null && mayRestoreBoard(effective, access.role)
  }

  /**
   * Aktueller Stand eines Boards. Ein noch nie gespeichertes Board hat Version `0` und den leeren
   * Ausgangsstand - das ist sein tatsaechlicher Inhalt und kein Ersatz fuer einen Fehler.
   */
  async function currentSnapshot(tx: BoardStore, access: BoardAccess): Promise<SceneSnapshot | null> {
    const latest = await tx.scenes.findLatest(access.board.id)
    return latest?.snapshot ?? null
  }

  /**
   * Schreibt einen ersetzenden Stand als neue Version.
   *
   * Der gemeinsame Rumpf von Wiederherstellung und Import: beide setzen den Inhalt eines Boards auf etwas,
   * das nicht aus der laufenden Bearbeitung stammt, und beide muessen dabei denselben drei Dingen genuegen -
   * speicherbar sein, in die Groessengrenze passen und den Raum nicht auf dem alten Stand zuruecklassen.
   */
  async function appendSuperseding(
    tx: BoardStore,
    access: BoardAccess,
    next: SceneSnapshot,
    authorId: UserId | null,
  ): Promise<{ readonly version: number; readonly savedAt: Date; readonly snapshot: SceneSnapshot } | Reply> {
    const boardId = access.board.id
    const current = await currentSnapshot(tx, access)
    const snapshot = supersedeSnapshot(current, next, boardId, context.now().getTime())
    if (findUnstorableValue(snapshot) !== null) {
      return fail(400, 'Der Stand enthaelt Werte, die sich nicht speichern lassen')
    }
    if (Buffer.byteLength(serializeSceneSnapshot(snapshot)) > context.config.maxSceneBytes) {
      return fail(413, 'Der wiederherzustellende Stand ist zu gross fuer dieses Board')
    }
    const version = access.board.sceneVersion + 1
    let saved
    try {
      saved = await tx.scenes.append(boardId, version, snapshot, authorId)
    } catch (error) {
      if (!(error instanceof SceneConflictError)) {
        throw error
      }
      const conflict: SceneConflictResponse = {
        error: 'Der Stand wurde inzwischen geaendert. Bitte neu laden.',
        currentVersion: version,
      }
      return ok(409, conflict)
    }
    await tx.boards.setSceneVersion(boardId, version)
    await tx.scenes.prune(boardId, context.config.sceneVersionRetention)
    return { version, savedAt: saved.createdAt, snapshot }
  }

  /** Uebernimmt die Bilder einer Importdatei. Gibt die Verweise zurueck, mit denen die Szene sie fuehrt. */
  async function importFiles(
    tx: BoardStore,
    access: BoardAccess,
    parsed: ParsedExcalidrawFile,
    written: string[],
  ): Promise<Record<string, BinaryFileRef> | Reply> {
    const files: Record<string, BinaryFileRef> = {}
    for (const file of parsed.files) {
      if (file.id.length > MAX_IMPORT_FILE_ID_LENGTH || !IMPORT_FILE_ID_PATTERN.test(file.id)) {
        return fail(400, 'Ein eingebettetes Bild traegt eine unzulaessige Dateikennung')
      }
      const bytes = Buffer.from(file.base64, 'base64')
      if (bytes.byteLength === 0 || bytes.byteLength > context.config.storage.maxAssetBytes) {
        return fail(413, 'Ein eingebettetes Bild der Datei ist zu gross')
      }
      // Was der Client behauptet, zaehlt auch hier nicht: entschieden wird ueber die Signaturbytes, und der
      // in der Data-URL genannte Typ muss dazu passen.
      const detected = sniffImageType(bytes)
      if (!isAllowedImageType(file.mimeType) || detected === null || detected !== file.mimeType) {
        return fail(415, 'Ein eingebettetes Bild der Datei hat kein erlaubtes Bildformat')
      }
      const checksum = createHash('sha256').update(bytes).digest('hex')
      const existing = await tx.assets.findByFileId(access.board.id, file.id)
      if (existing !== null) {
        if (existing.checksumSha256 !== checksum) {
          // Dieselbe Entscheidung wie beim Upload: eine Kennung meint genau einen Inhalt. Sie hier
          // stillschweigend neu zu vergeben hiesse, die Elemente der Importdatei umzuschreiben.
          return fail(409, 'Zu einer Dateikennung der Importdatei liegt in diesem Board bereits ein anderer Inhalt')
        }
        files[file.id] = toFileRef(existing)
        continue
      }
      const storageKey = buildAssetStorageKey(access.board.id, file.id, checksum)
      await context.storage.put(storageKey, bytes)
      written.push(storageKey)
      const recorded = await tx.assets.record({
        boardId: access.board.id,
        workspaceId: access.workspace.id,
        fileId: file.id,
        fileName: null,
        mimeType: detected,
        byteSize: bytes.byteLength,
        checksumSha256: checksum,
        storageKey,
      })
      files[file.id] = toFileRef(recorded)
    }
    return files
  }

  return [
    /**
     * Versionshistorie eines Boards.
     *
     * Sichtbar fuer jeden, der das Board sehen darf - genau wie die Freigabeliste. Wer die Historie sieht,
     * sieht damit noch keinen Inhalt: dafuer gibt es die Vorschau, und die prueft erneut.
     */
    {
      method: 'GET',
      path: BOARD_VERSIONS_PATH,
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
        const versions = await store.scenes.listVersions(boardId, context.config.sceneVersionRetention)
        const body: BoardVersionsResponse = {
          board: toBoardView(asRequester(auth), access),
          versions: versions.map(toVersionView),
          retention: context.config.sceneVersionRetention,
          mayRestore: mayRestore(access, auth),
        }
        send(response, ok(200, body))
      },
    },

    /**
     * Read-only-Vorschau genau einer Version.
     *
     * Sie **ist** read-only, weil sie nichts anderes tut als lesen: kein Beitritt in den Boardraum, keine
     * Ausgangsversion fuer eine Speicherung, kein Weg, aus dieser Antwort einen Schreibvorgang zu machen.
     * Wer den Stand uebernehmen will, stellt ihn ausdruecklich wieder her.
     */
    {
      method: 'GET',
      path: BOARD_VERSION_SCENE_PATH,
      handle: async ({ request, response, url }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        const boardId = readUuid(url.searchParams.get(BOARD_ID_PARAM))
        const version = readVersion(url.searchParams.get(BOARD_VERSION_PARAM))
        if (boardId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        if (version === null) {
          sendError(response, 400, 'Es wird eine Versionsnummer ab 1 erwartet')
          return
        }
        const access = await loadVisibleBoard(store, asRequester(auth), boardId, { lock: false })
        if (isReply(access)) {
          send(response, access)
          return
        }
        let found
        try {
          found = await store.scenes.find(boardId, version)
        } catch (error) {
          if (!(error instanceof CorruptSceneError)) {
            throw error
          }
          context.logger('error', 'board.scene.corrupt', { boardId, version })
          send(response, fail(500, 'Diese Version ist beschaedigt und kann nicht angezeigt werden'))
          return
        }
        if (found === null) {
          // Nie gespeichert oder von der Aufbewahrungsgrenze entfernt - fuer den Anfragenden dasselbe.
          sendError(response, 404, 'Diese Version wird nicht mehr aufbewahrt')
          return
        }
        const body: BoardVersionSceneResponse = {
          board: toBoardView(asRequester(auth), access),
          version: found.version,
          scene: found.snapshot,
        }
        send(response, ok(200, body))
      },
    },

    /**
     * Wiederherstellung als neue Version.
     *
     * Nichts wird geloescht und nichts ueberschrieben: der alte Inhalt entsteht als naechste Version, und
     * der bisherige Stand bleibt als Version daneben stehen. Der Weg zurueck ist derselbe Weg noch einmal.
     */
    {
      method: 'POST',
      path: BOARD_VERSION_RESTORE_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const { auth, body } = guarded
        const boardId = readUuid(body['boardId'])
        if (boardId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        const version = parseBaseVersion(body['version'])
        const baseVersion = parseBaseVersion(body['baseVersion'])
        if (version === null || version < 1 || baseVersion === null) {
          sendError(response, 400, 'version und baseVersion muessen ganze Zahlen sein')
          return
        }

        const outcome = await store.transaction(async (tx): Promise<SupersedeOutcome> => {
          const access = await loadVisibleBoard(tx, asRequester(auth), boardId, { lock: true })
          if (isReply(access)) {
            return { reply: access, applied: null }
          }
          const denial = deny(asRequester(auth), access.workspace, access, 'scene:restore')
          if (denial !== null) {
            return { reply: denial, applied: null }
          }
          // Der Konfliktschutz sitzt **vor** jedem Schreibvorgang: wer einen neueren Stand nicht gesehen
          // hat, darf ihn nicht unbemerkt verdraengen. Ein zweiter Aufruf mit dieser Version bestaetigt.
          if (access.board.sceneVersion !== baseVersion) {
            const conflict: SceneConflictResponse = {
              error: 'Dieses Board wurde inzwischen gespeichert. Bitte die Versionsliste neu laden.',
              currentVersion: access.board.sceneVersion,
            }
            return { reply: ok(409, conflict), applied: null }
          }
          let target
          try {
            target = await tx.scenes.find(boardId, version)
          } catch (error) {
            if (!(error instanceof CorruptSceneError)) {
              throw error
            }
            const broken = fail(500, 'Diese Version ist beschaedigt und kann nicht wiederhergestellt werden')
            return { reply: broken, applied: null }
          }
          if (target === null) {
            return { reply: fail(404, 'Diese Version wird nicht mehr aufbewahrt'), applied: null }
          }
          const written = await appendSuperseding(tx, access, target.snapshot, auth.user.id)
          if (isReply(written)) {
            return { reply: written, applied: null }
          }
          await tx.audit.record({
            actorId: auth.user.id,
            action: 'board.scene-restored',
            targetType: 'board',
            targetId: boardId,
            workspaceId: access.workspace.id,
            details: { restoredFrom: version, version: written.version, previousVersion: baseVersion },
          })
          const created: RestoreBoardVersionResponse = {
            version: written.version,
            restoredFrom: version,
            savedAt: written.savedAt.toISOString(),
          }
          return {
            reply: ok(200, created),
            applied: { version: written.version, snapshot: written.snapshot },
          }
        })
        // Erst nach dem Commit: ein Raum, der einen zurueckgerollten Stand uebernommen haette, waere die
        // eine Stelle, an der die Datenbank und die Bildschirme auseinanderlaufen.
        if (outcome.applied !== null) {
          context.rooms.restored(boardId, outcome.applied.version, outcome.applied.snapshot)
        }
        send(response, outcome.reply)
      },
    },

    /**
     * Export als `.excalidraw`-Datei.
     *
     * Die Bilder gehen als eingebettete `data:`-URL mit; damit ist ein Board genau eine Datei und laesst
     * sich in jeder anderen Excalidraw-Installation oeffnen. Ein Bild, dessen Bytes fehlen, wird benannt im
     * Protokoll und bleibt aus der Datei heraus - ein leerer Verweis waere schlechter als sein Fehlen.
     */
    {
      method: 'GET',
      path: BOARD_EXPORT_PATH,
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
        let latest
        try {
          latest = await store.scenes.findLatest(boardId)
        } catch (error) {
          if (!(error instanceof CorruptSceneError)) {
            throw error
          }
          context.logger('error', 'board.scene.corrupt', { boardId, version: error.version })
          send(response, fail(500, 'Die gespeicherte Szene ist beschaedigt und kann nicht exportiert werden'))
          return
        }
        const snapshot = latest?.snapshot ?? createEmptySnapshot(boardId, access.board.createdAt.getTime())
        const dataUrls = new Map<string, string>()
        for (const file of Object.values(snapshot.files)) {
          const asset = await store.assets.findByFileId(boardId, file.id)
          const bytes = asset === null ? null : await context.storage.get(asset.storageKey)
          if (asset === null || bytes === null) {
            context.logger('warn', 'board.export.asset.missing', { boardId, fileId: file.id })
            continue
          }
          dataUrls.set(file.id, `data:${asset.mimeType};base64,${Buffer.from(bytes).toString('base64')}`)
        }
        const exported: ExcalidrawFile = toExcalidrawFile(
          visibleElements([...snapshot.elements]),
          snapshot.appState,
          Object.values(snapshot.files),
          dataUrls,
        )
        send(response, ok(200, exported))
      },
    },

    /**
     * Import einer `.excalidraw`-Datei als neuer Stand.
     *
     * Reihenfolge: Sitzung, CSRF-Token, Koerpergroesse, Schema, Berechtigung, Konfliktschutz, erst danach
     * Bytes und Datensaetze. Die Datei ist bis dahin nichts als eine gepruefte Struktur im Speicher.
     */
    {
      method: 'POST',
      path: BOARD_IMPORT_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response, context.config.maxImportBytes)
        if (guarded === null) {
          return
        }
        const { auth, body } = guarded
        const boardId = readUuid(body['boardId'])
        if (boardId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        const baseVersion = parseBaseVersion(body['baseVersion'])
        if (baseVersion === null) {
          sendError(response, 400, 'baseVersion muss eine nicht negative ganze Zahl sein')
          return
        }
        const parsed = parseExcalidrawFile(body['file'])
        if (!parsed.ok) {
          sendError(response, 400, IMPORT_PROBLEMS[parsed.problem])
          return
        }

        const written: string[] = []
        try {
          const outcome = await store.transaction(async (tx): Promise<SupersedeOutcome> => {
            const access = await loadVisibleBoard(tx, asRequester(auth), boardId, { lock: true })
            if (isReply(access)) {
              return { reply: access, applied: null }
            }
            const denial = deny(asRequester(auth), access.workspace, access, 'scene:write')
            if (denial !== null) {
              return { reply: denial, applied: null }
            }
            if (access.board.sceneVersion !== baseVersion) {
              const conflict: SceneConflictResponse = {
                error: 'Dieses Board wurde inzwischen gespeichert. Bitte neu laden.',
                currentVersion: access.board.sceneVersion,
              }
              return { reply: ok(409, conflict), applied: null }
            }
            const files = await importFiles(tx, access, parsed.file, written)
            if (isReply(files)) {
              return { reply: files, applied: null }
            }
            const current = await currentSnapshot(tx, access)
            const next: SceneSnapshot = {
              schemaVersion: SCENE_SCHEMA_VERSION,
              boardId,
              elements: parsed.file.elements,
              appState: {
                viewBackgroundColor: parsed.file.viewBackgroundColor,
                gridSize: parsed.file.gridSize,
                gridModeEnabled: parsed.file.gridModeEnabled,
                // Das Dateiformat fuehrt keinen Szenennamen; der Boardtitel ist die Wahrheit darueber.
                name: current?.appState.name ?? access.board.title,
              },
              files,
              updatedAt: context.now().getTime(),
            }
            const saved = await appendSuperseding(tx, access, next, auth.user.id)
            if (isReply(saved)) {
              return { reply: saved, applied: null }
            }
            await tx.audit.record({
              actorId: auth.user.id,
              action: 'board.scene-imported',
              targetType: 'board',
              targetId: boardId,
              workspaceId: access.workspace.id,
              details: {
                version: saved.version,
                elements: parsed.file.elements.length,
                files: parsed.file.files.length,
              },
            })
            const created: ImportBoardSceneResponse = {
              version: saved.version,
              savedAt: saved.savedAt.toISOString(),
              importedElements: parsed.file.elements.length,
              importedFiles: parsed.file.files.length,
            }
            return {
              reply: ok(201, created),
              applied: { version: saved.version, snapshot: saved.snapshot },
            }
          })
          if (outcome.applied !== null) {
            context.rooms.restored(boardId, outcome.applied.version, outcome.applied.snapshot)
          }
          send(response, outcome.reply)
        } catch (error) {
          // Dieselbe Entscheidung wie beim Upload: **keine** Kompensationsloeschung. Der Schluessel ist
          // inhaltsadressiert, ein Wiederholungsversuch schreibt genau ihn erneut, und eine Loeschung
          // koennte Bytes erwischen, die ein gleichzeitiger zweiter Vorgang gerade braucht.
          for (const storageKey of written) {
            context.logger('error', 'board.asset.orphan', { boardId, storageKey, cause: String(error) })
          }
          throw error
        }
      },
    },
  ]
}

