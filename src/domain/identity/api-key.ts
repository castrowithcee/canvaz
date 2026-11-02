/**
 * API key domain core, no IO. A key acts with at most its user's current rights and never with system
 * admin rights. The effective level is recomputed from the current access on every resolution, so a
 * revocation or downgrade takes effect at once.
 */

import type { Folder, FolderId } from '../folder/model.js'
import { isInFolderSubtree } from '../folder/model.js'
import type { WorkspaceId } from '../workspace/model.js'
import type { User, UserId } from './model.js'
import { isUserActive } from './model.js'

export type ApiKeyId = string

export type ApiKeyLevel = 'read' | 'edit'
/** Per-user access; `off` invalidates all of the user's keys. */
export type ApiKeyAccess = 'off' | ApiKeyLevel

/** Exactly one target; a folder means its whole subtree. */
export type ApiKeyTarget =
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }
  | { readonly kind: 'folder'; readonly folderId: FolderId }
  | { readonly kind: 'board'; readonly boardId: string }

export type ApiKey = {
  readonly id: ApiKeyId
  readonly userId: UserId
  readonly name: string
  readonly target: ApiKeyTarget
  readonly level: ApiKeyLevel
  readonly expiresAt: Date
  readonly revokedAt: Date | null
  readonly lastUsedAt: Date | null
  /** Short, non-secret start of the value. */
  readonly prefix: string
  readonly createdAt: Date
}

export const API_KEY_VALUE_PREFIX = 'cvz_'
/** Random bytes of the value; base64url gives 43 characters. */
export const API_KEY_RANDOM_BYTES = 32
/** Display prefix length including `cvz_`: four random characters, 24 of 256 bits. */
export const API_KEY_DISPLAY_PREFIX_LENGTH = 8

export const DEFAULT_API_KEY_LIFETIME_DAYS = 90
export const MAX_API_KEY_LIFETIME_DAYS = 365
/** Active (neither revoked nor expired) keys per user. */
export const MAX_ACTIVE_API_KEYS_PER_USER = 25
export const MAX_API_KEY_NAME_LENGTH = 60
/** A key is created only from a session at most this old; a system admin session exists only after the second factor. */
export const API_KEY_FRESH_LOGIN_MS = 10 * 60 * 1000

const API_KEY_VALUE_FORMAT = /^cvz_[A-Za-z0-9_-]{43}$/
const DAY_MS = 24 * 60 * 60 * 1000

/** Format check before hashing; spares the database queries for obvious garbage. */
export function isApiKeyValueWellFormed(value: string): boolean {
  return API_KEY_VALUE_FORMAT.test(value)
}

export function displayPrefixOf(value: string): string {
  return value.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH)
}

/** `null`: empty or too long. */
export function normalizeApiKeyName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const name = raw.trim().replace(/\s+/g, ' ')
  return name.length === 0 || name.length > MAX_API_KEY_NAME_LENGTH ? null : name
}

export type ApiKeyExpiryResult =
  | { readonly ok: true; readonly expiresAt: Date }
  | { readonly ok: false; readonly reason: 'ablauf-ungueltig' }

/** Expiry of a new key: 90 days if omitted, otherwise a whole number of days from 1 to 365. `null` and `0` are invalid, not the default. */
export function resolveApiKeyExpiry(lifetimeDays: unknown, now: Date): ApiKeyExpiryResult {
  const days = lifetimeDays === undefined ? DEFAULT_API_KEY_LIFETIME_DAYS : lifetimeDays
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_API_KEY_LIFETIME_DAYS) {
    return { ok: false, reason: 'ablauf-ungueltig' }
  }
  return { ok: true, expiresAt: new Date(now.getTime() + days * DAY_MS) }
}

const RANK: Record<ApiKeyAccess, number> = { off: 0, read: 1, edit: 2 }

/** Effective level: minimum of key level and current access; `null` when access is `off`. */
export function effectiveApiKeyLevel(keyLevel: ApiKeyLevel, access: ApiKeyAccess): ApiKeyLevel | null {
  const rank = Math.min(RANK[keyLevel], RANK[access])
  return rank === 2 ? 'edit' : rank === 1 ? 'read' : null
}

/** Whether the effective level carries an action that needs `required`. */
export function apiKeyLevelAllows(level: ApiKeyLevel, required: ApiKeyLevel): boolean {
  return RANK[level] >= RANK[required]
}

export function isApiKeyLive(key: Pick<ApiKey, 'expiresAt' | 'revokedAt'>, now: Date): boolean {
  return key.revokedAt === null && key.expiresAt.getTime() > now.getTime()
}

/** Whether the session is recent enough to create a key. */
export function isFreshLogin(sessionCreatedAt: Date, now: Date): boolean {
  return now.getTime() - sessionCreatedAt.getTime() <= API_KEY_FRESH_LOGIN_MS
}

/** Whether another key may be created; the caller enforces it at creation. */
export function mayCreateApiKey(activeKeyCount: number): boolean {
  return activeKeyCount < MAX_ACTIVE_API_KEYS_PER_USER
}

/**
 * The user a key acts as, without system admin elevation. `decideWorkspaceAccess` makes a system admin
 * owner everywhere; a key must never get that, so every key check goes through this subject.
 */
export function apiKeySubject(user: User): User {
  return { ...user, isSystemAdmin: false }
}

export type ResolvedApiKey = {
  readonly key: ApiKey
  /** Effective level now, from the current access. */
  readonly level: ApiKeyLevel
  /** The user without system admin elevation. */
  readonly subject: User
}

/** `null`: revoked, expired, access off or user inactive. */
export function resolveApiKey(
  record: { readonly key: ApiKey; readonly user: User; readonly access: ApiKeyAccess },
  now: Date,
): ResolvedApiKey | null {
  if (!isApiKeyLive(record.key, now) || !isUserActive(record.user)) {
    return null
  }
  const level = effectiveApiKeyLevel(record.key.level, record.access)
  if (level === null) {
    return null
  }
  return { key: record.key, level, subject: apiKeySubject(record.user) }
}

/** The board as the target check needs it. */
export type ApiKeyBoardRef = {
  readonly id: string
  readonly workspaceId: WorkspaceId
  readonly folderId: FolderId | null
}

/** Whether the board lies in the key's target. `folders` is the folder set of the board's workspace. */
export function isBoardInApiKeyTarget(
  target: ApiKeyTarget,
  board: ApiKeyBoardRef,
  folders: readonly Folder[],
): boolean {
  switch (target.kind) {
    case 'workspace':
      return board.workspaceId === target.workspaceId
    case 'board':
      return board.id === target.boardId
    case 'folder': {
      if (board.folderId === null) {
        return false
      }
      const root = folders.find((folder) => folder.id === target.folderId)
      return (
        root !== undefined &&
        root.workspaceId === board.workspaceId &&
        isInFolderSubtree(folders, board.folderId, target.folderId)
      )
    }
  }
}
