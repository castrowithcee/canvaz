/** Automation API: key authentication, target semantics and error format against a real PostgreSQL. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { WORKSPACES_PATH } from '../../src/contracts/api.js'
import {
  API_V1_BOARD_METADATA_PATH,
  API_V1_BOARDS_PATH,
  API_V1_FOLDERS_PATH,
  API_V1_WORKSPACES_PATH,
} from '../../src/contracts/api-v1.js'
import type { ApiKeyTarget } from '../../src/domain/identity/api-key.js'
import { displayPrefixOf } from '../../src/domain/identity/api-key.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { createApiKeyValue, hashApiKeyValue } from '../../src/server/api-key-secret.js'
import { signedInAsSystemAdmin } from '../support/local-accounts.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

const DAY = 24 * 60 * 60 * 1000

let pool: Pool
let app: TestApp

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  await migrate(pool)
  app = await startTestApp({ pool, databaseUrl: DATABASE_URL })
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces, login_throttle, user_audit_events cascade')
  app.clearLogs()
  app.setNow(null)
})

async function user(options: { readonly isSystemAdmin?: boolean } = {}) {
  const created = await app.store.users.create(
    { displayName: 'Ada', email: null },
    { isSystemAdmin: options.isSystemAdmin ?? false },
  )
  await app.store.apiKeys.setAccess(created.id, 'read')
  return created
}

async function keyFor(userId: string, target: ApiKeyTarget, expiresAt = new Date(Date.now() + 30 * DAY)) {
  const value = createApiKeyValue()
  const key = await app.store.apiKeys.create({
    userId,
    name: 'CI',
    target,
    level: 'read',
    expiresAt,
    prefix: displayPrefixOf(value),
    keyHash: hashApiKeyValue(value),
  })
  return { key, value }
}

/** Workspace with `Oben > Unten`, `Daneben`, and one board at the root, in `Unten` and in `Daneben`. */
async function bestand() {
  const owner = await user()
  const workspace = await app.workspaces.workspaces.create('W', owner.id)
  const oben = await app.workspaces.folders.create(workspace.id, null, 'Oben')
  const unten = await app.workspaces.folders.create(workspace.id, oben.id, 'Unten')
  const daneben = await app.workspaces.folders.create(workspace.id, null, 'Daneben')
  const wurzel = await app.boards.boards.create(workspace.id, 'Wurzel', owner.id, null)
  const tief = await app.boards.boards.create(workspace.id, 'Tief', owner.id, unten.id)
  const nebenan = await app.boards.boards.create(workspace.id, 'Nebenan', owner.id, daneben.id)
  return { owner, workspace, oben, unten, daneben, wurzel, tief, nebenan }
}

async function get(path: string, value: string | null, query: Record<string, string> = {}) {
  const url = new URL(`${app.baseUrl}${path}`)
  for (const [name, entry] of Object.entries(query)) {
    url.searchParams.set(name, entry)
  }
  const response = await fetch(url, { headers: value === null ? {} : { authorization: `Bearer ${value}` } })
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> }
}

function ids(body: Record<string, unknown>, field: string): string[] {
  return (body[field] as { id: string }[]).map((entry) => entry.id).sort()
}

describe('Authentisierung', () => {
  it('nimmt das Sitzungscookie auf /api/v1 nicht an', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const response = await admin.jar.fetch(`${app.baseUrl}${API_V1_WORKSPACES_PATH}`)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'unauthorized', message: expect.any(String) as string })
  })

  it('nimmt einen Key auf internen Routen nicht an', async () => {
    const { owner, workspace } = await bestand()
    const { value } = await keyFor(owner.id, { kind: 'workspace', workspaceId: workspace.id })
    const response = await fetch(`${app.baseUrl}${WORKSPACES_PATH}`, { headers: { authorization: `Bearer ${value}` } })
    expect(response.status).toBe(401)
  })

  it('antwortet auf fehlenden, unbekannten, abgelaufenen, widerrufenen, abgeschalteten Key und inaktiven User gleich', async () => {
    const { workspace } = await bestand()
    const target: ApiKeyTarget = { kind: 'workspace', workspaceId: workspace.id }
    const widerrufen = await keyFor((await user()).id, target)
    await app.store.apiKeys.revoke(widerrufen.key.id, new Date())
    const abgeschaltet = await user()
    const abgeschaltetKey = await keyFor(abgeschaltet.id, target)
    await app.store.apiKeys.setAccess(abgeschaltet.id, 'off')
    const inaktiv = await user()
    const inaktivKey = await keyFor(inaktiv.id, target)
    await app.store.users.setStatus(inaktiv.id, 'deactivated')
    const abgelaufen = await keyFor((await user()).id, target, new Date(Date.now() + 60_000))

    const antworten = [
      await get(API_V1_WORKSPACES_PATH, null),
      await get(API_V1_WORKSPACES_PATH, createApiKeyValue()),
      await get(API_V1_WORKSPACES_PATH, widerrufen.value),
      await get(API_V1_WORKSPACES_PATH, abgeschaltetKey.value),
      await get(API_V1_WORKSPACES_PATH, inaktivKey.value),
    ]
    app.setNow(new Date(Date.now() + 120_000))
    antworten.push(await get(API_V1_WORKSPACES_PATH, abgelaufen.value))

    for (const antwort of antworten) {
      expect([antwort.status, antwort.body]).toEqual([401, antworten[0]?.body])
    }
  })
})

describe('Ziel', () => {
  it('Workspace-Key: der Workspace, alle Ordner und Boards; ein fremder Workspace ist 404', async () => {
    const b = await bestand()
    const fremd = await app.workspaces.workspaces.create('Fremd', b.owner.id)
    const { value } = await keyFor(b.owner.id, { kind: 'workspace', workspaceId: b.workspace.id })

    expect(ids((await get(API_V1_WORKSPACES_PATH, value)).body, 'workspaces')).toEqual([b.workspace.id])
    expect(ids((await get(API_V1_FOLDERS_PATH, value, { workspaceId: b.workspace.id })).body, 'folders')).toEqual(
      [b.oben.id, b.unten.id, b.daneben.id].sort(),
    )
    expect(ids((await get(API_V1_BOARDS_PATH, value, { workspaceId: b.workspace.id })).body, 'boards')).toEqual(
      [b.wurzel.id, b.tief.id, b.nebenan.id].sort(),
    )
    const aussen = await get(API_V1_FOLDERS_PATH, value, { workspaceId: fremd.id })
    expect(aussen.status).toBe(404)
    expect(aussen.body).toEqual((await get(API_V1_FOLDERS_PATH, value, { workspaceId: crypto.randomUUID() })).body)
  })

  it('Ordner-Key: Teilbaum und dessen Boards; Board ausserhalb ist 404', async () => {
    const b = await bestand()
    const { value } = await keyFor(b.owner.id, { kind: 'folder', folderId: b.oben.id })
    const query = { workspaceId: b.workspace.id }

    expect(ids((await get(API_V1_WORKSPACES_PATH, value)).body, 'workspaces')).toEqual([b.workspace.id])
    expect(ids((await get(API_V1_FOLDERS_PATH, value, query)).body, 'folders')).toEqual([b.oben.id, b.unten.id].sort())
    expect(ids((await get(API_V1_BOARDS_PATH, value, query)).body, 'boards')).toEqual([b.tief.id])
    expect((await get(API_V1_BOARDS_PATH, value, { ...query, folderId: 'root' })).status).toBe(404)
    expect((await get(API_V1_BOARD_METADATA_PATH, value, { boardId: b.tief.id })).status).toBe(200)
    expect((await get(API_V1_BOARD_METADATA_PATH, value, { boardId: b.nebenan.id })).status).toBe(404)
  })

  it('Board-Key: keine Ordner, genau dieses Board', async () => {
    const b = await bestand()
    const { value } = await keyFor(b.owner.id, { kind: 'board', boardId: b.tief.id })
    const query = { workspaceId: b.workspace.id }

    expect(ids((await get(API_V1_WORKSPACES_PATH, value)).body, 'workspaces')).toEqual([b.workspace.id])
    expect((await get(API_V1_FOLDERS_PATH, value, query)).body).toEqual({ folders: [] })
    expect(ids((await get(API_V1_BOARDS_PATH, value, query)).body, 'boards')).toEqual([b.tief.id])
    const board = await get(API_V1_BOARD_METADATA_PATH, value, { boardId: b.tief.id })
    expect(board.body).toMatchObject({ board: { id: b.tief.id, folderId: b.unten.id, title: 'Tief' } })
    expect((await get(API_V1_BOARD_METADATA_PATH, value, { boardId: b.wurzel.id })).status).toBe(404)
  })

  it('Key eines Systemadmins ohne Mitgliedschaft sieht den fremden Workspace nicht', async () => {
    const b = await bestand()
    const admin = await user({ isSystemAdmin: true })
    const { value } = await keyFor(admin.id, { kind: 'workspace', workspaceId: b.workspace.id })

    expect((await get(API_V1_WORKSPACES_PATH, value)).body).toEqual({ workspaces: [] })
    expect((await get(API_V1_BOARDS_PATH, value, { workspaceId: b.workspace.id })).status).toBe(404)
    expect((await get(API_V1_BOARD_METADATA_PATH, value, { boardId: b.wurzel.id })).status).toBe(404)
  })
})

describe('Fehlerformat, Grenzen und Protokoll', () => {
  it('antwortet auf unbekannte Pfade mit JSON-404 und auf falsche Methoden mit 405', async () => {
    const unbekannt = await get(`${API_V1_WORKSPACES_PATH}/gibt-es-nicht`, null)
    expect(unbekannt.status).toBe(404)
    expect(unbekannt.body).toMatchObject({ code: 'not_found' })

    const methode = await fetch(`${app.baseUrl}${API_V1_WORKSPACES_PATH}`, { method: 'POST' })
    expect(methode.status).toBe(405)
    expect(await methode.json()).toMatchObject({ code: 'method_not_allowed' })
  })

  it('begrenzt die Rate je Key mit 429 und retry-after', async () => {
    const eng = await startTestApp({
      pool,
      databaseUrl: DATABASE_URL,
      env: { CANVAZ_API_KEY_RATE_LIMIT_PER_MINUTE: '10' },
    })
    try {
      const { owner, workspace } = await bestand()
      const { value } = await keyFor(owner.id, { kind: 'workspace', workspaceId: workspace.id })
      const headers = { authorization: `Bearer ${value}` }
      for (let i = 0; i < 10; i += 1) {
        expect((await fetch(`${eng.baseUrl}${API_V1_WORKSPACES_PATH}`, { headers })).status).toBe(200)
      }
      const gebremst = await fetch(`${eng.baseUrl}${API_V1_WORKSPACES_PATH}`, { headers })
      expect(gebremst.status).toBe(429)
      expect(gebremst.headers.get('retry-after')).toMatch(/^\d+$/)
      expect(await gebremst.json()).toMatchObject({ code: 'rate_limited' })
    } finally {
      await eng.close()
    }
  })

  it('schreibt den Key-Wert nie ins Protokoll und last_used_at hoechstens einmal je Minute', async () => {
    const { owner, workspace } = await bestand()
    const { key, value } = await keyFor(owner.id, { kind: 'workspace', workspaceId: workspace.id })

    await get(API_V1_WORKSPACES_PATH, value)
    const erste = (await app.store.apiKeys.listForUser(owner.id)).find((entry) => entry.id === key.id)?.lastUsedAt
    await get(API_V1_BOARD_METADATA_PATH, value, { boardId: crypto.randomUUID() })
    await get(API_V1_WORKSPACES_PATH, `${value}x`)
    const zweite = (await app.store.apiKeys.listForUser(owner.id)).find((entry) => entry.id === key.id)?.lastUsedAt

    expect(erste).toBeInstanceOf(Date)
    expect(zweite).toEqual(erste)
    const protokoll = JSON.stringify(app.logs)
    expect(protokoll).not.toContain(value)
    expect(protokoll).not.toContain('Bearer')
  })
})
