/**
 * Workspaces und Mitgliedschaften.
 *
 * Die Routen enthalten bewusst keinen einzigen Rollenvergleich: sie laden den Workspace immer zusammen mit
 * der Rolle des Anfragenden, lassen `decideWorkspaceAccess` entscheiden und uebersetzen die Ablehnung in eine
 * HTTP-Antwort. Jede zustandsaendernde Route laeuft ausserdem in einer Transaktion, die die Workspacezeile
 * sperrt - dadurch sind gleichzeitige Mitgliedschaftsaenderungen serialisiert und die Ownerinvariante
 * entscheidet nie auf einem veralteten Stand.
 *
 * Antwortwahl bei fehlender Berechtigung, einheitlich fuer alle Endpunkte:
 * - Wer den Workspace nicht sehen darf, bekommt **404**. Eine geratene fremde Kennung ist damit nicht von
 *   einer erfundenen zu unterscheiden; die Existenz wird nicht preisgegeben.
 * - Wer ihn sehen, die Aktion aber nicht ausfuehren darf, bekommt **403**. Hier ist die Existenz ohnehin
 *   bekannt, und eine 404 waere eine irrefuehrende Fehlermeldung.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  DirectoryUserView,
  WorkspaceCandidatesResponse,
  WorkspaceMemberChangeResponse,
  WorkspaceMemberView,
  WorkspaceMembersResponse,
  WorkspaceView,
  WorkspacesResponse,
} from '../contracts/api.js'
import {
  WORKSPACE_ID_PARAM,
  WORKSPACE_MEMBER_ADD_PATH,
  WORKSPACE_MEMBER_CANDIDATES_PATH,
  WORKSPACE_MEMBER_REMOVE_PATH,
  WORKSPACE_MEMBER_ROLE_PATH,
  WORKSPACE_MEMBERS_PATH,
  WORKSPACE_RENAME_PATH,
  WORKSPACE_STATUS_PATH,
  WORKSPACES_PATH,
} from '../contracts/api.js'
import type { AuthenticatedSession } from '../domain/identity/model.js'
import type { Workspace, WorkspaceId, WorkspaceRole, WorkspaceStatus } from '../domain/workspace/model.js'
import { leavesWorkspaceWithoutOwner, normalizeWorkspaceName, parseWorkspaceRole } from '../domain/workspace/model.js'
import type { DenialReason, PolicySubject, WorkspaceAction } from '../domain/workspace/policy.js'
import { decideWorkspaceAccess } from '../domain/workspace/policy.js'
import type { WorkspaceMember, WorkspaceStore } from '../domain/workspace/repositories.js'
import { MembershipConflictError } from '../domain/workspace/repositories.js'
import type { AppContext } from './context.js'
import { requireCsrfToken, requireSession } from './guard.js'
import type { Route } from './http.js'
import { readJsonBody, sendError, sendJson } from './http.js'

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

function toMemberView(member: WorkspaceMember): WorkspaceMemberView {
  return {
    userId: member.userId,
    displayName: member.displayName,
    email: member.email,
    role: member.role,
    joinedAt: member.createdAt.toISOString(),
  }
}

/**
 * Uebersetzung der Ablehnungsgruende. `user-deactivated` ist ueber HTTP nicht erreichbar, weil `authenticate`
 * eine Sitzung ohne aktiven Nutzer gar nicht erst herausgibt; die Zuordnung steht trotzdem hier, damit die
 * Uebersetzung vollstaendig ist und keine Lage in einen Standardfall faellt.
 */
const DENIALS: Readonly<Record<DenialReason, { readonly status: number; readonly message: string }>> = {
  'not-visible': { status: 404, message: 'Arbeitsbereich nicht gefunden' },
  'user-deactivated': { status: 404, message: 'Arbeitsbereich nicht gefunden' },
  'insufficient-role': { status: 403, message: 'Keine Berechtigung fuer diese Aktion' },
  'workspace-archived': { status: 403, message: 'Der Arbeitsbereich ist archiviert und kann nicht geaendert werden' },
}

type Guarded = {
  readonly auth: AuthenticatedSession
  readonly body: Record<string, unknown>
}

/** Sitzung, CSRF-Token und JSON-Koerper fuer eine zustandsaendernde Route. */
async function guardMutation(
  context: AppContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Guarded | null> {
  const auth = await requireSession(context, request, response)
  if (auth === null || !requireCsrfToken(context, request, response, auth)) {
    return null
  }
  const body = await readJsonBody(request)
  if (body === null) {
    sendError(response, 400, 'Ungueltiger Anfragekoerper')
    return null
  }
  return { auth, body }
}

/**
 * Postgres lehnt eine erfundene Kennung, die keine UUID ist, mit einem Typfehler ab. Fachlich ist sie
 * schlicht unbekannt - und muss dieselbe Antwort bekommen wie eine gueltig geformte fremde Kennung.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
}

export function createWorkspaceRoutes(context: AppContext): readonly Route[] {
  const { workspaces: store } = context

  function subjectOf(auth: AuthenticatedSession, role: WorkspaceRole | null): PolicySubject {
    return { user: auth.user, workspaceRole: role }
  }

  /**
   * Einziger Weg zu einer Entscheidung. Erlaubt sie nicht, ist die Antwort bereits geschrieben und der
   * Aufrufer beendet sich.
   */
  function enforce(
    response: ServerResponse,
    auth: AuthenticatedSession,
    access: { readonly workspace: Workspace; readonly role: WorkspaceRole | null },
    action: WorkspaceAction,
  ): boolean {
    const decision = decideWorkspaceAccess(subjectOf(auth, access.role), access.workspace, action)
    if (decision.allowed) {
      return true
    }
    const { status, message } = DENIALS[decision.reason]
    context.logger('warn', 'authorization.denied', {
      userId: auth.user.id,
      workspaceId: access.workspace.id,
      action: action.kind,
      reason: decision.reason,
    })
    sendError(response, status, message)
    return false
  }

  /**
   * Laedt den Workspace samt eigener Rolle und setzt die Sichtbarkeit durch. Eine unbekannte und eine nicht
   * sichtbare Kennung ergeben dieselbe 404.
   */
  async function loadVisible(
    tx: WorkspaceStore,
    response: ServerResponse,
    auth: AuthenticatedSession,
    workspaceId: WorkspaceId,
    options: { readonly lock: boolean },
  ) {
    const access = options.lock
      ? await tx.workspaces.findForUpdate(workspaceId, auth.user.id)
      : await tx.workspaces.findForUser(workspaceId, auth.user.id)
    if (access === null) {
      sendError(response, 404, DENIALS['not-visible'].message)
      return null
    }
    return enforce(response, auth, access, { kind: 'workspace:read' }) ? access : null
  }

  /** Gemeinsamer Einstieg der lesenden Workspaceendpunkte: Sitzung, Kennung aus der Query, Sichtbarkeit. */
  async function loadForRead(request: IncomingMessage, response: ServerResponse, url: URL) {
    const auth = await requireSession(context, request, response)
    if (auth === null) {
      return null
    }
    const workspaceId = readUuid(url.searchParams.get(WORKSPACE_ID_PARAM))
    if (workspaceId === null) {
      sendError(response, 404, DENIALS['not-visible'].message)
      return null
    }
    const access = await loadVisible(store, response, auth, workspaceId, { lock: false })
    return access === null ? null : { auth, access }
  }

  return [
    {
      method: 'GET',
      path: WORKSPACES_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        // Ausschliesslich eigene Mitgliedschaften - auch fuer einen Systemadmin. Seine Verwaltungsrechte
        // machen ihn nicht zum Mitglied und fuellen deshalb auch seine Liste nicht.
        const list = await store.workspaces.listForUser(auth.user.id)
        const body: WorkspacesResponse = {
          workspaces: list.map((entry) => toWorkspaceView(entry.workspace, entry.role)),
        }
        sendJson(response, 200, body)
      },
    },

    {
      method: 'POST',
      path: WORKSPACES_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const name = normalizeWorkspaceName(guarded.body['name'])
        if (name === null) {
          sendError(response, 400, 'Ein Name mit 1 bis 80 Zeichen wird erwartet')
          return
        }
        // Vor der Anlage gibt es keinen Workspace und damit nichts zu autorisieren: jeder angemeldete,
        // aktive Nutzer darf einen eigenen Arbeitsbereich anlegen. Alles Weitere entscheidet die Policy.
        const created = await store.transaction(async (tx) => {
          const workspace = await tx.workspaces.create(name, guarded.auth.user.id)
          await tx.audit.record({
            actorId: guarded.auth.user.id,
            action: 'workspace.created',
            targetType: 'workspace',
            targetId: workspace.id,
            workspaceId: workspace.id,
            details: { name: workspace.name },
          })
          await tx.audit.record({
            actorId: guarded.auth.user.id,
            action: 'membership.added',
            targetType: 'membership',
            targetId: guarded.auth.user.id,
            workspaceId: workspace.id,
            details: { role: 'owner', reason: 'creator' },
          })
          return workspace
        })
        context.logger('info', 'workspace.created', { userId: guarded.auth.user.id, workspaceId: created.id })
        sendJson(response, 201, toWorkspaceView(created, 'owner'))
      },
    },

    {
      method: 'POST',
      path: WORKSPACE_RENAME_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const workspaceId = readUuid(guarded.body['workspaceId'])
        const name = normalizeWorkspaceName(guarded.body['name'])
        if (workspaceId === null) {
          sendError(response, 404, DENIALS['not-visible'].message)
          return
        }
        if (name === null) {
          sendError(response, 400, 'Ein Name mit 1 bis 80 Zeichen wird erwartet')
          return
        }
        await store.transaction(async (tx) => {
          const access = await loadVisible(tx, response, guarded.auth, workspaceId, { lock: true })
          if (access === null || !enforce(response, guarded.auth, access, { kind: 'workspace:rename' })) {
            return
          }
          const renamed = await tx.workspaces.rename(workspaceId, name)
          await tx.audit.record({
            actorId: guarded.auth.user.id,
            action: 'workspace.renamed',
            targetType: 'workspace',
            targetId: workspaceId,
            workspaceId,
            details: { previousName: access.workspace.name, name: renamed.name },
          })
          sendJson(response, 200, toWorkspaceView(renamed, access.role))
        })
      },
    },

    {
      method: 'POST',
      path: WORKSPACE_STATUS_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const workspaceId = readUuid(guarded.body['workspaceId'])
        const raw = guarded.body['status']
        const status: WorkspaceStatus | null = raw === 'active' || raw === 'archived' ? raw : null
        if (workspaceId === null) {
          sendError(response, 404, DENIALS['not-visible'].message)
          return
        }
        if (status === null) {
          sendError(response, 400, 'status muss active oder archived sein')
          return
        }
        const action: WorkspaceAction =
          status === 'archived' ? { kind: 'workspace:archive' } : { kind: 'workspace:unarchive' }
        await store.transaction(async (tx) => {
          const access = await loadVisible(tx, response, guarded.auth, workspaceId, { lock: true })
          if (access === null || !enforce(response, guarded.auth, access, action)) {
            return
          }
          const updated = await tx.workspaces.setStatus(workspaceId, status)
          await tx.audit.record({
            actorId: guarded.auth.user.id,
            action: status === 'archived' ? 'workspace.archived' : 'workspace.unarchived',
            targetType: 'workspace',
            targetId: workspaceId,
            workspaceId,
            details: { status },
          })
          sendJson(response, 200, toWorkspaceView(updated, access.role))
        })
      },
    },

    {
      method: 'GET',
      path: WORKSPACE_MEMBERS_PATH,
      handle: async ({ request, response, url }) => {
        const loaded = await loadForRead(request, response, url)
        if (loaded === null) {
          return
        }
        const members = await store.workspaces.listMembers(loaded.access.workspace.id)
        const body: WorkspaceMembersResponse = {
          workspace: toWorkspaceView(loaded.access.workspace, loaded.access.role),
          members: members.map(toMemberView),
        }
        sendJson(response, 200, body)
      },
    },

    {
      method: 'GET',
      path: WORKSPACE_MEMBER_CANDIDATES_PATH,
      handle: async ({ request, response, url }) => {
        const loaded = await loadForRead(request, response, url)
        if (loaded === null) {
          return
        }
        // Das Nutzerverzeichnis sieht nur, wer ueberhaupt jemanden aufnehmen darf; die geringste Rolle ist
        // dafuer die richtige Probe. Ein blosses Mitglied bekommt keine Liste aller internen Nutzer.
        if (!enforce(response, loaded.auth, loaded.access, { kind: 'member:add', role: 'member' })) {
          return
        }
        const candidates = await store.workspaces.listCandidates(loaded.access.workspace.id)
        const users: readonly DirectoryUserView[] = candidates.map((user) => ({
          id: user.id,
          displayName: user.displayName,
          email: user.email,
        }))
        const body: WorkspaceCandidatesResponse = { users }
        sendJson(response, 200, body)
      },
    },

    {
      method: 'POST',
      path: WORKSPACE_MEMBER_ADD_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const workspaceId = readUuid(guarded.body['workspaceId'])
        const userId = readUuid(guarded.body['userId'])
        const role = parseWorkspaceRole(guarded.body['role'])
        if (workspaceId === null) {
          sendError(response, 404, DENIALS['not-visible'].message)
          return
        }
        if (userId === null || role === null) {
          sendError(response, 400, 'userId und eine gueltige Rolle werden erwartet')
          return
        }
        await store.transaction(async (tx) => {
          const access = await loadVisible(tx, response, guarded.auth, workspaceId, { lock: true })
          if (access === null || !enforce(response, guarded.auth, access, { kind: 'member:add', role })) {
            return
          }
          // Erst nach der Berechtigungspruefung: sonst verriete die Antwort, welche Nutzerkennungen es gibt.
          const target = await context.identity.users.findById(userId)
          if (target === null) {
            sendError(response, 404, 'Unbekannter Nutzer')
            return
          }
          if (target.status !== 'active') {
            sendError(response, 400, 'Ein deaktivierter Nutzer kann nicht aufgenommen werden')
            return
          }
          let added
          try {
            added = await tx.workspaces.addMember(workspaceId, userId, role)
          } catch (error) {
            if (!(error instanceof MembershipConflictError)) {
              throw error
            }
            sendError(response, 409, 'Der Nutzer ist bereits Mitglied')
            return
          }
          await tx.audit.record({
            actorId: guarded.auth.user.id,
            action: 'membership.added',
            targetType: 'membership',
            targetId: userId,
            workspaceId,
            details: { role: added.role },
          })
          const body: WorkspaceMemberView = {
            userId,
            displayName: target.displayName,
            email: target.email,
            role: added.role,
            joinedAt: added.createdAt.toISOString(),
          }
          sendJson(response, 201, body)
        })
      },
    },

    {
      method: 'POST',
      path: WORKSPACE_MEMBER_ROLE_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const workspaceId = readUuid(guarded.body['workspaceId'])
        const userId = readUuid(guarded.body['userId'])
        const nextRole = parseWorkspaceRole(guarded.body['role'])
        if (workspaceId === null) {
          sendError(response, 404, DENIALS['not-visible'].message)
          return
        }
        if (userId === null || nextRole === null) {
          sendError(response, 400, 'userId und eine gueltige Rolle werden erwartet')
          return
        }
        await store.transaction(async (tx) => {
          const access = await loadVisible(tx, response, guarded.auth, workspaceId, { lock: true })
          if (access === null) {
            return
          }
          const membership = await tx.workspaces.findMembership(workspaceId, userId)
          if (membership === null) {
            sendError(response, 404, 'Mitgliedschaft nicht gefunden')
            return
          }
          const action: WorkspaceAction = {
            kind: 'member:change-role',
            currentRole: membership.role,
            nextRole,
          }
          if (!enforce(response, guarded.auth, access, action)) {
            return
          }
          if (membership.role === nextRole) {
            const unchanged: WorkspaceMemberChangeResponse = { userId, role: nextRole }
            sendJson(response, 200, unchanged)
            return
          }
          // Die Zahl der Owner stammt aus derselben, die Workspacezeile sperrenden Transaktion wie der
          // Schreibvorgang. Zwei gleichzeitige Herabstufungen koennen den Workspace deshalb nicht ownerlos
          // machen: die zweite sieht den bereits herabgestuften Stand.
          const ownerCount = await tx.workspaces.countOwners(workspaceId)
          if (leavesWorkspaceWithoutOwner(ownerCount, membership.role, nextRole)) {
            sendError(response, 409, 'Der letzte Owner kann nicht herabgestuft werden')
            return
          }
          const updated = await tx.workspaces.setRole(workspaceId, userId, nextRole)
          await tx.audit.record({
            actorId: guarded.auth.user.id,
            action: 'membership.role-changed',
            targetType: 'membership',
            targetId: userId,
            workspaceId,
            details: { previousRole: membership.role, role: updated.role },
          })
          const changed: WorkspaceMemberChangeResponse = { userId, role: updated.role }
          sendJson(response, 200, changed)
        })
      },
    },

    {
      method: 'POST',
      path: WORKSPACE_MEMBER_REMOVE_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const workspaceId = readUuid(guarded.body['workspaceId'])
        const userId = readUuid(guarded.body['userId'])
        if (workspaceId === null) {
          sendError(response, 404, DENIALS['not-visible'].message)
          return
        }
        if (userId === null) {
          sendError(response, 400, 'userId wird erwartet')
          return
        }
        await store.transaction(async (tx) => {
          const access = await loadVisible(tx, response, guarded.auth, workspaceId, { lock: true })
          if (access === null) {
            return
          }
          const membership = await tx.workspaces.findMembership(workspaceId, userId)
          if (membership === null) {
            sendError(response, 404, 'Mitgliedschaft nicht gefunden')
            return
          }
          if (!enforce(response, guarded.auth, access, { kind: 'member:remove', currentRole: membership.role })) {
            return
          }
          const ownerCount = await tx.workspaces.countOwners(workspaceId)
          if (leavesWorkspaceWithoutOwner(ownerCount, membership.role, null)) {
            sendError(response, 409, 'Der letzte Owner kann nicht entfernt werden')
            return
          }
          await tx.workspaces.removeMember(workspaceId, userId)
          await tx.audit.record({
            actorId: guarded.auth.user.id,
            action: 'membership.removed',
            targetType: 'membership',
            targetId: userId,
            workspaceId,
            details: { previousRole: membership.role },
          })
          context.logger('info', 'workspace.membership.removed', {
            actorId: guarded.auth.user.id,
            userId,
            workspaceId,
          })
          const removed: WorkspaceMemberChangeResponse = { userId, role: null }
          sendJson(response, 200, removed)
        })
      },
    },
  ]
}
