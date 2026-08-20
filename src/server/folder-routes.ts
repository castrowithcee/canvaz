/**
 * Ordner eines Arbeitsbereichs.
 *
 * Dieselbe Bauweise wie die Workspacerouten: kein Rollenvergleich in der Route, sondern das Laden des
 * Datensatzes samt eigener Rolle, ein Aufruf von `decideWorkspaceAccess` und die Uebersetzung der
 * Ablehnung. Ordner sind **Struktur des Arbeitsbereichs** und folgen deshalb der Workspacerolle und nie
 * einer Boardrolle: gelesen wird der Baum mit `workspace:read`, geformt mit `folder:manage`.
 *
 * Ein Ordner traegt keine Rechte. Er aendert weder, wer ein Board sehen darf, noch, was jemand ueber die
 * Existenz eines Boards erfaehrt - der Baum nennt ausschliesslich Ordner und nie ihren Inhalt.
 *
 * ## Die Sperre und die Invarianten
 *
 * Jede Aenderung laeuft in einer Transaktion, die die **Workspacezeile** sperrt, und liest danach den
 * vollstaendigen Ordnerbestand. Erst auf diesem frischen Stand entscheidet `checkFolderPlacement`. Ohne die
 * Sperre koennten zwei gleichzeitige Verschiebungen gemeinsam einen Ring bauen, den jede fuer sich nicht
 * sieht; die Datenbank kann einen Zyklus nicht selbst ausschliessen.
 *
 * ## Entfernen eines nicht leeren Ordners
 *
 * Ein Ordner wird **aufgeloest, nicht ausgeraeumt**: seine Unterordner und Boards ruecken an seinen Platz.
 * Ein Ordner ist Gliederung und kein Behaelter mit eigenem Lebenszyklus - sein Entfernen darf deshalb
 * nichts loeschen, nichts archivieren und nichts unsichtbar machen. Ein rekursives Loeschen waere
 * Datenverlust hinter einem Verwaltungsklick, und eine Verweigerung nicht leerer Ordner zwaenge zum
 * Ausraeumen von Hand, ohne dass irgendjemand dadurch etwas gewaenne.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { FoldersResponse, FolderView, RemoveFolderResponse, WorkspaceView } from '../contracts/api.js'
import {
  FOLDER_MOVE_PATH,
  FOLDER_REMOVE_PATH,
  FOLDER_RENAME_PATH,
  FOLDERS_PATH,
  WORKSPACE_ID_PARAM,
} from '../contracts/api.js'
import type { Folder, FolderId, FolderViolation } from '../domain/folder/model.js'
import { MAX_FOLDER_DEPTH, MAX_FOLDER_NAME_LENGTH, checkFolderPlacement, normalizeFolderName } from '../domain/folder/model.js'
import type { AuthenticatedSession } from '../domain/identity/model.js'
import type { Workspace, WorkspaceAccess, WorkspaceId, WorkspaceRole } from '../domain/workspace/model.js'
import type { DenialReason, WorkspaceAction } from '../domain/workspace/policy.js'
import { decideWorkspaceAccess } from '../domain/workspace/policy.js'
import type { WorkspaceStore } from '../domain/workspace/repositories.js'
import type { AppContext } from './context.js'
import { requireSession } from './guard.js'
import type { Route } from './http.js'
import { sendError } from './http.js'
import type { Reply } from './reply.js'
import { fail, guardMutation, isReply, ok, readUuid, send } from './reply.js'

/**
 * Uebersetzung der Ablehnungsgruende. Die Wortwahl bleibt die des Arbeitsbereichs: eine nicht sichtbare
 * Kennung darf nicht daran erkennbar sein, dass die Meldung ploetzlich von Ordnern spricht.
 */
const DENIALS: Readonly<Record<DenialReason, { readonly status: number; readonly message: string }>> = {
  'not-visible': { status: 404, message: 'Arbeitsbereich nicht gefunden' },
  'user-deactivated': { status: 404, message: 'Arbeitsbereich nicht gefunden' },
  'insufficient-role': { status: 403, message: 'Keine Berechtigung fuer diese Aktion' },
  'workspace-archived': { status: 403, message: 'Der Arbeitsbereich ist archiviert und kann nicht geaendert werden' },
}

const FOLDER_NOT_FOUND = 'Ordner nicht gefunden'

/**
 * Uebersetzung der vier Invarianten.
 *
 * Ein fremder oder erfundener Elternordner ergibt **404 mit derselben Meldung wie ein unbekannter Ordner**:
 * die Antwort verraet nicht, dass es ihn anderswo gibt. Die drei uebrigen sind echte Konflikte mit dem
 * vorhandenen Baum und nennen ihren Grund - der Anfragende sieht diesen Baum ohnehin.
 */
const VIOLATIONS: Readonly<Record<FolderViolation, { readonly status: number; readonly message: string }>> = {
  'fremder-arbeitsbereich': { status: 404, message: FOLDER_NOT_FOUND },
  zyklus: { status: 409, message: 'Ein Ordner kann nicht unter sich selbst oder einen seiner Unterordner wandern' },
  'name-doppelt': { status: 409, message: 'An dieser Stelle gibt es bereits einen Ordner mit diesem Namen' },
  'zu-tief': {
    status: 409,
    message: `Ordner lassen sich hoechstens ${String(MAX_FOLDER_DEPTH)} Ebenen tief verschachteln`,
  },
}

const NAME_EXPECTED = `Ein Name mit 1 bis ${String(MAX_FOLDER_NAME_LENGTH)} Zeichen wird erwartet`

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

function toFolderView(folder: Folder): FolderView {
  return {
    id: folder.id,
    workspaceId: folder.workspaceId,
    parentId: folder.parentId,
    name: folder.name,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
  }
}

/**
 * Elternkennung aus dem Anfragekoerper. `null` und ein fehlendes Feld bedeuten dasselbe - unmittelbar im
 * Arbeitsbereich -, alles andere muss eine gueltig geformte Kennung sein. `undefined` heisst: ungueltig.
 */
function readParentId(raw: unknown): FolderId | null | undefined {
  if (raw === null || raw === undefined) {
    return null
  }
  return readUuid(raw) ?? undefined
}

export function createFolderRoutes(context: AppContext): readonly Route[] {
  const { workspaces: store } = context

  /** Einziger Weg zu einer Entscheidung. `null` heisst erlaubt; sonst steht die Ablehnung bereit. */
  function deny(auth: AuthenticatedSession, access: WorkspaceAccess, action: WorkspaceAction): Reply | null {
    const decision = decideWorkspaceAccess(
      { user: auth.user, workspaceRole: access.role },
      access.workspace,
      action,
    )
    if (decision.allowed) {
      return null
    }
    const { status, message } = DENIALS[decision.reason]
    context.logger('warn', 'authorization.denied', {
      userId: auth.user.id,
      workspaceId: access.workspace.id,
      action: action.kind,
      reason: decision.reason,
    })
    return fail(status, message)
  }

  /** Arbeitsbereich samt eigener Rolle; unbekannt und nicht sichtbar ergeben dieselbe 404. */
  async function loadVisible(
    tx: WorkspaceStore,
    auth: AuthenticatedSession,
    workspaceId: WorkspaceId,
    options: { readonly lock: boolean },
  ): Promise<WorkspaceAccess | Reply> {
    const access = options.lock
      ? await tx.workspaces.findForUpdate(workspaceId, auth.user.id)
      : await tx.workspaces.findForUser(workspaceId, auth.user.id)
    if (access === null) {
      return fail(404, DENIALS['not-visible'].message)
    }
    return deny(auth, access, { kind: 'workspace:read' }) ?? access
  }

  /**
   * Gemeinsamer Einstieg der drei Endpunkte, die einen **vorhandenen** Ordner aendern.
   *
   * Reihenfolge: Sitzung und CSRF, Kennung, Ordner lesen, seinen Arbeitsbereich sperren, Berechtigung, und
   * erst dann der Bestand. Der Ordner selbst kommt aus dem **unter der Sperre** gelesenen Bestand und nicht
   * aus dem ersten Lesen - sonst entschiede die Regel auf einem Stand von vor der Sperre.
   */
  async function withLockedFolder(
    request: IncomingMessage,
    response: ServerResponse,
    run: (
      tx: WorkspaceStore,
      auth: AuthenticatedSession,
      access: WorkspaceAccess,
      folder: Folder,
      folders: readonly Folder[],
      body: Record<string, unknown>,
    ) => Promise<Reply>,
  ): Promise<void> {
    const guarded = await guardMutation(context, request, response)
    if (guarded === null) {
      return
    }
    const folderId = readUuid(guarded.body['folderId'])
    if (folderId === null) {
      sendError(response, 404, FOLDER_NOT_FOUND)
      return
    }
    const reply = await store.transaction(async (tx) => {
      const found = await tx.folders.find(folderId)
      if (found === null) {
        return fail(404, FOLDER_NOT_FOUND)
      }
      const access = await loadVisible(tx, guarded.auth, found.workspaceId, { lock: true })
      if (isReply(access)) {
        return access
      }
      const denial = deny(guarded.auth, access, { kind: 'folder:manage' })
      if (denial !== null) {
        return denial
      }
      const folders = await tx.folders.listForWorkspace(access.workspace.id)
      const folder = folders.find((entry) => entry.id === folderId)
      if (folder === undefined) {
        return fail(404, FOLDER_NOT_FOUND)
      }
      return run(tx, guarded.auth, access, folder, folders, guarded.body)
    })
    send(response, reply)
  }

  return [
    {
      method: 'GET',
      path: FOLDERS_PATH,
      handle: async ({ request, response, url }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        const workspaceId = readUuid(url.searchParams.get(WORKSPACE_ID_PARAM))
        if (workspaceId === null) {
          sendError(response, 404, DENIALS['not-visible'].message)
          return
        }
        // Lesen darf den Baum jedes Mitglied: er ist die Gliederung des gemeinsamen Arbeitsraums und
        // nennt kein einziges Board.
        const access = await loadVisible(store, auth, workspaceId, { lock: false })
        if (isReply(access)) {
          send(response, access)
          return
        }
        const folders = await store.folders.listForWorkspace(workspaceId)
        const body: FoldersResponse = {
          workspace: toWorkspaceView(access.workspace, access.role),
          folders: folders.map(toFolderView),
        }
        send(response, ok(200, body))
      },
    },

    {
      method: 'POST',
      path: FOLDERS_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const workspaceId = readUuid(guarded.body['workspaceId'])
        const name = normalizeFolderName(guarded.body['name'])
        const parentId = readParentId(guarded.body['parentId'])
        if (workspaceId === null) {
          sendError(response, 404, DENIALS['not-visible'].message)
          return
        }
        if (name === null) {
          sendError(response, 400, NAME_EXPECTED)
          return
        }
        if (parentId === undefined) {
          sendError(response, 404, FOLDER_NOT_FOUND)
          return
        }
        const reply = await store.transaction(async (tx) => {
          const access = await loadVisible(tx, guarded.auth, workspaceId, { lock: true })
          if (isReply(access)) {
            return access
          }
          const denial = deny(guarded.auth, access, { kind: 'folder:manage' })
          if (denial !== null) {
            return denial
          }
          const folders = await tx.folders.listForWorkspace(workspaceId)
          const violation = checkFolderPlacement(folders, { id: null, workspaceId, parentId, name })
          if (violation !== null) {
            const { status, message } = VIOLATIONS[violation]
            return fail(status, message)
          }
          const created = await tx.folders.create(workspaceId, parentId, name)
          await tx.audit.record({
            actorId: guarded.auth.user.id,
            action: 'folder.created',
            targetType: 'board-folder',
            targetId: created.id,
            workspaceId,
            details: { name: created.name, parentId },
          })
          return ok(201, toFolderView(created))
        })
        send(response, reply)
      },
    },

    {
      method: 'POST',
      path: FOLDER_RENAME_PATH,
      handle: async ({ request, response }) => {
        await withLockedFolder(request, response, async (tx, auth, access, folder, folders, body) => {
          const name = normalizeFolderName(body['name'])
          if (name === null) {
            return fail(400, NAME_EXPECTED)
          }
          // Derselbe Platz, nur ein anderer Name: die Eindeutigkeit unter den Geschwistern gilt auch hier.
          const violation = checkFolderPlacement(folders, {
            id: folder.id,
            workspaceId: access.workspace.id,
            parentId: folder.parentId,
            name,
          })
          if (violation !== null) {
            const { status, message } = VIOLATIONS[violation]
            return fail(status, message)
          }
          const renamed = await tx.folders.rename(folder.id, name)
          await tx.audit.record({
            actorId: auth.user.id,
            action: 'folder.renamed',
            targetType: 'board-folder',
            targetId: folder.id,
            workspaceId: access.workspace.id,
            details: { previousName: folder.name, name: renamed.name },
          })
          return ok(200, toFolderView(renamed))
        })
      },
    },

    {
      method: 'POST',
      path: FOLDER_MOVE_PATH,
      handle: async ({ request, response }) => {
        await withLockedFolder(request, response, async (tx, auth, access, folder, folders, body) => {
          const parentId = readParentId(body['parentId'])
          if (parentId === undefined) {
            return fail(404, FOLDER_NOT_FOUND)
          }
          const violation = checkFolderPlacement(folders, {
            id: folder.id,
            workspaceId: access.workspace.id,
            parentId,
            name: folder.name,
          })
          if (violation !== null) {
            const { status, message } = VIOLATIONS[violation]
            return fail(status, message)
          }
          const moved = await tx.folders.setParent(folder.id, parentId)
          await tx.audit.record({
            actorId: auth.user.id,
            action: 'folder.moved',
            targetType: 'board-folder',
            targetId: folder.id,
            workspaceId: access.workspace.id,
            details: { previousParentId: folder.parentId, parentId },
          })
          return ok(200, toFolderView(moved))
        })
      },
    },

    {
      method: 'POST',
      path: FOLDER_REMOVE_PATH,
      handle: async ({ request, response }) => {
        await withLockedFolder(request, response, async (tx, auth, access, folder, folders) => {
          // Der Inhalt rueckt auf den Platz des entfernten Ordners. Das kann genau eine Regel verletzen:
          // ein Unterordner traegt denselben Namen wie ein Ordner, der dort schon liegt. Geprueft wird
          // gegen den Bestand **ohne** den entfernten Ordner - er selbst steht dem Namen seiner Kinder
          // gleich nicht mehr im Weg.
          const rest = folders.filter((entry) => entry.id !== folder.id)
          const kollision = folders
            .filter((entry) => entry.parentId === folder.id)
            .find(
              (child) =>
                checkFolderPlacement(rest, {
                  id: child.id,
                  workspaceId: access.workspace.id,
                  parentId: folder.parentId,
                  name: child.name,
                }) !== null,
            )
          if (kollision !== undefined) {
            return fail(
              409,
              `Der Unterordner "${kollision.name}" kann nicht aufruecken: an seinem Ziel gibt es diesen Namen bereits`,
            )
          }
          const moved = await tx.folders.dissolve(folder.id, folder.parentId)
          await tx.audit.record({
            actorId: auth.user.id,
            action: 'folder.removed',
            targetType: 'board-folder',
            targetId: folder.id,
            workspaceId: access.workspace.id,
            details: {
              name: folder.name,
              parentId: folder.parentId,
              movedFolders: moved.folders,
              movedBoards: moved.boards,
            },
          })
          const body: RemoveFolderResponse = {
            folderId: folder.id,
            parentId: folder.parentId,
            movedFolders: moved.folders,
            movedBoards: moved.boards,
          }
          return ok(200, body)
        })
      },
    },
  ]
}
