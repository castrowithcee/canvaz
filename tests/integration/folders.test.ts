/**
 * Ordner eines Arbeitsbereichs gegen die echte Anwendung und eine echte Datenbank.
 *
 * Es gibt keinen verkuerzten Weg an den Guards vorbei: jeder Test meldet sich ueber den echten Anmeldefluss
 * an und spricht danach dieselben HTTP-Endpunkte an wie die SPA - samt CSRF-Token und Session-Cookie.
 *
 * Geprueft wird, was die Ordnung zusagt: ein Team formt sie selbst, jedes Board liegt in genau einem Ordner
 * oder unmittelbar im Arbeitsbereich, die Liste folgt der Wahl, beim Entfernen geht kein Board verloren,
 * und **keine Berechtigung aendert sich dadurch**.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  BOARD_FOLDER_PATH,
  BOARD_FOLDER_PARAM,
  BOARD_FOLDER_ROOT,
  BOARD_ID_PARAM,
  BOARD_SCENE_PATH,
  BOARDS_PATH,
  FOLDER_MOVE_PATH,
  FOLDER_REMOVE_PATH,
  FOLDER_RENAME_PATH,
  FOLDERS_PATH,
  WORKSPACE_ID_PARAM,
  WORKSPACE_MEMBER_ADD_PATH,
} from '../../src/contracts/api.js'
import type {
  BoardView,
  BoardsResponse,
  FolderView,
  FoldersResponse,
  RemoveFolderResponse,
} from '../../src/contracts/api.js'
import { MAX_FOLDER_DEPTH } from '../../src/domain/folder/model.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import type { Account } from '../support/board-fixture.js'
import { createBoard, createWorkspace, post, signedInAs } from '../support/board-fixture.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

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

beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
  provider.resetBehaviour()
  app.clearLogs()
})

function get(account: Account, path: string, params: Record<string, string>): Promise<Response> {
  return account.jar.fetch(`${app.baseUrl}${path}?${new URLSearchParams(params).toString()}`)
}

async function createFolder(
  account: Account,
  workspaceId: string,
  name: string,
  parentId: string | null = null,
): Promise<FolderView> {
  const response = await post(app, account, FOLDERS_PATH, { workspaceId, name, parentId })
  expect(response.status).toBe(201)
  return (await response.json()) as FolderView
}

async function listFolders(account: Account, workspaceId: string): Promise<readonly FolderView[]> {
  const response = await get(account, FOLDERS_PATH, { [WORKSPACE_ID_PARAM]: workspaceId })
  expect(response.status).toBe(200)
  return ((await response.json()) as FoldersResponse).folders
}

async function listBoards(
  account: Account,
  workspaceId: string,
  folder?: string,
): Promise<readonly BoardView[]> {
  const params: Record<string, string> = { [WORKSPACE_ID_PARAM]: workspaceId }
  if (folder !== undefined) {
    params[BOARD_FOLDER_PARAM] = folder
  }
  const response = await get(account, BOARDS_PATH, params)
  expect(response.status).toBe(200)
  return ((await response.json()) as BoardsResponse).boards
}

/** Ada besitzt den Arbeitsbereich, Bob ist einfaches Mitglied. */
async function team() {
  const ada = await signedInAs(app, 'ada')
  const bob = await signedInAs(app, 'bob')
  const workspace = await createWorkspace(app, ada, 'Team Nord')
  const added = await post(app, ada, WORKSPACE_MEMBER_ADD_PATH, {
    workspaceId: workspace.id,
    userId: bob.profile.user.id,
    role: 'member',
  })
  expect(added.status).toBe(201)
  return { ada, bob, workspace }
}

describe('Ordner eines Arbeitsbereichs', () => {
  it('legt einen Ordner an und zeigt ihn im Baum', async () => {
    const { ada, workspace } = await team()
    const kunden = await createFolder(ada, workspace.id, 'Kunden')

    expect(kunden.parentId).toBeNull()
    expect(await listFolders(ada, workspace.id)).toEqual([kunden])
  })

  it('benennt einen Ordner um', async () => {
    const { ada, workspace } = await team()
    const kunden = await createFolder(ada, workspace.id, 'Kunden')

    const response = await post(app, ada, FOLDER_RENAME_PATH, { folderId: kunden.id, name: 'Kunden Nord' })
    expect(response.status).toBe(200)
    expect(((await response.json()) as FolderView).name).toBe('Kunden Nord')
    expect((await listFolders(ada, workspace.id)).map((entry) => entry.name)).toEqual(['Kunden Nord'])
  })

  it('verschachtelt einen Ordner unter einem anderen und begrenzt die Tiefe', async () => {
    const { ada, workspace } = await team()
    const kunden = await createFolder(ada, workspace.id, 'Kunden')
    const angebote = await createFolder(ada, workspace.id, 'Angebote')

    const response = await post(app, ada, FOLDER_MOVE_PATH, { folderId: angebote.id, parentId: kunden.id })
    expect(response.status).toBe(200)
    expect(((await response.json()) as FolderView).parentId).toBe(kunden.id)

    // Bis zur Grenze geht es weiter, darueber hinaus nicht - und die Ablehnung nennt ihren Grund.
    let parentId = angebote.id
    for (let ebene = 3; ebene <= MAX_FOLDER_DEPTH; ebene += 1) {
      parentId = (await createFolder(ada, workspace.id, `Ebene ${String(ebene)}`, parentId)).id
    }
    const zuTief = await post(app, ada, FOLDERS_PATH, { workspaceId: workspace.id, name: 'Zuviel', parentId })
    expect(zuTief.status).toBe(409)
  })

  it('entfernt einen leeren Ordner', async () => {
    const { ada, workspace } = await team()
    const kunden = await createFolder(ada, workspace.id, 'Kunden')

    const response = await post(app, ada, FOLDER_REMOVE_PATH, { folderId: kunden.id })
    expect(response.status).toBe(200)
    expect((await response.json()) as RemoveFolderResponse).toMatchObject({ movedFolders: 0, movedBoards: 0 })
    expect(await listFolders(ada, workspace.id)).toEqual([])
  })

  it('loest einen nicht leeren Ordner auf, ohne ein Board zu verlieren', async () => {
    const { ada, workspace } = await team()
    const kunden = await createFolder(ada, workspace.id, 'Kunden')
    const nord = await createFolder(ada, workspace.id, 'Nord', kunden.id)
    const board = await createBoard(app, ada, workspace.id, 'Skizze')
    expect((await post(app, ada, BOARD_FOLDER_PATH, { boardId: board.id, folderId: kunden.id })).status).toBe(200)

    const response = await post(app, ada, FOLDER_REMOVE_PATH, { folderId: kunden.id })
    expect(response.status).toBe(200)
    expect((await response.json()) as RemoveFolderResponse).toMatchObject({
      parentId: null,
      movedFolders: 1,
      movedBoards: 1,
    })

    // Der Unterordner steht jetzt unmittelbar im Arbeitsbereich, das Board ebenso - und es ist weiterhin da.
    expect(await listFolders(ada, workspace.id)).toEqual([{ ...nord, parentId: null, updatedAt: expect.any(String) }])
    const boards = await listBoards(ada, workspace.id, BOARD_FOLDER_ROOT)
    expect(boards.map((entry) => entry.id)).toEqual([board.id])
    expect(boards[0]?.folderId).toBeNull()
  })

  it('zeigt in der Boardliste genau den gewaehlten Ordner', async () => {
    const { ada, workspace } = await team()
    const kunden = await createFolder(ada, workspace.id, 'Kunden')
    const abgelegt = await createBoard(app, ada, workspace.id, 'Abgelegt')
    const frei = await createBoard(app, ada, workspace.id, 'Frei')
    expect((await post(app, ada, BOARD_FOLDER_PATH, { boardId: abgelegt.id, folderId: kunden.id })).status).toBe(200)

    expect((await listBoards(ada, workspace.id, kunden.id)).map((entry) => entry.id)).toEqual([abgelegt.id])
    expect((await listBoards(ada, workspace.id, BOARD_FOLDER_ROOT)).map((entry) => entry.id)).toEqual([frei.id])
    // Ohne Ordnerwahl bleibt die Liste, was sie vor den Ordnern war: alle Boards des Arbeitsbereichs.
    expect((await listBoards(ada, workspace.id)).map((entry) => entry.id).sort()).toEqual(
      [abgelegt.id, frei.id].sort(),
    )
  })

  it('laesst ein Board ohne Ordnerzuordnung unveraendert erreichbar', async () => {
    const { ada, workspace } = await team()
    const board = await createBoard(app, ada, workspace.id, 'Bestand')

    // Genau der Zustand, den die additive Migration hinterlaesst: die Spalte ist leer.
    const rows = await pool.query<{ folder_id: string | null }>('select folder_id from boards where id = $1', [
      board.id,
    ])
    expect(rows.rows[0]?.folder_id).toBeNull()
    expect(board.folderId).toBeNull()
    expect((await listBoards(ada, workspace.id)).map((entry) => entry.id)).toEqual([board.id])
    expect((await get(ada, BOARD_SCENE_PATH, { [BOARD_ID_PARAM]: board.id })).status).toBe(200)
  })

  it('aendert mit dem Ordner keine Berechtigung', async () => {
    const { ada, bob, workspace } = await team()
    const board = await createBoard(app, ada, workspace.id, 'Skizze')
    const kunden = await createFolder(ada, workspace.id, 'Kunden')
    expect((await post(app, ada, BOARD_FOLDER_PATH, { boardId: board.id, folderId: kunden.id })).status).toBe(200)

    // Bob hat keine eigene Boardrolle. Er sah das Board vorher aus seiner Mitgliedschaft und sieht es
    // danach genauso - im Ordner wie in der ungefilterten Liste.
    expect((await listBoards(bob, workspace.id)).map((entry) => entry.id)).toEqual([board.id])
    expect((await listBoards(bob, workspace.id, kunden.id)).map((entry) => entry.id)).toEqual([board.id])
    expect((await get(bob, BOARD_SCENE_PATH, { [BOARD_ID_PARAM]: board.id })).status).toBe(200)
    // Den Baum liest jedes Mitglied; er nennt ohnehin kein einziges Board.
    expect(await listFolders(bob, workspace.id)).toHaveLength(1)
  })

  it('haelt Ordner an der Arbeitsbereichsgrenze', async () => {
    const { ada, workspace } = await team()
    const carla = await signedInAs(app, 'carla')
    const fremd = await createWorkspace(app, carla, 'Fremd')
    const fremderOrdner = await createFolder(carla, fremd.id, 'Fremd')

    // Ein Ordner eines fremden Arbeitsbereichs ist fuer Ada nicht vorhanden - weder als Elternknoten noch
    // als Ziel eines Boards, und auch der Baum selbst bleibt ihr verschlossen.
    const alsEltern = await post(app, ada, FOLDERS_PATH, {
      workspaceId: workspace.id,
      name: 'Neu',
      parentId: fremderOrdner.id,
    })
    expect(alsEltern.status).toBe(404)

    const board = await createBoard(app, ada, workspace.id, 'Skizze')
    const alsZiel = await post(app, ada, BOARD_FOLDER_PATH, { boardId: board.id, folderId: fremderOrdner.id })
    expect(alsZiel.status).toBe(404)

    expect((await get(ada, FOLDERS_PATH, { [WORKSPACE_ID_PARAM]: fremd.id })).status).toBe(404)
    expect((await post(app, ada, FOLDER_RENAME_PATH, { folderId: fremderOrdner.id, name: 'Meins' })).status).toBe(404)
  })

  it('verweigert einem einfachen Mitglied die Ordnerverwaltung', async () => {
    const { ada, bob, workspace } = await team()
    const kunden = await createFolder(ada, workspace.id, 'Kunden')

    // Ordner sind Struktur des Arbeitsbereichs: lesen darf sie jedes Mitglied, formen seine Verwaltung.
    expect((await post(app, bob, FOLDERS_PATH, { workspaceId: workspace.id, name: 'Eigene', parentId: null })).status).toBe(403)
    expect((await post(app, bob, FOLDER_RENAME_PATH, { folderId: kunden.id, name: 'Anders' })).status).toBe(403)
    expect((await post(app, bob, FOLDER_MOVE_PATH, { folderId: kunden.id, parentId: null })).status).toBe(403)
    expect((await post(app, bob, FOLDER_REMOVE_PATH, { folderId: kunden.id })).status).toBe(403)
    expect(await listFolders(bob, workspace.id)).toHaveLength(1)
  })
})
