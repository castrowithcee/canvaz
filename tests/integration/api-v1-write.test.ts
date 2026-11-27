/** Automation API write operations: target, level and role limits against a real PostgreSQL. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { BOARD_ACCESS_REVOKED_CLOSE_CODE } from '../../src/contracts/realtime.js'
import {
  API_V1_BASE_PATH,
  API_V1_BOARD_MOVE_PATH,
  API_V1_BOARD_RENAME_PATH,
  API_V1_BOARD_RESTORE_PATH,
  API_V1_BOARD_TRASH_PATH,
  API_V1_BOARDS_PATH,
  API_V1_FOLDERS_PATH,
} from '../../src/contracts/api-v1.js'
import type { ApiKeyLevel, ApiKeyTarget } from '../../src/domain/identity/api-key.js'
import { displayPrefixOf } from '../../src/domain/identity/api-key.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { DENIALS } from '../../src/server/board-access.js'
import { createApiKeyValue, hashApiKeyValue } from '../../src/server/api-key-secret.js'
import { teamMitBoard } from '../support/board-fixture.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { openRealtime } from '../support/realtime-socket.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

let pool: Pool
let app: TestApp
let provider: TestProvider

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  await migrate(pool)
  provider = await startTestProvider()
  app = await startTestApp({ provider, pool, databaseUrl: DATABASE_URL })
})

afterAll(async () => {
  await app.close()
  await provider.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces, login_throttle, user_audit_events cascade')
  provider.resetBehaviour()
  app.clearLogs()
  app.setNow(null)
})

async function user() {
  const created = await app.store.users.create({ displayName: 'Ada', email: null }, { isSystemAdmin: false })
  await app.store.apiKeys.setAccess(created.id, 'edit')
  return created
}

async function keyFor(userId: string, target: ApiKeyTarget, level: ApiKeyLevel = 'edit') {
  const value = createApiKeyValue()
  const key = await app.store.apiKeys.create({
    userId,
    name: 'CI',
    target,
    level,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    prefix: displayPrefixOf(value),
    keyHash: hashApiKeyValue(value),
  })
  return { key, value }
}

/** Workspace with `Oben > Unten`, `Daneben`, and one board in `Unten`. */
async function bestand() {
  const owner = await user()
  const workspace = await app.workspaces.workspaces.create('W', owner.id)
  const oben = await app.workspaces.folders.create(workspace.id, null, 'Oben')
  const unten = await app.workspaces.folders.create(workspace.id, oben.id, 'Unten')
  const daneben = await app.workspaces.folders.create(workspace.id, null, 'Daneben')
  const tief = await app.boards.boards.create(workspace.id, 'Tief', owner.id, unten.id)
  const nebenan = await app.boards.boards.create(workspace.id, 'Nebenan', owner.id, daneben.id)
  return { owner, workspace, oben, unten, daneben, tief, nebenan }
}

async function post(path: string, value: string, body: Record<string, unknown>) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('Erfolg', () => {
  it('Ordner-Key legt ein Board im Teilbaum an, das dem User des Keys gehoert; der Nachweis nennt den Key', async () => {
    const b = await bestand()
    const { key, value } = await keyFor(b.owner.id, { kind: 'folder', folderId: b.oben.id })

    const antwort = await post(API_V1_BOARDS_PATH, value, { workspaceId: b.workspace.id, title: '  Neu ', folderId: b.unten.id })

    expect(antwort.status).toBe(201)
    expect(antwort.body).toMatchObject({ board: { workspaceId: b.workspace.id, folderId: b.unten.id, title: 'Neu' } })
    const id = (antwort.body['board'] as { id: string }).id
    const access = await app.boards.boards.findForViewer(id, { kind: 'user', userId: b.owner.id }, new Date())
    expect(access?.board.ownerId).toBe(b.owner.id)
    const events = await app.workspaces.audit.listForWorkspace(b.workspace.id)
    expect(events.find((event) => event.action === 'board.created')).toMatchObject({
      actorId: b.owner.id,
      targetId: id,
      details: { apiKeyId: key.id },
    })
    expect(JSON.stringify(events)).not.toContain(value)
  })

  it('Board-Key benennt sein Board um', async () => {
    const b = await bestand()
    const { value } = await keyFor(b.owner.id, { kind: 'board', boardId: b.tief.id })

    const antwort = await post(API_V1_BOARD_RENAME_PATH, value, { boardId: b.tief.id, title: 'Umbenannt' })

    expect(antwort.status).toBe(200)
    expect(antwort.body).toMatchObject({ board: { id: b.tief.id, title: 'Umbenannt' } })
  })

  it('Workspace-Key verschiebt ein Board in die Wurzel und legt einen Ordner an', async () => {
    const b = await bestand()
    const { value } = await keyFor(b.owner.id, { kind: 'workspace', workspaceId: b.workspace.id })

    const verschoben = await post(API_V1_BOARD_MOVE_PATH, value, { boardId: b.tief.id, folderId: null })
    const ordner = await post(API_V1_FOLDERS_PATH, value, { workspaceId: b.workspace.id, name: 'Neu', parentId: b.daneben.id })

    expect(verschoben.status).toBe(200)
    expect(verschoben.body).toMatchObject({ board: { id: b.tief.id, folderId: null } })
    expect(ordner.status).toBe(201)
    expect(ordner.body).toMatchObject({ folder: { workspaceId: b.workspace.id, parentId: b.daneben.id, name: 'Neu' } })
  })
})

describe('Papierkorb', () => {
  const deletedAtOf = async (boardId: string) =>
    (await pool.query<{ deleted_at: Date | null }>('select deleted_at from boards where id = $1', [boardId])).rows[0]?.deleted_at

  it('Workspace-Key legt ein Board in den Papierkorb und holt es zurueck; der Nachweis nennt den Key', async () => {
    const b = await bestand()
    const { key, value } = await keyFor(b.owner.id, { kind: 'workspace', workspaceId: b.workspace.id })

    const weg = await post(API_V1_BOARD_TRASH_PATH, value, { boardId: b.tief.id })
    const dazwischen = await deletedAtOf(b.tief.id)
    const zurueck = await post(API_V1_BOARD_RESTORE_PATH, value, { boardId: b.tief.id })

    expect(weg.status).toBe(200)
    expect(weg.body).toMatchObject({
      board: { id: b.tief.id, workspaceId: b.workspace.id, folderId: b.unten.id, title: 'Tief' },
    })
    expect(Object.keys(weg.body['board'] as object)).toEqual(expect.arrayContaining(['deletedAt', 'purgeAt']))
    expect(dazwischen).not.toBeNull()
    expect(zurueck.status).toBe(200)
    expect(zurueck.body).toMatchObject({ board: { id: b.tief.id, folderId: b.unten.id }, leftTarget: false })
    expect(await deletedAtOf(b.tief.id)).toBeNull()
    const events = await app.workspaces.audit.listForWorkspace(b.workspace.id)
    for (const action of ['board.trashed', 'board.restored']) {
      expect(events.find((event) => event.action === action)).toMatchObject({
        actorId: b.owner.id,
        targetId: b.tief.id,
        details: { apiKeyId: key.id },
      })
    }
  })

  it('schliesst beim Papierkorb die offenen Verbindungen des Boards', async () => {
    const { ada, board } = await teamMitBoard(app)
    await app.store.apiKeys.setAccess(ada.profile.user.id, 'edit')
    const { value } = await keyFor(ada.profile.user.id, { kind: 'board', boardId: board.id })
    const client = await openRealtime(app.baseUrl, ada.jar.cookieHeader())
    await client.join(board.id)

    expect((await post(API_V1_BOARD_TRASH_PATH, value, { boardId: board.id })).status).toBe(200)

    expect(await client.closeCode).toBe(BOARD_ACCESS_REVOKED_CLOSE_CODE)
  })

  it('Member ohne Owner-Rolle erhaelt die interne Ablehnung, und das Board bleibt', async () => {
    const { bob, board } = await teamMitBoard(app)
    await app.store.apiKeys.setAccess(bob.profile.user.id, 'edit')
    const { value } = await keyFor(bob.profile.user.id, { kind: 'board', boardId: board.id })

    const antwort = await post(API_V1_BOARD_TRASH_PATH, value, { boardId: board.id })

    expect([antwort.status, antwort.body]).toEqual([
      403,
      { code: 'forbidden', message: DENIALS['insufficient-role'].message },
    ])
    expect(await deletedAtOf(board.id)).toBeNull()
  })

  it('Purge und Archivieren sind unter /api/v1 nicht erreichbar', async () => {
    const b = await bestand()
    const { value } = await keyFor(b.owner.id, { kind: 'workspace', workspaceId: b.workspace.id })
    await post(API_V1_BOARD_TRASH_PATH, value, { boardId: b.tief.id })

    for (const path of ['/boards/purge', '/boards/trash/purge', '/trash/purge', '/boards/archive']) {
      const antwort = await post(`${API_V1_BASE_PATH}${path}`, value, { boardId: b.tief.id, boardIds: [b.tief.id] })
      expect([antwort.status, antwort.body['code']]).toEqual([404, 'not_found'])
    }
    expect(await deletedAtOf(b.tief.id)).not.toBeNull()
  })

  it('Ordner-Key: Board ausserhalb, erfundene Kennung und falscher Zustand ergeben dieselbe 404', async () => {
    const b = await bestand()
    const aussen = await app.boards.boards.create(b.workspace.id, 'Aussen', b.owner.id, b.daneben.id)
    await app.boards.transaction((tx) => tx.boards.moveToTrash(aussen.id, new Date(), b.owner.id))
    const { value } = await keyFor(b.owner.id, { kind: 'folder', folderId: b.oben.id })

    const antworten = [
      await post(API_V1_BOARD_TRASH_PATH, value, { boardId: b.nebenan.id }),
      await post(API_V1_BOARD_RESTORE_PATH, value, { boardId: aussen.id }),
      await post(API_V1_BOARD_TRASH_PATH, value, { boardId: crypto.randomUUID() }),
      await post(API_V1_BOARD_RESTORE_PATH, value, { boardId: crypto.randomUUID() }),
      // Im Ziel, aber nicht im passenden Zustand.
      await post(API_V1_BOARD_RESTORE_PATH, value, { boardId: b.tief.id }),
      await post(API_V1_BOARD_TRASH_PATH, value, { boardId: 'kaputt' }),
    ]
    await post(API_V1_BOARD_TRASH_PATH, value, { boardId: b.tief.id })
    antworten.push(await post(API_V1_BOARD_TRASH_PATH, value, { boardId: b.tief.id }))

    for (const antwort of antworten) {
      expect([antwort.status, antwort.body]).toEqual([404, { code: 'not_found', message: 'Nicht gefunden' }])
    }
  })

  it('Lese-Key ergibt 403', async () => {
    const b = await bestand()
    const { value } = await keyFor(b.owner.id, { kind: 'workspace', workspaceId: b.workspace.id }, 'read')

    const antwort = await post(API_V1_BOARD_TRASH_PATH, value, { boardId: b.tief.id })

    expect([antwort.status, antwort.body['code']]).toEqual([403, 'forbidden'])
  })
})

describe('Grenzen', () => {
  it('Ordner-Key: Anlegen und Verschieben ausserhalb des Teilbaums ergeben 404', async () => {
    const b = await bestand()
    const { value } = await keyFor(b.owner.id, { kind: 'folder', folderId: b.oben.id })
    const workspaceId = b.workspace.id

    const antworten = [
      await post(API_V1_BOARDS_PATH, value, { workspaceId, title: 'X', folderId: b.daneben.id }),
      await post(API_V1_BOARDS_PATH, value, { workspaceId, title: 'X' }),
      await post(API_V1_FOLDERS_PATH, value, { workspaceId, name: 'X', parentId: b.daneben.id }),
      await post(API_V1_BOARD_MOVE_PATH, value, { boardId: b.tief.id, folderId: b.daneben.id }),
      await post(API_V1_BOARD_MOVE_PATH, value, { boardId: b.tief.id, folderId: null }),
    ]

    for (const antwort of antworten) {
      expect([antwort.status, antwort.body]).toEqual([404, { code: 'not_found', message: 'Nicht gefunden' }])
    }
  })

  it('Board-Key kann kein Board anlegen', async () => {
    const b = await bestand()
    const { value } = await keyFor(b.owner.id, { kind: 'board', boardId: b.tief.id })

    const antwort = await post(API_V1_BOARDS_PATH, value, { workspaceId: b.workspace.id, title: 'X', folderId: b.unten.id })

    expect(antwort.status).toBe(404)
  })

  it('Member ohne folder:manage kann keinen Ordner anlegen', async () => {
    const b = await bestand()
    const member = await user()
    await app.workspaces.workspaces.addMember(b.workspace.id, member.id, 'member')
    const { value } = await keyFor(member.id, { kind: 'workspace', workspaceId: b.workspace.id })

    const antwort = await post(API_V1_FOLDERS_PATH, value, { workspaceId: b.workspace.id, name: 'X' })

    expect(antwort.status).toBe(403)
    expect(antwort.body).toMatchObject({ code: 'forbidden' })
  })

  it('Lese-Key ergibt 403', async () => {
    const b = await bestand()
    const { value } = await keyFor(b.owner.id, { kind: 'workspace', workspaceId: b.workspace.id }, 'read')

    const antwort = await post(API_V1_BOARD_RENAME_PATH, value, { boardId: b.tief.id, title: 'X' })

    expect(antwort.status).toBe(403)
    expect(antwort.body).toMatchObject({ code: 'forbidden' })
  })
})
