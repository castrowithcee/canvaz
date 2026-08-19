/**
 * Gemeinsamer Einstieg jeder Route, die genau ein Board betrifft.
 *
 * Boardrouten und Freigabelinkrouten brauchen dieselben vier Schritte: Datensatz samt aller Rollen laden,
 * die Sichtbarkeit durchsetzen, die Ablehnung der Policy in eine HTTP-Antwort uebersetzen und - beim
 * Schreiben - das Ganze unter der Zeilensperre in einer Transaktion. Stuende das zweimal da, waere die
 * zweite Fassung genau die Stelle, an der eine Antwortwahl einmal abweicht.
 *
 * Antwortwahl, wie in Issue 3 festgelegt und hier fuer alle Boardrouten verbindlich:
 * - Wer das Board nicht sehen darf, bekommt **404** - ununterscheidbar von einer erfundenen Kennung.
 * - Wer es sehen, die Aktion aber nicht ausfuehren darf, bekommt **403**.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { BoardId } from '../domain/board/model.js'
import type { BoardAction, BoardDenialReason } from '../domain/board/policy.js'
import { decideBoardAccess } from '../domain/board/policy.js'
import type { BoardAccess, BoardStore } from '../domain/board/repositories.js'
import type { AuthenticatedSession } from '../domain/identity/model.js'
import type { Workspace, WorkspaceRole } from '../domain/workspace/model.js'
import type { AppContext } from './context.js'
import { sendError } from './http.js'
import type { Reply } from './reply.js'
import { fail, guardMutation, isReply, readUuid, send } from './reply.js'
import type { BoardRoles, Requester } from './requester.js'
import { asRequester, boardSubject, requesterFields, viewerOf } from './requester.js'

export const DENIALS: Readonly<Record<BoardDenialReason, { readonly status: number; readonly message: string }>> = {
  'not-visible': { status: 404, message: 'Board nicht gefunden' },
  'user-deactivated': { status: 404, message: 'Board nicht gefunden' },
  'insufficient-role': { status: 403, message: 'Keine Berechtigung fuer diese Aktion' },
  'workspace-archived': { status: 403, message: 'Der Arbeitsbereich ist archiviert und kann nicht geaendert werden' },
  'board-archived': { status: 403, message: 'Das Board ist archiviert und kann nicht geaendert werden' },
}

export const NOT_FOUND = DENIALS['not-visible']

/** Rollen ohne Board - der Fall der Anlage und der Liste. */
export function withoutBoard(role: WorkspaceRole | null): BoardRoles {
  return { role, boardRole: null, guestRole: null, board: null }
}

export type BoardGate = {
  deny(requester: Requester, workspace: Workspace, roles: BoardRoles, action: BoardAction): Reply | null
  loadVisibleBoard(
    tx: BoardStore,
    requester: Requester,
    boardId: BoardId,
    options: { readonly lock: boolean },
  ): Promise<BoardAccess | Reply>
  withLockedBoard(
    request: IncomingMessage,
    response: ServerResponse,
    run: (
      tx: BoardStore,
      auth: AuthenticatedSession,
      access: BoardAccess,
      body: Record<string, unknown>,
    ) => Promise<Reply>,
  ): Promise<void>
}

export function createBoardGate(context: AppContext): BoardGate {
  const { boards: store } = context

  /**
   * Einziger Weg zu einer Entscheidung. `null` heisst erlaubt; sonst steht die Ablehnung als fertige Antwort
   * bereit, und der Aufrufer beendet sich. Alle Rollen kommen aus demselben geladenen Datensatz;
   * entschieden wird ausschliesslich in der Policy.
   */
  function deny(requester: Requester, workspace: Workspace, roles: BoardRoles, action: BoardAction): Reply | null {
    const decision = decideBoardAccess(boardSubject(requester, roles), workspace, roles.board, action)
    if (decision.allowed) {
      return null
    }
    const { status, message } = DENIALS[decision.reason]
    context.logger('warn', 'authorization.denied', {
      ...requesterFields(requester),
      workspaceId: workspace.id,
      ...(roles.board === null ? {} : { boardId: roles.board.id }),
      action,
      reason: decision.reason,
    })
    return fail(status, message)
  }

  /**
   * Laedt das Board samt Workspace und eigener Rolle und setzt die Sichtbarkeit durch. Eine unbekannte und
   * eine nicht sichtbare Kennung ergeben dieselbe 404 - fuer einen Gast auch ein Board, das nicht seines
   * ist, und eines, dessen Link abgelaufen oder widerrufen wurde.
   */
  async function loadVisibleBoard(
    tx: BoardStore,
    requester: Requester,
    boardId: BoardId,
    options: { readonly lock: boolean },
  ): Promise<BoardAccess | Reply> {
    const viewer = viewerOf(requester)
    const now = context.now()
    const access = options.lock
      ? await tx.boards.findForUpdate(boardId, viewer, now)
      : await tx.boards.findForViewer(boardId, viewer, now)
    if (access === null) {
      return fail(404, NOT_FOUND.message)
    }
    return deny(requester, access.workspace, access, 'board:read') ?? access
  }

  /**
   * Gemeinsamer Einstieg der zustandsaendernden Boardrouten: Sitzung, CSRF, Kennung, Sperre, Sichtbarkeit.
   *
   * Ausschliesslich fuer **interne** Endpunkte: alles, was hier laeuft, ist Verwaltung eines Boards, und die
   * ist einem Gast in jedem Zustand verwehrt. Die Szenenspeicherung geht deshalb einen eigenen Weg.
   */
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
      const access = await loadVisibleBoard(tx, asRequester(guarded.auth), boardId, { lock: true })
      if (isReply(access)) {
        return access
      }
      return run(tx, guarded.auth, access, guarded.body)
    })
    send(response, reply)
  }

  return { deny, loadVisibleBoard, withLockedBoard }
}
