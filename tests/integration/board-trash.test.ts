/**
 * Verschieben und Papierkorb gegen die echte Anwendung, echte Verbindungen und eine echte Datenbank.
 *
 * Es gibt keinen verkuerzten Weg an den Guards vorbei: jeder Test meldet sich ueber den echten Anmeldefluss
 * an und spricht dieselben Endpunkte an wie die SPA. Wo ein Test belegt, dass **nichts** zurueckbleibt,
 * liest er unmittelbar aus der Datenbank und aus dem Storage-Port - ein Nachweis ueber denselben Endpunkt,
 * der geloescht hat, belegte nur, dass der Endpunkt mit sich selbst uebereinstimmt.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  ASSET_FILE_ID_PARAM,
  BOARD_ASSETS_PATH,
  BOARD_DASHBOARD_PATH,
  BOARD_EXPORT_PATH,
  BOARD_FOLDER_PATH,
  BOARD_GRANT_ADD_PATH,
  BOARD_GUEST_JOIN_PATH,
  BOARD_GUEST_SESSION_PATH,
  BOARD_ID_PARAM,
  BOARD_SCENE_PATH,
  BOARD_SHARE_LINK_CREATE_PATH,
  BOARD_STATUS_PATH,
  BOARD_TRASH_PATH,
  BOARD_TRASH_PURGE_PATH,
  BOARD_TRASH_RESTORE_PATH,
  BOARD_VERSIONS_PATH,
  BOARD_WORKSPACE_PATH,
  BOARDS_PATH,
  CSRF_HEADER,
  FOLDERS_PATH,
  FOLDER_REMOVE_PATH,
  WORKSPACE_ID_PARAM,
  WORKSPACE_MEMBER_ADD_PATH,
} from '../../src/contracts/api.js'
import type {
  BoardTrashResponse,
  BoardView,
  BoardsResponse,
  CreateBoardShareLinkResponse,
  DashboardResponse,
  FolderView,
  GuestSessionResponse,
  TrashSelectionResponse,
  UploadBoardAssetResponse,
} from '../../src/contracts/api.js'
import { SCENE_SCHEMA_VERSION } from '../../src/contracts/scene.js'
import type { SceneSnapshot } from '../../src/contracts/scene.js'
import { BOARD_ACCESS_REVOKED_CLOSE_CODE } from '../../src/contracts/realtime.js'
import { DEFAULT_APP_STATE } from '../../src/contracts/scene.js'
import { TRASH_RETENTION_DAYS } from '../../src/domain/board/model.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { GUEST_COOKIE } from '../../src/server/guest-session.js'
import { runTrashRetention } from '../../src/server/trash.js'
import type { Account } from '../support/board-fixture.js'
import { createBoard, createWorkspace, post, signedInAs } from '../support/board-fixture.js'
import { createJar } from '../support/browser-client.js'
import type { Jar } from '../support/browser-client.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { openRealtime, ruhe } from '../support/realtime-socket.js'
import type { RealtimeTestClient } from '../support/realtime-socket.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

const MILLISECONDS_PER_DAY = 86_400_000

let pool: Pool
let provider: TestProvider
let app: TestApp

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  try {
    await pool.query('select 1')
  } catch (error) {
    throw new Error(`Keine Testdatenbank unter ${DATABASE_URL}. Zuerst "npm run db:up" ausfuehren.`, { cause: error })
  }
  await migrate(pool)
  provider = await startTestProvider()
  app = await startTestApp({ provider, pool, databaseUrl: DATABASE_URL })
})

afterAll(async () => {
  await app.close()
  await provider.close()
  await pool.end()
})

const clients: RealtimeTestClient[] = []

beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
  provider.resetBehaviour()
  app.clearLogs()
  app.setNow(null)
})

afterEach(async () => {
  app.setNow(null)
  for (const client of clients.splice(0)) {
    client.close()
    await client.closeCode
  }
  for (let versuch = 0; versuch < 100 && app.rooms.roomCount > 0; versuch += 1) {
    await ruhe(10)
  }
})

/* ---------------------------------------------------------------------------------------------------- */
/* Testhilfen                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

function get(account: Account, path: string, params: Record<string, string> = {}): Promise<Response> {
  const query = new URLSearchParams(params).toString()
  return account.jar.fetch(`${app.baseUrl}${path}${query === '' ? '' : `?${query}`}`)
}

async function addMember(owner: Account, workspaceId: string, member: Account, role: string): Promise<void> {
  const response = await post(app, owner, WORKSPACE_MEMBER_ADD_PATH, {
    workspaceId,
    userId: member.profile.user.id,
    role,
  })
  expect(response.status, 'Mitglied aufnehmen').toBe(201)
}

async function createFolder(account: Account, workspaceId: string, name: string): Promise<FolderView> {
  const response = await post(app, account, FOLDERS_PATH, { workspaceId, name, parentId: null })
  expect(response.status, 'Ordner anlegen').toBe(201)
  return (await response.json()) as FolderView
}

async function boardTitles(account: Account, workspaceId: string): Promise<readonly string[]> {
  const response = await get(account, BOARDS_PATH, { [WORKSPACE_ID_PARAM]: workspaceId })
  expect(response.status, 'Boardliste').toBe(200)
  return ((await response.json()) as BoardsResponse).boards.map((board) => board.title)
}

async function trash(account: Account, boardId: string): Promise<Response> {
  return post(app, account, BOARD_TRASH_PATH, { boardId })
}

async function trashList(account: Account, workspaceId: string): Promise<BoardTrashResponse> {
  const response = await get(account, BOARD_TRASH_PATH, { [WORKSPACE_ID_PARAM]: workspaceId })
  expect(response.status, 'Papierkorb').toBe(200)
  return (await response.json()) as BoardTrashResponse
}

async function selection(account: Account, path: string, boardIds: readonly string[]): Promise<TrashSelectionResponse> {
  const response = await post(app, account, path, { boardIds })
  expect(response.status, 'Auswahl').toBe(200)
  return (await response.json()) as TrashSelectionResponse
}

function szene(boardId: string): SceneSnapshot {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    boardId,
    elements: [{ id: 'a', version: 1, versionNonce: 5, type: 'rectangle', x: 1, y: 2, width: 3, height: 4 }],
    appState: DEFAULT_APP_STATE,
    files: {},
    updatedAt: 1,
  }
}

/** Gueltige PNG-Signatur plus beliebiger Rest; fuer die Inhaltspruefung zaehlen nur die ersten Bytes. */
function png(inhalt: string): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(inhalt)])
}

async function uploadAsset(account: Account, boardId: string, fileId: string): Promise<string> {
  const params = new URLSearchParams({ [BOARD_ID_PARAM]: boardId, [ASSET_FILE_ID_PARAM]: fileId })
  const response = await account.jar.fetch(`${app.baseUrl}${BOARD_ASSETS_PATH}?${params.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', [CSRF_HEADER]: account.profile.csrfToken },
    body: png(fileId).slice(),
  })
  expect(response.status, 'Bild hochladen').toBe(201)
  return ((await response.json()) as UploadBoardAssetResponse).file.storageKey
}

type Gast = { readonly jar: Jar; readonly session: GuestSessionResponse }

async function shareLinkToken(owner: Account, boardId: string): Promise<string> {
  const response = await post(app, owner, BOARD_SHARE_LINK_CREATE_PATH, { boardId, role: 'guest-editor' })
  expect(response.status, 'Freigabelink anlegen').toBe(201)
  return new URL(((await response.json()) as CreateBoardShareLinkResponse).url).hash.slice(1)
}

async function joinAsGuest(token: string, displayName: string): Promise<Gast> {
  const jar = createJar()
  const response = await jar.fetch(`${app.baseUrl}${BOARD_GUEST_JOIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, displayName }),
  })
  expect(response.status, 'Gastbeitritt').toBe(201)
  expect(jar.cookies.get(GUEST_COOKIE)).toBeDefined()
  return { jar, session: (await response.json()) as GuestSessionResponse }
}

/** Standardaufbau: Ada besitzt den Arbeitsbereich und das Board, Bob ist einfaches Mitglied. */
async function aufbau() {
  const ada = await signedInAs(app, 'ada')
  const bob = await signedInAs(app, 'bob')
  const workspace = await createWorkspace(app, ada, 'Team Nord')
  await addMember(ada, workspace.id, bob, 'member')
  const board = await createBoard(app, ada, workspace.id, 'Skizze')
  return { ada, bob, workspace, board }
}

async function auditActions(workspaceId: string): Promise<readonly string[]> {
  const events = await app.workspaces.audit.listForWorkspace(workspaceId)
  return events.map((event) => event.action)
}

async function boardRow(boardId: string): Promise<{ deleted_at: Date | null } | undefined> {
  const rows = await pool.query<{ deleted_at: Date | null }>('select deleted_at from boards where id = $1', [boardId])
  return rows.rows[0]
}

async function zaehle(table: string, boardId: string): Promise<number> {
  const rows = await pool.query<{ count: string }>(
    `select count(*) from ${table} where board_id = $1`,
    [boardId],
  )
  return Number(rows.rows[0]?.count ?? '0')
}

/* ---------------------------------------------------------------------------------------------------- */
/* Verschieben                                                                                           */
/* ---------------------------------------------------------------------------------------------------- */

describe('Verschieben eines Boards', () => {
  it('legt ein Board in einen anderen Ordner desselben Arbeitsbereichs', async () => {
    const { ada, workspace, board } = await aufbau()
    const ordner = await createFolder(ada, workspace.id, 'Entwuerfe')

    const response = await post(app, ada, BOARD_FOLDER_PATH, { boardId: board.id, folderId: ordner.id })

    expect(response.status).toBe(200)
    expect(((await response.json()) as BoardView).folderId).toBe(ordner.id)
  })

  it('verweigert die Ordnerablage einer Rolle, die das Board nicht aendern darf', async () => {
    const { ada, bob, workspace, board } = await aufbau()
    const ordner = await createFolder(ada, workspace.id, 'Entwuerfe')
    expect(
      (await post(app, ada, BOARD_GRANT_ADD_PATH, { boardId: board.id, userId: bob.profile.user.id, role: 'viewer' }))
        .status,
    ).toBe(201)

    const response = await post(app, bob, BOARD_FOLDER_PATH, { boardId: board.id, folderId: ordner.id })

    expect(response.status).toBe(403)
  })

  it('verschiebt ein Board in einen anderen Arbeitsbereich und beendet dabei Freigabe und Gastlink', async () => {
    const { ada, bob, workspace, board } = await aufbau()
    expect(
      (await post(app, ada, BOARD_GRANT_ADD_PATH, { boardId: board.id, userId: bob.profile.user.id, role: 'editor' }))
        .status,
    ).toBe(201)
    const gast = await joinAsGuest(await shareLinkToken(ada, board.id), 'Kundin')
    // Ein Bild: Assetdatensatz und Freigabelink fuehren den Workspacebezug doppelt und muessen mitwandern.
    await uploadAsset(ada, board.id, 'bild1')
    const ziel = await createWorkspace(app, ada, 'Team Sued')

    const response = await post(app, ada, BOARD_WORKSPACE_PATH, { boardId: board.id, workspaceId: ziel.id })

    expect(response.status).toBe(200)
    expect(((await response.json()) as BoardView).workspaceId).toBe(ziel.id)
    expect(await boardTitles(ada, workspace.id)).toEqual([])
    expect(await boardTitles(ada, ziel.id)).toEqual(['Skizze'])
    // Die interne Freigabe wandert nicht mit: Bob ist im Ziel kein Mitglied und sieht das Board nicht mehr.
    expect((await get(bob, BOARD_SCENE_PATH, { [BOARD_ID_PARAM]: board.id })).status).toBe(404)
    expect(await zaehle('board_grants', board.id)).toBe(0)
    // Der Gastlink ist widerrufen; seine Gastsession gilt damit nicht mehr.
    expect((await gast.jar.fetch(`${app.baseUrl}${BOARD_GUEST_SESSION_PATH}`)).status).toBe(401)
    // Das Bild bleibt am Board und ist im Ziel unveraendert abrufbar.
    const bild = await get(ada, BOARD_ASSETS_PATH, { [BOARD_ID_PARAM]: board.id, [ASSET_FILE_ID_PARAM]: 'bild1' })
    expect(bild.status).toBe(200)
    const assetWorkspace = await pool.query<{ workspace_id: string }>(
      'select workspace_id from board_assets where board_id = $1',
      [board.id],
    )
    expect(assetWorkspace.rows[0]?.workspace_id).toBe(ziel.id)
    expect(await auditActions(ziel.id)).toContain('board.workspace-changed')
    expect(await auditActions(workspace.id)).toContain('board.workspace-left')
  })

  it('verweigert den Wechsel des Arbeitsbereichs ohne Bestandsverantwortung in der Quelle', async () => {
    const { ada, bob, workspace, board } = await aufbau()
    const ziel = await createWorkspace(app, bob, 'Team Bob')
    await addMember(bob, ziel.id, ada, 'member')

    const response = await post(app, bob, BOARD_WORKSPACE_PATH, { boardId: board.id, workspaceId: ziel.id })

    expect(response.status).toBe(403)
    expect(await boardTitles(ada, workspace.id)).toEqual(['Skizze'])
  })

  it('verweigert den Wechsel in einen Arbeitsbereich ohne eigene Mitgliedschaft', async () => {
    const { ada, board } = await aufbau()
    const carol = await signedInAs(app, 'carol')
    const fremd = await createWorkspace(app, carol, 'Team Carol')

    const response = await post(app, ada, BOARD_WORKSPACE_PATH, { boardId: board.id, workspaceId: fremd.id })

    expect(response.status).toBe(404)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Papierkorb                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

describe('Papierkorb', () => {
  it('nimmt ein geloeschtes Board aus jeder Liste und jedem Zugriffsweg', async () => {
    const { ada, board } = await aufbau()

    expect((await trash(ada, board.id)).status).toBe(200)

    const dashboard = (await (await get(ada, BOARD_DASHBOARD_PATH)).json()) as DashboardResponse
    expect(dashboard.boards).toEqual([])
    expect(await boardTitles(ada, board.workspaceId)).toEqual([])
    for (const path of [BOARD_SCENE_PATH, BOARD_VERSIONS_PATH, BOARD_EXPORT_PATH]) {
      expect((await get(ada, path, { [BOARD_ID_PARAM]: board.id })).status, path).toBe(404)
    }
    // Auch eine Suche nach dem Titel findet es nicht mehr.
    const suche = await get(ada, BOARDS_PATH, { [WORKSPACE_ID_PARAM]: board.workspaceId, q: 'Skizze' })
    expect(((await suche.json()) as BoardsResponse).boards).toEqual([])
    expect(await auditActions(board.workspaceId)).toContain('board.trashed')
  })

  it('beendet interne Freigabe und Gastlink sofort', async () => {
    const { ada, bob, board } = await aufbau()
    expect(
      (await post(app, ada, BOARD_GRANT_ADD_PATH, { boardId: board.id, userId: bob.profile.user.id, role: 'editor' }))
        .status,
    ).toBe(201)
    const gast = await joinAsGuest(await shareLinkToken(ada, board.id), 'Kundin')
    expect((await gast.jar.fetch(`${app.baseUrl}${BOARD_GUEST_SESSION_PATH}`)).status).toBe(200)

    expect((await trash(ada, board.id)).status).toBe(200)

    expect((await get(bob, BOARD_SCENE_PATH, { [BOARD_ID_PARAM]: board.id })).status).toBe(404)
    expect((await gast.jar.fetch(`${app.baseUrl}${BOARD_GUEST_SESSION_PATH}`)).status).toBe(401)
    const szeneAlsGast = await gast.jar.fetch(
      `${app.baseUrl}${BOARD_SCENE_PATH}?${new URLSearchParams({ [BOARD_ID_PARAM]: board.id }).toString()}`,
    )
    expect(szeneAlsGast.status).toBe(404)
  })

  it('zeigt Titel, urspruenglichen Ordner, loeschende Person, Zeitpunkt und verbleibende Frist', async () => {
    const { ada, workspace, board } = await aufbau()
    const ordner = await createFolder(ada, workspace.id, 'Entwuerfe')
    expect((await post(app, ada, BOARD_FOLDER_PATH, { boardId: board.id, folderId: ordner.id })).status).toBe(200)

    expect((await trash(ada, board.id)).status).toBe(200)

    const papierkorb = await trashList(ada, workspace.id)
    expect(papierkorb.retentionDays).toBe(TRASH_RETENTION_DAYS)
    const eintrag = papierkorb.boards[0]
    expect(eintrag?.title).toBe('Skizze')
    expect(eintrag?.folderId).toBe(ordner.id)
    expect(eintrag?.folderName).toBe('Entwuerfe')
    expect(eintrag?.deletedByUserId).toBe(ada.profile.user.id)
    expect(eintrag?.deletedByDisplayName).toBe(ada.profile.user.displayName)
    const frist = Date.parse(eintrag?.purgeAt ?? '') - Date.parse(eintrag?.deletedAt ?? '')
    expect(frist).toBe(TRASH_RETENTION_DAYS * MILLISECONDS_PER_DAY)
  })

  it('bleibt einem Mitglied ohne Bestandsverantwortung vollstaendig verschlossen', async () => {
    const { ada, bob, workspace, board } = await aufbau()
    const zweites = await createBoard(app, ada, workspace.id, 'Zweites')

    // Loeschen darf er schon nicht.
    expect((await trash(bob, zweites.id)).status).toBe(403)
    expect((await trash(ada, board.id)).status).toBe(200)

    expect((await trashList(bob, workspace.id)).boards).toEqual([])
    const wieder = await selection(bob, BOARD_TRASH_RESTORE_PATH, [board.id])
    expect(wieder.results[0]?.ok).toBe(false)
    const endgueltig = await selection(bob, BOARD_TRASH_PURGE_PATH, [board.id])
    expect(endgueltig.results[0]?.ok).toBe(false)
    // Und es liegt weiterhin unveraendert im Papierkorb.
    expect((await trashList(ada, workspace.id)).boards).toHaveLength(1)
  })

  it('schliesst offene Verbindungen, sobald das Board in den Papierkorb wandert', async () => {
    const { ada, board } = await aufbau()
    const client = await openRealtime(app.baseUrl, ada.jar.cookieHeader())
    clients.push(client)
    await client.join(board.id)
    const begonnen = Date.now()

    expect((await trash(ada, board.id)).status).toBe(200)

    expect(await client.closeCode).toBe(BOARD_ACCESS_REVOKED_CLOSE_CODE)
    // Deutlich schneller als die wiederkehrende Nachpruefung: das Schliessen ist ein Ereignis, kein Warten.
    expect(Date.now() - begonnen).toBeLessThan(1500)
  })

  it('stellt ein Board wieder her und behaelt dabei seinen Archivzustand', async () => {
    const { ada, workspace, board } = await aufbau()
    expect((await post(app, ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(200)
    expect((await trash(ada, board.id)).status).toBe(200)

    const ergebnis = await selection(ada, BOARD_TRASH_RESTORE_PATH, [board.id])

    expect(ergebnis.results).toEqual([{ boardId: board.id, ok: true, error: null }])
    expect((await trashList(ada, workspace.id)).boards).toEqual([])
    const archiv = await get(ada, BOARDS_PATH, { [WORKSPACE_ID_PARAM]: workspace.id, status: 'archived' })
    expect(((await archiv.json()) as BoardsResponse).boards.map((entry) => entry.title)).toEqual(['Skizze'])
    expect(await auditActions(workspace.id)).toContain('board.restored')
  })

  it('stellt mehrere Boards zugleich wieder her und legt eines ohne Ordner in den Arbeitsbereich zurueck', async () => {
    const { ada, workspace, board } = await aufbau()
    const zweites = await createBoard(app, ada, workspace.id, 'Zweites')
    const ordner = await createFolder(ada, workspace.id, 'Entwuerfe')
    expect((await post(app, ada, BOARD_FOLDER_PATH, { boardId: board.id, folderId: ordner.id })).status).toBe(200)
    expect((await trash(ada, board.id)).status).toBe(200)
    expect((await trash(ada, zweites.id)).status).toBe(200)
    // Der Zielordner verschwindet, waehrend das Board im Papierkorb liegt.
    expect((await post(app, ada, FOLDER_REMOVE_PATH, { folderId: ordner.id })).status).toBe(200)

    const ergebnis = await selection(ada, BOARD_TRASH_RESTORE_PATH, [board.id, zweites.id])

    expect(ergebnis.results.every((eintrag) => eintrag.ok)).toBe(true)
    const liste = await get(ada, BOARDS_PATH, { [WORKSPACE_ID_PARAM]: workspace.id })
    const boards = ((await liste.json()) as BoardsResponse).boards
    expect(boards.map((entry) => entry.title).sort()).toEqual(['Skizze', 'Zweites'])
    // Ohne den Ordner liegt es unmittelbar im Arbeitsbereich statt in einem Fehler.
    expect(boards.every((entry) => entry.folderId === null)).toBe(true)
  })

  it('laesst beim endgueltigen Loeschen weder Szene, Version, Freigabe, Gastsession noch Bilddatei zurueck', async () => {
    const { ada, bob, workspace, board } = await aufbau()
    expect(
      (await post(app, ada, BOARD_GRANT_ADD_PATH, { boardId: board.id, userId: bob.profile.user.id, role: 'editor' }))
        .status,
    ).toBe(201)
    const storageKey = await uploadAsset(ada, board.id, 'bild1')
    expect(
      (await post(app, ada, BOARD_SCENE_PATH, { boardId: board.id, baseVersion: 0, scene: szene(board.id) })).status,
    ).toBe(200)
    await joinAsGuest(await shareLinkToken(ada, board.id), 'Kundin')
    expect(await app.context.storage.get(storageKey)).not.toBeNull()
    expect((await trash(ada, board.id)).status).toBe(200)

    const ergebnis = await selection(ada, BOARD_TRASH_PURGE_PATH, [board.id])

    expect(ergebnis.results).toEqual([{ boardId: board.id, ok: true, error: null }])
    expect(await boardRow(board.id)).toBeUndefined()
    expect(await zaehle('scene_versions', board.id)).toBe(0)
    expect(await zaehle('board_grants', board.id)).toBe(0)
    expect(await zaehle('board_assets', board.id)).toBe(0)
    expect(await zaehle('board_share_links', board.id)).toBe(0)
    expect(await zaehle('board_guest_sessions', board.id)).toBe(0)
    expect(await app.context.storage.get(storageKey)).toBeNull()
    expect(await auditActions(workspace.id)).toContain('board.purged')
  })

  it('entfernt nach Ablauf der Frist ohne Zutun und laesst ein Board vor Fristende stehen', async () => {
    const { ada, workspace, board } = await aufbau()
    const jung = await createBoard(app, ada, workspace.id, 'Jung')
    const storageKey = await uploadAsset(ada, board.id, 'bild1')
    // Das eine wurde vor mehr als der Frist geloescht, das andere gerade eben.
    app.setNow(new Date(Date.now() - (TRASH_RETENTION_DAYS + 6) * MILLISECONDS_PER_DAY))
    expect((await trash(ada, board.id)).status).toBe(200)
    app.setNow(null)
    expect((await trash(ada, jung.id)).status).toBe(200)

    const entfernt = await runTrashRetention(app.context)

    expect(entfernt).toEqual([board.id])
    expect(await boardRow(board.id)).toBeUndefined()
    expect(await app.context.storage.get(storageKey)).toBeNull()
    expect((await boardRow(jung.id))?.deleted_at).not.toBeNull()
    const events = await app.workspaces.audit.listForWorkspace(workspace.id)
    const nachweis = events.find((event) => event.action === 'board.purged')
    expect(nachweis?.actorId).toBeNull()
    expect(nachweis?.details['reason']).toBe('retention')
  })
})
