/** API key domain core: expiry, effective level, target check and the subject without admin elevation. */

import { describe, expect, it } from 'vitest'

import type { ApiKey } from '../../src/domain/identity/api-key.js'
import {
  apiKeySubject,
  effectiveApiKeyLevel,
  isApiKeyValueWellFormed,
  isBoardInApiKeyTarget,
  mayCreateApiKey,
  resolveApiKey,
  resolveApiKeyExpiry,
} from '../../src/domain/identity/api-key.js'
import type { Folder } from '../../src/domain/folder/model.js'
import type { User } from '../../src/domain/identity/model.js'
import { decideWorkspaceAccess } from '../../src/domain/workspace/policy.js'
import { createApiKeyValue, hashApiKeyValue } from '../../src/server/api-key-secret.js'

const NOW = new Date('2026-06-01T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function nutzer(isSystemAdmin: boolean): User {
  return {
    id: 'u-1',
    displayName: 'Ada',
    email: null,
    status: 'active',
    isSystemAdmin,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function schluessel(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'k-1',
    userId: 'u-1',
    name: 'CI',
    target: { kind: 'workspace', workspaceId: 'w-1' },
    level: 'edit',
    expiresAt: new Date(NOW.getTime() + DAY),
    revokedAt: null,
    lastUsedAt: null,
    prefix: 'cvz_abcd',
    createdAt: NOW,
    ...overrides,
  }
}

function ordner(id: string, parentId: string | null, workspaceId = 'w-1'): Folder {
  return { id, workspaceId, parentId, name: id, createdAt: NOW, updatedAt: NOW }
}

describe('Ablauf', () => {
  it('gilt ohne Angabe 90 Tage', () => {
    expect(resolveApiKeyExpiry(undefined, NOW)).toEqual({ ok: true, expiresAt: new Date(NOW.getTime() + 90 * DAY) })
  })

  it('erlaubt hoechstens 365 Tage', () => {
    expect(resolveApiKeyExpiry(365, NOW).ok).toBe(true)
    expect(resolveApiKeyExpiry(366, NOW)).toEqual({ ok: false, reason: 'ablauf-ungueltig' })
  })

  it('verlangt einen Ablauf: null, 0 und Bruchzahlen sind ungueltig', () => {
    expect(resolveApiKeyExpiry(null, NOW).ok).toBe(false)
    expect(resolveApiKeyExpiry(0, NOW).ok).toBe(false)
    expect(resolveApiKeyExpiry(1.5, NOW).ok).toBe(false)
  })
})

describe('Wirksame Stufe', () => {
  it('ist das Minimum aus Key-Stufe und Freigabe', () => {
    expect(effectiveApiKeyLevel('edit', 'read')).toBe('read')
    expect(effectiveApiKeyLevel('read', 'edit')).toBe('read')
    expect(effectiveApiKeyLevel('edit', 'edit')).toBe('edit')
  })

  it('macht den Key bei Freigabe aus ungueltig', () => {
    expect(effectiveApiKeyLevel('edit', 'off')).toBeNull()
    expect(resolveApiKey({ key: schluessel(), user: nutzer(false), access: 'off' }, NOW)).toBeNull()
  })

  it('lehnt abgelaufene und widerrufene Keys sowie inaktive Nutzer ab', () => {
    const user = nutzer(false)
    expect(resolveApiKey({ key: schluessel({ expiresAt: NOW }), user, access: 'edit' }, NOW)).toBeNull()
    expect(resolveApiKey({ key: schluessel({ revokedAt: NOW }), user, access: 'edit' }, NOW)).toBeNull()
    expect(resolveApiKey({ key: schluessel(), user: { ...user, status: 'deactivated' }, access: 'edit' }, NOW)).toBeNull()
  })
})

describe('Obergrenze aktiver Keys', () => {
  it('erlaubt bis zu 25', () => {
    expect(mayCreateApiKey(24)).toBe(true)
    expect(mayCreateApiKey(25)).toBe(false)
  })
})

describe('Zielpruefung', () => {
  const baum = [ordner('f1', null), ordner('f2', 'f1'), ordner('f3', 'f2'), ordner('f9', null)]

  it('trifft nur das Ziel-Board', () => {
    const target = { kind: 'board', boardId: 'b-1' } as const
    expect(isBoardInApiKeyTarget(target, { id: 'b-1', workspaceId: 'w-1', folderId: null }, baum)).toBe(true)
    expect(isBoardInApiKeyTarget(target, { id: 'b-2', workspaceId: 'w-1', folderId: null }, baum)).toBe(false)
  })

  it('trifft nur Boards des Ziel-Workspace', () => {
    const target = { kind: 'workspace', workspaceId: 'w-1' } as const
    expect(isBoardInApiKeyTarget(target, { id: 'b', workspaceId: 'w-1', folderId: 'f9' }, baum)).toBe(true)
    expect(isBoardInApiKeyTarget(target, { id: 'b', workspaceId: 'w-2', folderId: null }, baum)).toBe(false)
  })

  it('trifft den Teilbaum des Ziel-Ordners, nicht Nachbarn, Eltern oder lose Boards', () => {
    const target = { kind: 'folder', folderId: 'f2' } as const
    expect(isBoardInApiKeyTarget(target, { id: 'b', workspaceId: 'w-1', folderId: 'f2' }, baum)).toBe(true)
    expect(isBoardInApiKeyTarget(target, { id: 'b', workspaceId: 'w-1', folderId: 'f3' }, baum)).toBe(true)
    expect(isBoardInApiKeyTarget(target, { id: 'b', workspaceId: 'w-1', folderId: 'f1' }, baum)).toBe(false)
    expect(isBoardInApiKeyTarget(target, { id: 'b', workspaceId: 'w-1', folderId: 'f9' }, baum)).toBe(false)
    expect(isBoardInApiKeyTarget(target, { id: 'b', workspaceId: 'w-1', folderId: null }, baum)).toBe(false)
  })
})

describe('Subjekt', () => {
  it('erhaelt nie die Systemadmin-Hochstufung', () => {
    const admin = nutzer(true)
    const resolved = resolveApiKey({ key: schluessel(), user: admin, access: 'edit' }, NOW)
    expect(resolved?.subject.isSystemAdmin).toBe(false)
    expect(apiKeySubject(admin).isSystemAdmin).toBe(false)

    // Control against the policy: the raw admin would be owner, the subject without membership sees nothing.
    const state = { status: 'active' } as const
    const roh = { user: admin, workspaceRole: null }
    expect(decideWorkspaceAccess(roh, state, { kind: 'workspace:archive' }).allowed).toBe(true)
    const subjekt = { user: apiKeySubject(admin), workspaceRole: null }
    expect(decideWorkspaceAccess(subjekt, state, { kind: 'workspace:archive' }).allowed).toBe(false)
  })
})

describe('Key-Wert', () => {
  it('hat Praefix cvz_, 43 Zeichen base64url und einen 64-stelligen Hex-Hash', () => {
    const value = createApiKeyValue()
    expect(value).toMatch(/^cvz_[A-Za-z0-9_-]{43}$/)
    expect(isApiKeyValueWellFormed(value)).toBe(true)
    expect(isApiKeyValueWellFormed('cvz_kurz')).toBe(false)
    expect(hashApiKeyValue(value)).toMatch(/^[0-9a-f]{64}$/)
    expect(createApiKeyValue()).not.toBe(value)
  })
})
