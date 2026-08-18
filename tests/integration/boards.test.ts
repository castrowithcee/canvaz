/**
 * Boards, Szenenpersistenz und Autorisierung gegen die echte Anwendung und eine echte Datenbank.
 *
 * Es gibt keinen verkuerzten Weg an den Guards vorbei: jeder Test meldet sich ueber den echten OIDC-Fluss an
 * und spricht danach dieselben HTTP-Endpunkte an wie die SPA - samt CSRF-Token und Session-Cookie.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  ADMIN_USER_STATUS_PATH,
  BOARD_ID_PARAM,
  BOARD_QUERY_PARAM,
  BOARD_RENAME_PATH,
  BOARD_SCENE_PATH,
  BOARD_STATUS_PARAM,
  BOARD_STATUS_PATH,
  BOARDS_PATH,
  CSRF_HEADER,
  ME_PATH,
  WORKSPACE_ID_PARAM,
  WORKSPACE_MEMBER_ADD_PATH,
  WORKSPACE_STATUS_PATH,
  WORKSPACES_PATH,
} from '../../src/contracts/api.js'
import type {
  BoardSceneResponse,
  BoardView,
  BoardsResponse,
  MeResponse,
  SaveSceneResponse,
  SceneConflictResponse,
  WorkspaceView,
} from '../../src/contracts/api.js'
import type { SceneSnapshot } from '../../src/contracts/scene.js'
import { SCENE_SCHEMA_VERSION } from '../../src/contracts/scene.js'
import { SCENE_VERSION_RETENTION } from '../../src/domain/board/model.js'
import type { WorkspaceRole } from '../../src/domain/workspace/model.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { createJar } from '../support/browser-client.js'
import type { Jar } from '../support/browser-client.js'
import { login } from '../support/login-flow.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

/** Eine erfundene, gueltig geformte Kennung. Sie darf sich von einer fremden nicht unterscheiden lassen. */
const FREMDE_KENNUNG = '00000000-0000-4000-8000-000000000000'

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

type Account = { readonly jar: Jar; readonly profile: MeResponse }

async function signedInAs(subject: string): Promise<Account> {
  const jar = createJar()
  const result = await login(app, jar, { subject })
  expect(result.error).toBeNull()
  const response = await jar.fetch(`${app.baseUrl}${ME_PATH}`)
  expect(response.status).toBe(200)
  return { jar, profile: (await response.json()) as MeResponse }
}

function post(account: Account, path: string, body: unknown, options: { csrf?: boolean } = {}): Promise<Response> {
  return account.jar.fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.csrf === false ? {} : { [CSRF_HEADER]: account.profile.csrfToken }),
    },
    body: JSON.stringify(body),
  })
}

function get(account: Account, path: string, params: Record<string, string>): Promise<Response> {
  return account.jar.fetch(`${app.baseUrl}${path}?${new URLSearchParams(params).toString()}`)
}

async function createWorkspace(account: Account, name: string): Promise<WorkspaceView> {
  const response = await post(account, WORKSPACES_PATH, { name })
  expect(response.status).toBe(201)
  return (await response.json()) as WorkspaceView
}

async function addMember(owner: Account, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
  const response = await post(owner, WORKSPACE_MEMBER_ADD_PATH, { workspaceId, userId, role })
  expect(response.status).toBe(201)
}

async function createBoard(account: Account, workspaceId: string, title: string): Promise<BoardView> {
  const response = await post(account, BOARDS_PATH, { workspaceId, title })
  expect(response.status).toBe(201)
  return (await response.json()) as BoardView
}

async function listBoards(
  account: Account,
  workspaceId: string,
  options: { status?: string; q?: string } = {},
): Promise<readonly BoardView[]> {
  const params: Record<string, string> = { [WORKSPACE_ID_PARAM]: workspaceId }
  if (options.status !== undefined) {
    params[BOARD_STATUS_PARAM] = options.status
  }
  if (options.q !== undefined) {
    params[BOARD_QUERY_PARAM] = options.q
  }
  const response = await get(account, BOARDS_PATH, params)
  expect(response.status).toBe(200)
  return ((await response.json()) as BoardsResponse).boards
}

function openBoard(account: Account, boardId: string): Promise<Response> {
  return get(account, BOARD_SCENE_PATH, { [BOARD_ID_PARAM]: boardId })
}

async function loadScene(account: Account, boardId: string): Promise<BoardSceneResponse> {
  const response = await openBoard(account, boardId)
  expect(response.status).toBe(200)
  return (await response.json()) as BoardSceneResponse
}

function saveScene(
  account: Account,
  boardId: string,
  baseVersion: number,
  scene: SceneSnapshot,
  options: { csrf?: boolean } = {},
): Promise<Response> {
  return post(account, BOARD_SCENE_PATH, { boardId, baseVersion, scene }, options)
}

/**
 * Szene mit allem, was verlustfrei durch die Persistenz kommen muss: Text, Bindings, Gruppen, Frames,
 * Bildreferenzen und Felder, die dieser Vertrag gar nicht kennt.
 */
function reicheSzene(boardId: string): SceneSnapshot {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    boardId,
    elements: [
      {
        id: 'frame-1',
        type: 'frame',
        version: 4,
        versionNonce: 555,
        name: 'Rahmen Nord',
        children: ['rect-1'],
        x: -10,
        y: -10,
        width: 400,
        height: 300,
      },
      {
        id: 'rect-1',
        type: 'rectangle',
        version: 12,
        versionNonce: 884_211,
        isDeleted: false,
        x: 12.5,
        y: -40.25,
        width: 200,
        height: 100,
        groupIds: ['group-a', 'group-b'],
        frameId: 'frame-1',
        roundness: { type: 3 },
        boundElements: [
          { id: 'arrow-1', type: 'arrow' },
          { id: 'text-1', type: 'text' },
        ],
        // Ein Feld, das der Vertrag nicht kennt: ein kuenftiges Excalidraw darf nichts verlieren.
        kuenftigesFeld: { tief: ['a', 1, null, { nochTiefer: true }] },
      },
      {
        id: 'text-1',
        type: 'text',
        version: 7,
        versionNonce: 42,
        containerId: 'rect-1',
        text: 'Zeile eins\nZeile zwei – mit Sonderzeichen: äöü ß € 🙂',
        originalText: 'Zeile eins\nZeile zwei – mit Sonderzeichen: äöü ß € 🙂',
        fontFamily: 5,
        fontSize: 20,
        textAlign: 'center',
        verticalAlign: 'middle',
      },
      {
        id: 'arrow-1',
        type: 'arrow',
        version: 3,
        versionNonce: 12,
        points: [
          [0, 0],
          [55.5, 12.25],
        ],
        startBinding: { elementId: 'rect-1', focus: 0.15, gap: 4 },
        endBinding: null,
        elbowed: false,
      },
      {
        id: 'image-1',
        type: 'image',
        version: 2,
        versionNonce: 99,
        fileId: 'file-1',
        status: 'saved',
        scale: [1, 1],
      },
      {
        id: 'geloescht-1',
        type: 'ellipse',
        version: 9,
        versionNonce: 77,
        // Tombstone: die Loeschung selbst ist Information und darf nicht verschwinden.
        isDeleted: true,
      },
    ],
    appState: {
      viewBackgroundColor: '#f8f9fa',
      gridSize: 20,
      gridModeEnabled: true,
      name: 'Roundtrip-Board',
    },
    files: {
      'file-1': {
        id: 'file-1',
        mimeType: 'image/png',
        created: 1_700_000_000_001,
        byteSize: 4_096,
        storageKey: `boards/${boardId}/file-1`,
      },
    },
    updatedAt: 1_700_000_000_002,
  }
}

describe('Boards anlegen und sehen', () => {
  it('macht den Ersteller zum Board-Owner und zeigt das Board nur Mitgliedern', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')

    const board = await createBoard(ada, workspace.id, '  Erstes   Board ')

    expect(board.title).toBe('Erstes Board')
    expect(board.ownerUserId).toBe(ada.profile.user.id)
    expect(board.status).toBe('active')
    expect(board.sceneVersion).toBe(0)
    expect((await listBoards(ada, workspace.id)).map((entry) => entry.id)).toEqual([board.id])

    // Bob gehoert dem Arbeitsbereich nicht an und erfaehrt weder von ihm noch vom Board.
    expect((await get(bob, BOARDS_PATH, { [WORKSPACE_ID_PARAM]: workspace.id })).status).toBe(404)
    expect((await openBoard(bob, board.id)).status).toBe(404)

    await addMember(ada, workspace.id, bob.profile.user.id, 'member')
    expect((await listBoards(bob, workspace.id)).map((entry) => entry.id)).toEqual([board.id])
  })

  it('weist leere und zu lange Titel zurueck', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')

    expect((await post(ada, BOARDS_PATH, { workspaceId: workspace.id, title: '  ' })).status).toBe(400)
    expect((await post(ada, BOARDS_PATH, { workspaceId: workspace.id, title: 'x'.repeat(121) })).status).toBe(400)
    expect((await post(ada, BOARDS_PATH, { workspaceId: workspace.id })).status).toBe(400)
  })

  it('verlangt fuer jede Aenderung das CSRF-Token', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')

    expect(
      (await post(ada, BOARDS_PATH, { workspaceId: workspace.id, title: 'Ohne Token' }, { csrf: false })).status,
    ).toBe(403)
    expect((await saveScene(ada, board.id, 0, reicheSzene(board.id), { csrf: false })).status).toBe(403)
    expect((await listBoards(ada, workspace.id)).map((entry) => entry.title)).toEqual(['Board'])
  })

  it('verweigert jeden Boardendpunkt ohne Sitzung', async () => {
    const anonym: Account = { jar: createJar(), profile: { user: {} as never, csrfToken: 'x' } }

    expect((await get(anonym, BOARDS_PATH, { [WORKSPACE_ID_PARAM]: FREMDE_KENNUNG })).status).toBe(401)
    expect((await openBoard(anonym, FREMDE_KENNUNG)).status).toBe(401)
    expect((await post(anonym, BOARDS_PATH, { workspaceId: FREMDE_KENNUNG, title: 'X' })).status).toBe(401)
  })

  it('filtert nach Titel und trennt die Archivansicht', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const skizze = await createBoard(ada, workspace.id, 'Skizze Nord')
    await createBoard(ada, workspace.id, 'Planung Sued')

    expect((await listBoards(ada, workspace.id, { q: 'nord' })).map((entry) => entry.title)).toEqual(['Skizze Nord'])
    // Der Filter ist ein Teilstring, kein Muster: Platzhalter werden nicht gedeutet.
    expect(await listBoards(ada, workspace.id, { q: '%' })).toEqual([])
    expect(await listBoards(ada, workspace.id, { status: 'archived' })).toEqual([])

    expect((await post(ada, BOARD_STATUS_PATH, { boardId: skizze.id, status: 'archived' })).status).toBe(200)

    expect((await listBoards(ada, workspace.id)).map((entry) => entry.title)).toEqual(['Planung Sued'])
    expect((await listBoards(ada, workspace.id, { status: 'archived' })).map((entry) => entry.title)).toEqual([
      'Skizze Nord',
    ])
  })
})

describe('Geratene und fremde Kennungen', () => {
  it('antwortet auf jede fremde Boardkennung mit 404, nie mit 403', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const fremd = await createBoard(ada, workspace.id, 'Fremdes Board')

    for (const boardId of [fremd.id, FREMDE_KENNUNG, 'keine-uuid']) {
      expect((await openBoard(bob, boardId)).status).toBe(404)
      expect((await post(bob, BOARD_RENAME_PATH, { boardId, title: 'Uebernommen' })).status).toBe(404)
      expect((await post(bob, BOARD_STATUS_PATH, { boardId, status: 'archived' })).status).toBe(404)
      expect((await saveScene(bob, boardId, 0, reicheSzene(boardId))).status).toBe(404)
    }
    // Das fremde Board ist unveraendert geblieben.
    const unveraendert = await loadScene(ada, fremd.id)
    expect(unveraendert.board.title).toBe('Fremdes Board')
    expect(unveraendert.version).toBe(0)
  })

  it('gibt einem Systemadmin ohne Mitgliedschaft keinen Inhaltszugriff', async () => {
    const root = await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Internes Board')

    // Er verwaltet den Arbeitsbereich - aber Boards haengen an der Mitgliedschaft, nicht an der Systemrolle.
    expect((await get(root, BOARDS_PATH, { [WORKSPACE_ID_PARAM]: workspace.id })).status).toBe(404)
    expect((await openBoard(root, board.id)).status).toBe(404)
    expect((await post(root, BOARDS_PATH, { workspaceId: workspace.id, title: 'Von oben' })).status).toBe(404)
    expect((await saveScene(root, board.id, 0, reicheSzene(board.id))).status).toBe(404)
  })

  it('entzieht einem deaktivierten Nutzer jeden Boardzugriff', async () => {
    const root = await signedInAs('root')
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    await addMember(ada, workspace.id, bob.profile.user.id, 'member')
    const board = await createBoard(ada, workspace.id, 'Board')
    expect((await openBoard(bob, board.id)).status).toBe(200)

    expect(
      (await post(root, ADMIN_USER_STATUS_PATH, { userId: bob.profile.user.id, status: 'deactivated' })).status,
    ).toBe(200)

    expect((await openBoard(bob, board.id)).status).toBe(401)
    expect((await saveScene(bob, board.id, 0, reicheSzene(board.id))).status).toBe(401)
  })

  it('laesst ein Mitglied das Board oeffnen, umbenennen und speichern', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    await addMember(ada, workspace.id, bob.profile.user.id, 'member')
    const board = await createBoard(ada, workspace.id, 'Board')

    // In diesem Paket entscheidet die Workspace-Mitgliedschaft; Boardrollen kommen erst mit Issue 6.
    expect((await post(bob, BOARD_RENAME_PATH, { boardId: board.id, title: 'Gemeinsam' })).status).toBe(200)
    expect((await saveScene(bob, board.id, 0, reicheSzene(board.id))).status).toBe(200)
    expect((await loadScene(bob, board.id)).board.ownerUserId).toBe(ada.profile.user.id)
  })
})

describe('Archivierung', () => {
  it('haelt ein archiviertes Board lesbar und unveraenderlich', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')
    expect((await saveScene(ada, board.id, 0, reicheSzene(board.id))).status).toBe(200)

    expect((await post(ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(200)

    // Lesbar bleibt alles.
    const geladen = await loadScene(ada, board.id)
    expect(geladen.board.status).toBe('archived')
    expect(geladen.version).toBe(1)

    // Aenderbar ist nur noch die Archivierung selbst.
    expect((await post(ada, BOARD_RENAME_PATH, { boardId: board.id, title: 'Neu' })).status).toBe(403)
    expect((await saveScene(ada, board.id, 1, reicheSzene(board.id))).status).toBe(403)
    expect((await post(ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(403)

    expect((await post(ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'active' })).status).toBe(200)
    expect((await saveScene(ada, board.id, 1, reicheSzene(board.id))).status).toBe(200)
  })

  it('macht mit dem Arbeitsbereich auch seine Boards unveraenderlich', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')

    expect((await post(ada, WORKSPACE_STATUS_PATH, { workspaceId: workspace.id, status: 'archived' })).status).toBe(200)

    expect((await openBoard(ada, board.id)).status).toBe(200)
    expect((await listBoards(ada, workspace.id)).map((entry) => entry.id)).toEqual([board.id])
    expect((await post(ada, BOARDS_PATH, { workspaceId: workspace.id, title: 'Neu' })).status).toBe(403)
    expect((await post(ada, BOARD_RENAME_PATH, { boardId: board.id, title: 'Neu' })).status).toBe(403)
    expect((await post(ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(403)
    expect((await saveScene(ada, board.id, 0, reicheSzene(board.id))).status).toBe(403)
  })
})

describe('Szenenpersistenz', () => {
  it('speichert und laedt eine Szene verlustfrei', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')
    const szene = reicheSzene(board.id)

    const gespeichert = await saveScene(ada, board.id, 0, szene)
    expect(gespeichert.status).toBe(200)
    expect(((await gespeichert.json()) as SaveSceneResponse).version).toBe(1)

    const geladen = await loadScene(ada, board.id)

    expect(geladen.version).toBe(1)
    expect(geladen.scene).toEqual(szene)
    // Text, Bindings, Gruppen, Frames, Tombstones und unbekannte Felder stehen unveraendert im Ergebnis.
    expect(JSON.parse(JSON.stringify(geladen.scene))).toEqual(JSON.parse(JSON.stringify(szene)))
    expect(geladen.board.sceneVersion).toBe(1)
  })

  it('gibt ein noch nie gespeichertes Board als leeren Ausgangsstand heraus', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')

    const geladen = await loadScene(ada, board.id)

    expect(geladen.version).toBe(0)
    expect(geladen.scene.elements).toEqual([])
    expect(geladen.scene.boardId).toBe(board.id)
  })

  it('ueberlebt einen Neustart der Anwendung', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')
    const szene = reicheSzene(board.id)
    expect((await saveScene(ada, board.id, 0, szene)).status).toBe(200)

    // Ein zweiter Anwendungsprozess auf derselben Datenbank: die Wahrheit liegt in PostgreSQL, nicht im
    // Browserspeicher und nicht im Container.
    const neustart = await startTestApp({ provider, pool, databaseUrl: DATABASE_URL })
    try {
      const jar = createJar()
      expect((await login(neustart, jar, { subject: 'ada' })).error).toBeNull()
      const response = await jar.fetch(
        `${neustart.baseUrl}${BOARD_SCENE_PATH}?${new URLSearchParams({ [BOARD_ID_PARAM]: board.id }).toString()}`,
      )
      expect(response.status).toBe(200)
      const geladen = (await response.json()) as BoardSceneResponse
      expect(geladen.version).toBe(1)
      expect(geladen.scene).toEqual(szene)
    } finally {
      await neustart.close()
    }
  })

  it('meldet einen beschaedigten Datensatz, statt ein leeres Board zu oeffnen', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')
    expect((await saveScene(ada, board.id, 0, reicheSzene(board.id))).status).toBe(200)

    // Ein halber Datensatz, wie ihn nur ein Eingriff an der Anwendung vorbei erzeugen kann.
    await pool.query(`update scene_versions set scene = '{"schemaVersion":1}'::jsonb where board_id = $1`, [board.id])

    const response = await openBoard(ada, board.id)

    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).toContain('beschaedigt')
    // Und ganz sicher kein leeres Board: die Antwort traegt gar keine Szene.
    expect(text).not.toContain('"elements"')
  })

  it('weist eine Szene zurueck, die nicht zum Board gehoert oder dem Vertrag widerspricht', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')
    const anderes = await createBoard(ada, workspace.id, 'Anderes')

    expect((await saveScene(ada, board.id, 0, reicheSzene(anderes.id))).status).toBe(400)
    expect(
      (await post(ada, BOARD_SCENE_PATH, { boardId: board.id, baseVersion: 0, scene: { schemaVersion: 1 } })).status,
    ).toBe(400)
    expect(
      (await post(ada, BOARD_SCENE_PATH, { boardId: board.id, baseVersion: -1, scene: reicheSzene(board.id) })).status,
    ).toBe(400)
    // Nichts davon hat eine Version angelegt.
    expect((await loadScene(ada, board.id)).version).toBe(0)
  })

  it('lehnt ein nicht speicherbares NUL-Zeichen ab, statt daran zu scheitern', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')
    const szene = reicheSzene(board.id)
    const mitNul: SceneSnapshot = {
      ...szene,
      elements: [{ id: 'text-nul', version: 1, versionNonce: 1, text: 'kaputt zeichen' }],
    }

    const response = await saveScene(ada, board.id, 0, mitNul)

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('NUL')
    expect((await loadScene(ada, board.id)).version).toBe(0)
  })

  it('weist eine zu grosse Szene ab', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')
    const gross: SceneSnapshot = {
      ...reicheSzene(board.id),
      elements: [{ id: 'riesig', version: 1, versionNonce: 1, text: 'x'.repeat(app.context.config.maxSceneBytes) }],
    }

    const response = await saveScene(ada, board.id, 0, gross)

    expect(response.status).toBe(413)
    expect((await loadScene(ada, board.id)).version).toBe(0)
  })
})

describe('Optimistische Versionspruefung', () => {
  it('weist eine Speicherung auf einer ueberholten Version ab und ueberschreibt nichts', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')
    const erste = reicheSzene(board.id)
    expect((await saveScene(ada, board.id, 0, erste)).status).toBe(200)

    const veraltet: SceneSnapshot = {
      ...erste,
      elements: [{ id: 'nur-dieses', version: 1, versionNonce: 1 }],
    }
    const response = await saveScene(ada, board.id, 0, veraltet)

    expect(response.status).toBe(409)
    expect(((await response.json()) as SceneConflictResponse).currentVersion).toBe(1)
    // Der gespeicherte Stand ist unveraendert; nichts wurde still ueberschrieben.
    expect((await loadScene(ada, board.id)).scene).toEqual(erste)
  })

  it('laesst unter echter Parallelitaet genau eine von zwei Speicherungen gewinnen', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    await addMember(ada, workspace.id, bob.profile.user.id, 'member')
    const board = await createBoard(ada, workspace.id, 'Board')

    const adasSzene: SceneSnapshot = {
      ...reicheSzene(board.id),
      elements: [{ id: 'von-ada', version: 1, versionNonce: 1 }],
    }
    const bobsSzene: SceneSnapshot = {
      ...reicheSzene(board.id),
      elements: [{ id: 'von-bob', version: 1, versionNonce: 2 }],
    }

    // Beide setzen auf derselben Ausgangsversion 0 auf und speichern gleichzeitig.
    const [ersteAntwort, zweiteAntwort] = await Promise.all([
      saveScene(ada, board.id, 0, adasSzene),
      saveScene(bob, board.id, 0, bobsSzene),
    ])

    expect([ersteAntwort.status, zweiteAntwort.status].sort()).toEqual([200, 409])
    const gespeichert = await loadScene(ada, board.id)
    expect(gespeichert.version).toBe(1)
    // Der Gewinner steht vollstaendig da - kein Mischmasch aus beiden Speicherungen.
    expect([adasSzene, bobsSzene]).toContainEqual(gespeichert.scene)

    const versionen = await pool.query<{ count: string }>(
      'select count(*) from scene_versions where board_id = $1',
      [board.id],
    )
    expect(versionen.rows[0]?.count).toBe('1')
  })

  it('legt je angenommener Speicherung genau eine Version an', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')

    for (let version = 0; version < 3; version += 1) {
      const response = await saveScene(ada, board.id, version, {
        ...reicheSzene(board.id),
        updatedAt: 1_700_000_000_000 + version,
      })
      expect(response.status).toBe(200)
      expect(((await response.json()) as SaveSceneResponse).version).toBe(version + 1)
    }

    const versionen = await pool.query<{ version: number }>(
      'select version from scene_versions where board_id = $1 order by version',
      [board.id],
    )
    expect(versionen.rows.map((row) => row.version)).toEqual([1, 2, 3])
    expect((await loadScene(ada, board.id)).scene.updatedAt).toBe(1_700_000_000_002)
  })

  it('begrenzt die Historie eines Boards auf die juengsten Versionen', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')

    // Direkt ueber den Store, damit der Test nicht hundert HTTP-Anfragen braucht.
    await app.boards.transaction(async (tx) => {
      for (let version = 1; version <= SCENE_VERSION_RETENTION + 5; version += 1) {
        await tx.scenes.append(board.id, version, reicheSzene(board.id), ada.profile.user.id)
      }
      await tx.scenes.prune(board.id, SCENE_VERSION_RETENTION)
    })

    const versionen = await pool.query<{ count: string; min: number; max: number }>(
      'select count(*)::text as count, min(version) as min, max(version) as max from scene_versions where board_id = $1',
      [board.id],
    )
    expect(versionen.rows[0]?.count).toBe(String(SCENE_VERSION_RETENTION))
    expect(versionen.rows[0]?.min).toBe(6)
    expect(versionen.rows[0]?.max).toBe(SCENE_VERSION_RETENTION + 5)
  })
})

describe('Nachweis', () => {
  it('haelt Anlage, Umbenennung und Archivierung fest, ohne Boardinhalte aufzunehmen', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')
    await post(ada, BOARD_RENAME_PATH, { boardId: board.id, title: 'Board Nord' })
    await saveScene(ada, board.id, 0, reicheSzene(board.id))
    await post(ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })
    await post(ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'active' })

    const events = (await app.workspaces.audit.listForWorkspace(workspace.id)).filter(
      (event) => event.targetType === 'board',
    )

    expect(events.map((event) => event.action)).toEqual([
      'board.created',
      'board.renamed',
      'board.archived',
      'board.unarchived',
    ])
    for (const event of events) {
      expect(event.actorId).toBe(ada.profile.user.id)
      expect(event.workspaceId).toBe(workspace.id)
      expect(event.targetId).toBe(board.id)
    }
    // Der Nachweis kennt Titel und Status, aber nie den Inhalt der Zeichnung.
    const rohdaten = JSON.stringify(events)
    expect(rohdaten).not.toContain('Sonderzeichen')
    expect(rohdaten).not.toContain('versionNonce')
    expect(rohdaten).not.toContain('storageKey')
  })

  it('schreibt kein Ereignis, wenn die Aenderung abgelehnt wurde', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')
    const vorher = (await app.workspaces.audit.listForWorkspace(workspace.id)).length

    expect((await post(bob, BOARD_RENAME_PATH, { boardId: board.id, title: 'Meins' })).status).toBe(404)

    expect(await app.workspaces.audit.listForWorkspace(workspace.id)).toHaveLength(vorher)
  })
})

describe('Board-Persistenz', () => {
  it('gibt die sperrende Abfrage nur innerhalb einer Transaktion heraus', async () => {
    await expect(app.boards.boards.findForUpdate(FREMDE_KENNUNG, FREMDE_KENNUNG)).rejects.toThrow()
    await expect(
      app.boards.transaction((tx) => tx.boards.findForUpdate(FREMDE_KENNUNG, FREMDE_KENNUNG)),
    ).resolves.toBeNull()
  })

  it('raeumt Boards und Szenen mit dem Arbeitsbereich ab', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Board')
    expect((await saveScene(ada, board.id, 0, reicheSzene(board.id))).status).toBe(200)

    await pool.query('delete from workspaces where id = $1', [workspace.id])

    expect((await pool.query('select 1 from boards where id = $1', [board.id])).rowCount).toBe(0)
    expect((await pool.query('select 1 from scene_versions where board_id = $1', [board.id])).rowCount).toBe(0)
  })

  it('laesst einen Nutzer nicht loeschen, solange ihm ein Board gehoert', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    await createBoard(ada, workspace.id, 'Board')

    // Genau ein fachlicher Owner je Board: die Datenbank verweigert das Loeschen, statt ihn zu verlieren.
    await expect(pool.query('delete from users where id = $1', [ada.profile.user.id])).rejects.toThrow()
  })
})
