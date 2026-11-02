/**
 * Own API keys: create, list, revoke.
 *
 * Session and CSRF token like every internal route; a key never reaches them because internal routes read
 * only the session cookie. Without a release by the system admin every endpoint answers 403.
 *
 * The key value appears exactly once, in the create response. Only its hash is stored; the value is in no
 * log line, no audit event and no error message.
 */

import type {
  CreateApiKeyResponse,
  FreshLoginRequiredResponse,
  OwnApiKeysResponse,
  OwnApiKeyView,
} from '../contracts/api.js'
import {
  FRESH_LOGIN_REQUIRED_CODE,
  ME_API_KEY_CREATE_PATH,
  ME_API_KEY_REVOKE_PATH,
  ME_API_KEYS_PATH,
} from '../contracts/api.js'
import type { ApiKey, ApiKeyAccess, ApiKeyTarget } from '../domain/identity/api-key.js'
import {
  apiKeySubject,
  displayPrefixOf,
  effectiveApiKeyLevel,
  isFreshLogin,
  mayCreateApiKey,
  normalizeApiKeyName,
  resolveApiKeyExpiry,
} from '../domain/identity/api-key.js'
import type { User } from '../domain/identity/model.js'
import { decideBoardAccess } from '../domain/board/policy.js'
import { decideWorkspaceAccess } from '../domain/workspace/policy.js'
import { apiKeyStateOf, targetViewOf } from './admin-routes.js'
import { createApiKeyValue, hashApiKeyValue } from './api-key-secret.js'
import type { AppContext } from './context.js'
import { requireSession } from './guard.js'
import type { Route } from './http.js'
import { sendJson } from './http.js'
import { fail, guardMutation, ok, readUuid, send } from './reply.js'
import type { Reply } from './reply.js'

const NO_ACCESS = 'API-Keys sind fuer dieses Konto nicht freigegeben'
const TARGET_NOT_FOUND = 'Ziel nicht gefunden'
const KEY_NOT_FOUND = 'Unbekannter API-Key'

const TARGET_KINDS = ['workspace', 'folder', 'board'] as const

function parseTarget(raw: unknown): ApiKeyTarget | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const kind = TARGET_KINDS.find((candidate) => candidate === (raw as Record<string, unknown>)['kind'])
  const id = readUuid((raw as Record<string, unknown>)['id'])
  if (kind === undefined || id === null) {
    return null
  }
  switch (kind) {
    case 'workspace':
      return { kind, workspaceId: id }
    case 'folder':
      return { kind, folderId: id }
    case 'board':
      return { kind, boardId: id }
  }
}

export function createApiKeyRoutes(context: AppContext): readonly Route[] {
  const { workspaces, boards, identity } = context

  /**
   * Name of the target if the user can see it right now, else `null`. The subject is the key subject:
   * system admin elevation does not count, because a key never carries it.
   */
  async function visibleTargetName(user: User, target: ApiKeyTarget): Promise<string | null> {
    const subject = apiKeySubject(user)
    const workspaceVisible = async (workspaceId: string): Promise<string | null> => {
      const access = await workspaces.workspaces.findForUser(workspaceId, user.id)
      if (access === null) {
        return null
      }
      const decision = decideWorkspaceAccess(
        { user: subject, workspaceRole: access.role },
        access.workspace,
        { kind: 'workspace:read' },
      )
      return decision.allowed ? access.workspace.name : null
    }
    switch (target.kind) {
      case 'workspace':
        return workspaceVisible(target.workspaceId)
      case 'folder': {
        const folder = await workspaces.folders.find(target.folderId)
        if (folder === null || (await workspaceVisible(folder.workspaceId)) === null) {
          return null
        }
        return folder.name
      }
      case 'board': {
        const access = await boards.boards.findForViewer(target.boardId, { kind: 'user', userId: user.id }, context.now())
        if (access === null) {
          return null
        }
        const decision = decideBoardAccess(
          { user: subject, workspaceRole: access.role, boardRole: access.boardRole, guestGrant: null },
          access.workspace,
          access.board,
          'board:read',
        )
        return decision.allowed ? access.board.title : null
      }
    }
  }

  async function toOwnView(user: User, key: ApiKey, now: Date, names: Map<string, string | null>): Promise<OwnApiKeyView> {
    const target = targetViewOf(key.target)
    const cacheKey = `${target.kind}:${target.id}`
    if (!names.has(cacheKey)) {
      names.set(cacheKey, await visibleTargetName(user, key.target))
    }
    return {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      target: { ...target, name: names.get(cacheKey) ?? null },
      level: key.level,
      expiresAt: key.expiresAt.toISOString(),
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      state: apiKeyStateOf(key, now),
    }
  }

  const noAccess = (access: ApiKeyAccess): Reply | null => (access === 'off' ? fail(403, NO_ACCESS) : null)

  return [
    {
      method: 'GET',
      path: ME_API_KEYS_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        const denied = noAccess(await identity.apiKeys.getAccess(auth.user.id))
        if (denied !== null) {
          send(response, denied)
          return
        }
        const now = context.now()
        const names = new Map<string, string | null>()
        const keys: OwnApiKeyView[] = []
        for (const key of await identity.apiKeys.listForUser(auth.user.id)) {
          keys.push(await toOwnView(auth.user, key, now, names))
        }
        const body: OwnApiKeysResponse = { keys }
        sendJson(response, 200, body)
      },
    },

    {
      method: 'POST',
      path: ME_API_KEY_CREATE_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const { auth, body } = guarded
        const access = await identity.apiKeys.getAccess(auth.user.id)
        const denied = noAccess(access)
        if (denied !== null) {
          send(response, denied)
          return
        }
        const now = context.now()
        if (!isFreshLogin(auth.session.createdAt, now)) {
          const stale: FreshLoginRequiredResponse = {
            error: 'Fuer einen neuen API-Key ist eine frische Anmeldung noetig',
            code: FRESH_LOGIN_REQUIRED_CODE,
          }
          sendJson(response, 403, stale)
          return
        }

        const name = normalizeApiKeyName(body['name'])
        const target = parseTarget(body['target'])
        const level = body['level']
        const expiry = resolveApiKeyExpiry(body['lifetimeDays'], now)
        if (name === null || (level !== 'read' && level !== 'edit') || !expiry.ok) {
          send(response, fail(400, 'Name, Stufe oder Ablauf sind ungueltig'))
          return
        }
        if (effectiveApiKeyLevel(level, access) !== level) {
          send(response, fail(403, 'Die Stufe liegt ueber deiner Freigabe'))
          return
        }
        // A malformed, unknown and invisible target all give the same answer.
        if (target === null || (await visibleTargetName(auth.user, target)) === null) {
          send(response, fail(404, TARGET_NOT_FOUND))
          return
        }

        const value = createApiKeyValue()
        const reply: Reply = await identity.transaction(async (store) => {
          if (!mayCreateApiKey(await store.apiKeys.countActive(auth.user.id, now))) {
            return fail(409, 'Die Hoechstzahl aktiver API-Keys ist erreicht')
          }
          const key = await store.apiKeys.create({
            userId: auth.user.id,
            name,
            target,
            level,
            expiresAt: expiry.expiresAt,
            prefix: displayPrefixOf(value),
            keyHash: hashApiKeyValue(value),
          })
          const view = targetViewOf(target)
          await store.userAudit.record({
            actorId: auth.user.id,
            action: 'api-key.created',
            targetType: 'api-key',
            targetId: key.id,
            subjectUserId: auth.user.id,
            details: {
              name,
              level,
              targetKind: view.kind,
              targetId: view.id,
              expiresAt: key.expiresAt.toISOString(),
            },
          })
          return ok(201, {
            key: await toOwnView(auth.user, key, now, new Map()),
            value,
          } satisfies CreateApiKeyResponse)
        })
        send(response, reply)
      },
    },

    {
      method: 'POST',
      path: ME_API_KEY_REVOKE_PATH,
      handle: async ({ request, response }) => {
        const guarded = await guardMutation(context, request, response)
        if (guarded === null) {
          return
        }
        const { auth, body } = guarded
        const denied = noAccess(await identity.apiKeys.getAccess(auth.user.id))
        if (denied !== null) {
          send(response, denied)
          return
        }
        // Only the own keys are searched: a foreign id is simply unknown.
        const key = (await identity.apiKeys.listForUser(auth.user.id)).find((candidate) => candidate.id === body['keyId'])
        if (key === undefined) {
          send(response, fail(404, KEY_NOT_FOUND))
          return
        }
        await identity.transaction(async (store) => {
          if (await store.apiKeys.revoke(key.id, context.now())) {
            await store.userAudit.record({
              actorId: auth.user.id,
              action: 'api-key.revoked',
              targetType: 'api-key',
              targetId: key.id,
              subjectUserId: auth.user.id,
              details: { name: key.name, by: 'owner' },
            })
          }
        })
        send(response, ok(200, { status: 'ok' }))
      },
    },
  ]
}
