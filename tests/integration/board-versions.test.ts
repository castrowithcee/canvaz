/**
 * Versionsverlauf, Vorschau, Wiederherstellung, Export und Import gegen die echte Anwendung und eine echte
 * Datenbank.
 *
 * Es gibt keinen verkuerzten Weg an den Guards vorbei: jeder Test meldet sich ueber den echten OIDC-Fluss an
 * und spricht danach dieselben HTTP-Endpunkte an wie die SPA - samt CSRF-Token und Session-Cookie. Gelesen
 * wird zur Kontrolle direkt aus der Datenbank; ein Test, der eine Speicherung nur ueber denselben Weg
 * prueft, ueber den sie entstanden ist, belegt bloss, dass der Weg mit sich selbst uebereinstimmt.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  BOARD_ASSETS_PATH,
  BOARD_EXPORT_PATH,
  BOARD_GRANT_ADD_PATH,
  BOARD_GUEST_JOIN_PATH,
  BOARD_ID_PARAM,
  BOARD_IMPORT_PATH,
  BOARD_SCENE_PATH,
  BOARD_SHARE_LINK_CREATE_PATH,
  BOARD_STATUS_PATH,
  BOARD_VERSION_PARAM,
  BOARD_VERSION_RESTORE_PATH,
  BOARD_VERSION_SCENE_PATH,
  BOARD_VERSIONS_PATH,
  CSRF_HEADER,
  WORKSPACE_MEMBER_ADD_PATH,
  WORKSPACE_STATUS_PATH,
} from '../../src/contracts/api.js'
import type {
  BoardVersionSceneResponse,
  BoardVersionsResponse,
  CreateBoardShareLinkResponse,
  GuestSessionResponse,
  ImportBoardSceneResponse,
  RestoreBoardVersionResponse,
} from '../../src/contracts/api.js'
import type { SceneSnapshot, SyncElement } from '../../src/contracts/scene.js'
import { SCENE_SCHEMA_VERSION } from '../../src/contracts/scene.js'
import type { ExcalidrawFile } from '../../src/domain/board/excalidraw-file.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import {
  createBoard,
  createWorkspace,
  post,
  signedInAs,
  storedVersions,
  teamMitBoard,
} from '../support/board-fixture.js'
import type { Account } from '../support/board-fixture.js'
import { createJar } from '../support/browser-client.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { openRealtime, ruhe } from '../support/realtime-socket.js'
import type { RealtimeTestClient } from '../support/realtime-socket.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

/** Eine erfundene, gueltig geformte Kennung. Sie darf sich von einer fremden nicht unterscheiden lassen. */
const FREMDE_KENNUNG = '00000000-0000-4000-8000-000000000000'

/** Acht Byte reine PNG-Signatur - genau das, was die Signaturpruefung des Uploads annimmt. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Enge Grenzen fuer die beiden Faelle, die man sonst nur mit hundert Runden belegen koennte. */
const ENGE_RETENTION = 10
const ENGES_IMPORTLIMIT = 65_536

let pool: Pool
let provider: TestProvider
let app: TestApp
/** Zweite Instanz mit enger Aufbewahrung und engem Importlimit; sonst identisch aufgebaut. */
let eng: TestApp

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
  eng = await startTestApp({
    provider,
    pool,
    databaseUrl: DATABASE_URL,
    env: {
      CANVAZ_SCENE_VERSION_RETENTION: String(ENGE_RETENTION),
      CANVAZ_MAX_IMPORT_BYTES: String(ENGES_IMPORTLIMIT),
    },
  })
})

afterAll(async () => {
  await eng.close()
  await app.close()
  await provider.close()
  await pool.end()
})

const clients: RealtimeTestClient[] = []

beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
  provider.resetBehaviour()
  app.clearLogs()
})

afterEach(async () => {
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

function element(id: string, version = 1, extra: Record<string, unknown> = {}): SyncElement {
  return { id, version, versionNonce: 7, type: 'rectangle', x: 1, y: 2, width: 3, height: 4, ...extra }
}

function szene(boardId: string, elements: readonly SyncElement[]): SceneSnapshot {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    boardId,
    elements,
    appState: { viewBackgroundColor: '#ffffff', gridSize: null, gridModeEnabled: false, name: 'Skizze' },
    files: {},
    updatedAt: Date.now(),
  }
}

/** Speichert und liefert die neue Version. Genau der Weg, den die SPA ohne Realtime nimmt. */
async function speichere(
  instanz: TestApp,
  konto: Account,
  boardId: string,
  baseVersion: number,
  elements: readonly SyncElement[],
): Promise<number> {
  const response = await post(instanz, konto, BOARD_SCENE_PATH, {
    boardId,
    baseVersion,
    scene: szene(boardId, elements),
  })
  expect(response.status, 'Szene speichern').toBe(200)
  return baseVersion + 1
}

function get(instanz: TestApp, konto: Account, path: string, params: Record<string, string>): Promise<Response> {
  return konto.jar.fetch(`${instanz.baseUrl}${path}?${new URLSearchParams(params).toString()}`)
}

async function versionen(instanz: TestApp, konto: Account, boardId: string): Promise<BoardVersionsResponse> {
  const response = await get(instanz, konto, BOARD_VERSIONS_PATH, { [BOARD_ID_PARAM]: boardId })
  expect(response.status, 'Versionsliste').toBe(200)
  return (await response.json()) as BoardVersionsResponse
}

async function exportiere(instanz: TestApp, konto: Account, boardId: string): Promise<ExcalidrawFile> {
  const response = await get(instanz, konto, BOARD_EXPORT_PATH, { [BOARD_ID_PARAM]: boardId })
  expect(response.status, 'Export').toBe(200)
  return (await response.json()) as ExcalidrawFile
}

/** Laedt ein Bild hoch - roh im Koerper, genau wie der Editor es tut. */
async function ladeBildHoch(konto: Account, boardId: string, fileId: string): Promise<void> {
  const params = new URLSearchParams({ [BOARD_ID_PARAM]: boardId, fileId })
  const response = await konto.jar.fetch(`${app.baseUrl}${BOARD_ASSETS_PATH}?${params.toString()}`, {
    method: 'POST',
    headers: { [CSRF_HEADER]: konto.profile.csrfToken, 'content-type': 'image/png' },
    body: PNG,
  })
  expect(response.status, 'Bild hochladen').toBe(201)
}

async function aktuelleVersion(boardId: string): Promise<number> {
  const rows = await pool.query<{ current_scene_version: number }>(
    'select current_scene_version from boards where id = $1',
    [boardId],
  )
  return rows.rows[0]?.current_scene_version ?? -1
}

/** Sichtbare Elemente des zuletzt gespeicherten Standes, direkt aus der Datenbank. */
async function sichtbareElemente(boardId: string): Promise<string[]> {
  const rows = await pool.query<{ scene: SceneSnapshot }>(
    'select scene from scene_versions where board_id = $1 order by version desc limit 1',
    [boardId],
  )
  const scene = rows.rows[0]?.scene
  return (scene?.elements ?? []).filter((entry) => entry.isDeleted !== true).map((entry) => entry.id)
}

async function auditAktionen(boardId: string): Promise<string[]> {
  const rows = await pool.query<{ action: string }>(
    "select action from audit_events where target_type = 'board' and target_id = $1 order by occurred_at",
    [boardId],
  )
  return rows.rows.map((row) => row.action)
}

/** Ein Board mit zwei Staenden: Version 1 traegt nur `a`, Version 2 zusaetzlich `b`. */
async function boardMitZweiStaenden() {
  const team = await teamMitBoard(app)
  await speichere(app, team.ada, team.board.id, 0, [element('a')])
  await speichere(app, team.ada, team.board.id, 1, [element('a'), element('b')])
  return team
}

/* ---------------------------------------------------------------------------------------------------- */
/* Versionsliste und Vorschau                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

describe('Versionsliste und Vorschau', () => {
  it('nennt jede gespeicherte Version mit Urheber und Umfang, juengste zuerst', async () => {
    const team = await boardMitZweiStaenden()

    const liste = await versionen(app, team.ada, team.board.id)

    expect(liste.versions.map((entry) => entry.version)).toEqual([2, 1])
    expect(liste.versions[0]?.authorDisplayName).toBe(team.ada.profile.user.displayName)
    expect(liste.versions[0]?.elementCount).toBe(2)
    expect(liste.versions[1]?.elementCount).toBe(1)
    expect(liste.versions[0]?.byteSize).toBeGreaterThan(0)
    expect(liste.mayRestore).toBe(true)
    expect(liste.board.sceneVersion).toBe(2)
  })

  it('zeigt eine fruehere Version, ohne den aktuellen Stand anzufassen', async () => {
    const team = await boardMitZweiStaenden()

    const response = await get(app, team.ada, BOARD_VERSION_SCENE_PATH, {
      [BOARD_ID_PARAM]: team.board.id,
      [BOARD_VERSION_PARAM]: '1',
    })
    expect(response.status).toBe(200)
    const vorschau = (await response.json()) as BoardVersionSceneResponse

    expect(vorschau.version).toBe(1)
    expect(vorschau.scene.elements.map((entry) => entry.id)).toEqual(['a'])
    // Ansehen ist kein Schreibvorgang: weder die Boardzeile noch die Historie aendern sich davon.
    expect(await aktuelleVersion(team.board.id)).toBe(2)
    expect(await storedVersions(pool, team.board.id)).toBe(2)
  })

  it('meldet eine nie vorhandene Version als nicht mehr aufbewahrt', async () => {
    const team = await boardMitZweiStaenden()

    const response = await get(app, team.ada, BOARD_VERSION_SCENE_PATH, {
      [BOARD_ID_PARAM]: team.board.id,
      [BOARD_VERSION_PARAM]: '99',
    })

    expect(response.status).toBe(404)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Wiederherstellung                                                                                     */
/* ---------------------------------------------------------------------------------------------------- */

describe('Wiederherstellung', () => {
  it('legt den frueheren Stand als neue Version an, ohne Historie zu verlieren', async () => {
    const team = await boardMitZweiStaenden()

    const response = await post(app, team.ada, BOARD_VERSION_RESTORE_PATH, {
      boardId: team.board.id,
      version: 1,
      baseVersion: 2,
    })
    expect(response.status).toBe(200)
    const wiederhergestellt = (await response.json()) as RestoreBoardVersionResponse

    expect(wiederhergestellt).toMatchObject({ version: 3, restoredFrom: 1 })
    // Nichts wurde geloescht: beide bisherigen Staende stehen weiter da.
    expect(await storedVersions(pool, team.board.id)).toBe(3)
    expect(await aktuelleVersion(team.board.id)).toBe(3)
    expect(await sichtbareElemente(team.board.id)).toEqual(['a'])
    expect(await auditAktionen(team.board.id)).toContain('board.scene-restored')
  })

  it('laesst sich zweimal anwenden und fuehrt so wieder vorwaerts', async () => {
    const team = await boardMitZweiStaenden()

    await post(app, team.ada, BOARD_VERSION_RESTORE_PATH, { boardId: team.board.id, version: 1, baseVersion: 2 })
    // Version 2 ist weiterhin da - der Weg zurueck ist derselbe Weg noch einmal.
    const zurueck = await post(app, team.ada, BOARD_VERSION_RESTORE_PATH, {
      boardId: team.board.id,
      version: 2,
      baseVersion: 3,
    })

    expect(zurueck.status).toBe(200)
    expect(await sichtbareElemente(team.board.id)).toEqual(['a', 'b'])
  })

  it('ueberschreibt keinen unerkannt neueren Stand ohne Bestaetigung', async () => {
    const team = await boardMitZweiStaenden()
    // Zwischen dem Laden der Liste und dem Klick speichert jemand anderes.
    await speichere(app, team.ada, team.board.id, 2, [element('a'), element('b'), element('c')])

    const konflikt = await post(app, team.ada, BOARD_VERSION_RESTORE_PATH, {
      boardId: team.board.id,
      version: 1,
      baseVersion: 2,
    })

    expect(konflikt.status).toBe(409)
    expect(await aktuelleVersion(team.board.id)).toBe(3)
    expect(await storedVersions(pool, team.board.id)).toBe(3)
    expect(await sichtbareElemente(team.board.id)).toEqual(['a', 'b', 'c'])

    // Der zweite Aufruf auf dem jetzt bekannten Stand ist die Bestaetigung.
    const bestaetigt = await post(app, team.ada, BOARD_VERSION_RESTORE_PATH, {
      boardId: team.board.id,
      version: 1,
      baseVersion: 3,
    })
    expect(bestaetigt.status).toBe(200)
    expect(await sichtbareElemente(team.board.id)).toEqual(['a'])
  })

  it('bringt verbundene Clients auf denselben Stand', async () => {
    const team = await boardMitZweiStaenden()
    const client = await openRealtime(app.baseUrl, team.bob.jar.cookieHeader())
    clients.push(client)
    const beigetreten = await client.join(team.board.id)
    expect(beigetreten.scene.elements.map((entry) => entry.id).sort()).toEqual(['a', 'b'])

    await post(app, team.ada, BOARD_VERSION_RESTORE_PATH, { boardId: team.board.id, version: 1, baseVersion: 2 })

    const nachher = await client.next('snapshot')
    expect(nachher.version).toBe(3)
    expect(nachher.scene.elements.filter((entry) => entry.isDeleted !== true).map((entry) => entry.id)).toEqual(['a'])
    // Das beerdigte Element traegt eine hoehere Version als der Stand, den der Client noch hielt - sonst
    // machte der naechste Abgleich die Wiederherstellung still rueckgaengig.
    const tombstone = nachher.scene.elements.find((entry) => entry.id === 'b')
    expect(tombstone?.isDeleted).toBe(true)
    expect(tombstone?.version).toBeGreaterThan(1)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Autorisierung                                                                                         */
/* ---------------------------------------------------------------------------------------------------- */

describe('Autorisierung', () => {
  it('laesst einen Viewer ansehen, aber nicht wiederherstellen', async () => {
    const team = await boardMitZweiStaenden()
    const freigabe = await post(app, team.ada, BOARD_GRANT_ADD_PATH, {
      boardId: team.board.id,
      userId: team.bob.profile.user.id,
      role: 'viewer',
    })
    expect(freigabe.status).toBe(201)

    const liste = await versionen(app, team.bob, team.board.id)
    expect(liste.mayRestore).toBe(false)

    const abgelehnt = await post(app, team.bob, BOARD_VERSION_RESTORE_PATH, {
      boardId: team.board.id,
      version: 1,
      baseVersion: 2,
    })
    expect(abgelehnt.status).toBe(403)
    expect(await aktuelleVersion(team.board.id)).toBe(2)
  })

  it('laesst ein gewoehnliches Mitglied speichern, aber nicht wiederherstellen', async () => {
    const team = await boardMitZweiStaenden()

    // Bob ist Mitglied und damit `editor`: er darf jede Zeichnung aendern - aber nicht den Bestand
    // zuruecksetzen.
    const abgelehnt = await post(app, team.bob, BOARD_VERSION_RESTORE_PATH, {
      boardId: team.board.id,
      version: 1,
      baseVersion: 2,
    })

    expect(abgelehnt.status).toBe(403)
    expect((await versionen(app, team.bob, team.board.id)).mayRestore).toBe(false)
  })

  it('laesst die Verwaltung des Arbeitsbereichs wiederherstellen, auch ohne Boardownerschaft', async () => {
    const ada = await signedInAs(app, 'ada')
    const clara = await signedInAs(app, 'clara')
    const workspace = await createWorkspace(app, ada, 'Team Nord')
    const aufnahme = await post(app, ada, WORKSPACE_MEMBER_ADD_PATH, {
      workspaceId: workspace.id,
      userId: clara.profile.user.id,
      role: 'admin',
    })
    expect(aufnahme.status).toBe(201)
    const board = await createBoard(app, ada, workspace.id, 'Skizze')
    await speichere(app, ada, board.id, 0, [element('a')])
    await speichere(app, ada, board.id, 1, [element('a'), element('b')])

    expect((await versionen(app, clara, board.id)).mayRestore).toBe(true)
    const response = await post(app, clara, BOARD_VERSION_RESTORE_PATH, {
      boardId: board.id,
      version: 1,
      baseVersion: 2,
    })

    expect(response.status).toBe(200)
    expect(await sichtbareElemente(board.id)).toEqual(['a'])
  })

  it('macht Historie und Export fuer ein Nichtmitglied ununterscheidbar von einer erfundenen Kennung', async () => {
    const team = await boardMitZweiStaenden()
    const fremde = await signedInAs(app, 'mallory')

    const historie = await get(app, fremde, BOARD_VERSIONS_PATH, { [BOARD_ID_PARAM]: team.board.id })
    const erfunden = await get(app, fremde, BOARD_VERSIONS_PATH, { [BOARD_ID_PARAM]: FREMDE_KENNUNG })
    const ausgabe = await get(app, fremde, BOARD_EXPORT_PATH, { [BOARD_ID_PARAM]: team.board.id })
    const wiederherstellung = await post(app, fremde, BOARD_VERSION_RESTORE_PATH, {
      boardId: team.board.id,
      version: 1,
      baseVersion: 2,
    })

    expect([historie.status, erfunden.status, ausgabe.status, wiederherstellung.status]).toEqual([404, 404, 404, 404])
  })

  it('haelt ein archiviertes Board lesbar und unveraenderlich', async () => {
    const team = await boardMitZweiStaenden()
    const exportiertVorher = await exportiere(app, team.ada, team.board.id)
    const archiviert = await post(app, team.ada, BOARD_STATUS_PATH, { boardId: team.board.id, status: 'archived' })
    expect(archiviert.status).toBe(200)

    const liste = await versionen(app, team.ada, team.board.id)
    const wiederherstellung = await post(app, team.ada, BOARD_VERSION_RESTORE_PATH, {
      boardId: team.board.id,
      version: 1,
      baseVersion: 2,
    })
    const einfuhr = await post(app, team.ada, BOARD_IMPORT_PATH, {
      boardId: team.board.id,
      baseVersion: 2,
      file: exportiertVorher,
    })

    expect(liste.versions).toHaveLength(2)
    expect(wiederherstellung.status).toBe(403)
    expect(einfuhr.status).toBe(403)
    expect(await aktuelleVersion(team.board.id)).toBe(2)
  })

  it('haelt einen archivierten Arbeitsbereich unveraenderlich', async () => {
    const team = await boardMitZweiStaenden()
    const archiviert = await post(app, team.ada, WORKSPACE_STATUS_PATH, {
      workspaceId: team.workspace.id,
      status: 'archived',
    })
    expect(archiviert.status).toBe(200)

    const wiederherstellung = await post(app, team.ada, BOARD_VERSION_RESTORE_PATH, {
      boardId: team.board.id,
      version: 1,
      baseVersion: 2,
    })

    expect(wiederherstellung.status).toBe(403)
    expect(await aktuelleVersion(team.board.id)).toBe(2)
  })

  it('ist fuer einen Gast nicht vorhanden, obwohl er das Board bearbeiten darf', async () => {
    const team = await boardMitZweiStaenden()
    const angelegt = await post(app, team.ada, BOARD_SHARE_LINK_CREATE_PATH, {
      boardId: team.board.id,
      role: 'guest-editor',
    })
    expect(angelegt.status).toBe(201)
    const { url } = (await angelegt.json()) as CreateBoardShareLinkResponse
    const jar = createJar()
    const beitritt = await jar.fetch(`${app.baseUrl}${BOARD_GUEST_JOIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: new URL(url).hash.slice(1), displayName: 'Gast' }),
    })
    expect(beitritt.status).toBe(201)
    const gast = (await beitritt.json()) as GuestSessionResponse

    const params = new URLSearchParams({ [BOARD_ID_PARAM]: team.board.id })
    const historie = await jar.fetch(`${app.baseUrl}${BOARD_VERSIONS_PATH}?${params.toString()}`)
    const ausgabe = await jar.fetch(`${app.baseUrl}${BOARD_EXPORT_PATH}?${params.toString()}`)
    const einfuhr = await jar.fetch(`${app.baseUrl}${BOARD_IMPORT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: gast.csrfToken },
      body: JSON.stringify({ boardId: team.board.id, baseVersion: 2, file: {} }),
    })

    // 401 und nicht 403: die Strecke ist fuer ihn nicht vorhanden, nicht bloss verboten.
    expect([historie.status, ausgabe.status, einfuhr.status]).toEqual([401, 401, 401])
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Export und Import                                                                                     */
/* ---------------------------------------------------------------------------------------------------- */

describe('Export und Import', () => {
  it('erhaelt Elemente und Bilder ueber einen vollstaendigen Roundtrip', async () => {
    const team = await teamMitBoard(app)
    await ladeBildHoch(team.ada, team.board.id, 'bild-1')
    const mitBild = szene(team.board.id, [element('a', 1, { type: 'image', fileId: 'bild-1' })])
    const gespeichert = await post(app, team.ada, BOARD_SCENE_PATH, {
      boardId: team.board.id,
      baseVersion: 0,
      scene: {
        ...mitBild,
        files: {
          'bild-1': {
            id: 'bild-1',
            mimeType: 'image/png',
            created: Date.now(),
            byteSize: PNG.byteLength,
            storageKey: `boards/${team.board.id}/bild-1/x`,
          },
        },
      },
    })
    expect(gespeichert.status).toBe(200)

    const datei = await exportiere(app, team.ada, team.board.id)
    expect(datei.type).toBe('excalidraw')
    expect(datei.elements.map((entry) => entry.id)).toEqual(['a'])
    expect(datei.files['bild-1']?.dataURL).toBe(`data:image/png;base64,${PNG.toString('base64')}`)

    // Ein zweites, leeres Board bekommt denselben Inhalt allein aus der Datei.
    const ziel = await createBoard(app, team.ada, team.workspace.id, 'Ziel')
    const response = await post(app, team.ada, BOARD_IMPORT_PATH, {
      boardId: ziel.id,
      baseVersion: 0,
      file: datei,
    })
    expect(response.status).toBe(201)
    const uebernommen = (await response.json()) as ImportBoardSceneResponse
    expect(uebernommen).toMatchObject({ version: 1, importedElements: 1, importedFiles: 1 })

    expect(await sichtbareElemente(ziel.id)).toEqual(['a'])
    const rows = await pool.query<{ file_id: string; checksum_sha256: string; byte_size: string }>(
      'select file_id, checksum_sha256, byte_size from board_assets where board_id = $1',
      [ziel.id],
    )
    expect(rows.rows[0]?.file_id).toBe('bild-1')
    expect(Number(rows.rows[0]?.byte_size)).toBe(PNG.byteLength)
    // Die Bytes liegen wirklich hinter dem Storage-Port und nicht nur als Metadatensatz da.
    const abruf = await get(app, team.ada, BOARD_ASSETS_PATH, {
      [BOARD_ID_PARAM]: ziel.id,
      fileId: 'bild-1',
    })
    expect(abruf.status).toBe(200)
    expect(Buffer.from(await abruf.arrayBuffer())).toEqual(PNG)
    expect(await auditAktionen(ziel.id)).toContain('board.scene-imported')
  })

  it('ersetzt den bisherigen Stand als neue Version, ohne Historie zu verlieren', async () => {
    const team = await boardMitZweiStaenden()
    const datei = await exportiere(app, team.ada, team.board.id)
    await speichere(app, team.ada, team.board.id, 2, [element('a'), element('b'), element('c')])

    const response = await post(app, team.ada, BOARD_IMPORT_PATH, {
      boardId: team.board.id,
      baseVersion: 3,
      file: datei,
    })

    expect(response.status).toBe(201)
    expect(await storedVersions(pool, team.board.id)).toBe(4)
    expect(await sichtbareElemente(team.board.id)).toEqual(['a', 'b'])
  })

  it('weist beschaedigte, schemafremde und leere Dateien benannt ab', async () => {
    const team = await teamMitBoard(app)
    const faelle: readonly unknown[] = [
      'kein objekt',
      {},
      { type: 'tldraw', version: 2, elements: [], appState: {} },
      { type: 'excalidraw', version: 99, elements: [], appState: { viewBackgroundColor: '#fff' } },
      { type: 'excalidraw', version: 2, elements: 'kaputt', appState: { viewBackgroundColor: '#fff' } },
      { type: 'excalidraw', version: 2, elements: [{ id: 'a' }], appState: { viewBackgroundColor: '#fff' } },
      { type: 'excalidraw', version: 2, elements: [], appState: null },
    ]

    for (const file of faelle) {
      const response = await post(app, team.ada, BOARD_IMPORT_PATH, { boardId: team.board.id, baseVersion: 0, file })
      expect(response.status, JSON.stringify(file)).toBe(400)
    }
    expect(await storedVersions(pool, team.board.id)).toBe(0)
  })

  it('laedt keine externe Assetreferenz nach und uebernimmt keinen ausfuehrbaren Verweis', async () => {
    const team = await teamMitBoard(app)
    const basis = {
      type: 'excalidraw',
      version: 2,
      source: 'fremd',
      appState: { viewBackgroundColor: '#ffffff', gridSize: null },
    }

    const extern = await post(app, team.ada, BOARD_IMPORT_PATH, {
      boardId: team.board.id,
      baseVersion: 0,
      file: {
        ...basis,
        elements: [element('a', 1, { type: 'image', fileId: 'bild-1' })],
        files: { 'bild-1': { id: 'bild-1', mimeType: 'image/png', dataURL: 'https://fremd.example/x.png' } },
      },
    })
    const skript = await post(app, team.ada, BOARD_IMPORT_PATH, {
      boardId: team.board.id,
      baseVersion: 0,
      file: { ...basis, elements: [element('a', 1, { link: 'javascript:alert(1)' })] },
    })

    expect([extern.status, skript.status]).toEqual([400, 400])
    expect(await storedVersions(pool, team.board.id)).toBe(0)
    expect(await pool.query('select 1 from board_assets')).toHaveProperty('rowCount', 0)
  })

  it('nimmt kein eingebettetes Bild an, das kein erlaubtes Bildformat ist', async () => {
    const team = await teamMitBoard(app)

    const response = await post(app, team.ada, BOARD_IMPORT_PATH, {
      boardId: team.board.id,
      baseVersion: 0,
      file: {
        type: 'excalidraw',
        version: 2,
        source: 'fremd',
        elements: [],
        appState: { viewBackgroundColor: '#ffffff', gridSize: null },
        // Ein SVG-Dokument, das sich als PNG ausgibt: der behauptete Typ ist nicht erlaubt, und die
        // Signaturbytes passen ohnehin nicht dazu.
        files: {
          'bild-1': {
            id: 'bild-1',
            mimeType: 'image/png',
            dataURL: `data:image/png;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`,
          },
        },
      },
    })

    expect(response.status).toBe(415)
    expect(await pool.query('select 1 from board_assets')).toHaveProperty('rowCount', 0)
  })

  it('laesst einen Viewer exportieren, aber nicht importieren', async () => {
    const team = await boardMitZweiStaenden()
    await post(app, team.ada, BOARD_GRANT_ADD_PATH, {
      boardId: team.board.id,
      userId: team.bob.profile.user.id,
      role: 'viewer',
    })
    const datei = await exportiere(app, team.bob, team.board.id)

    const response = await post(app, team.bob, BOARD_IMPORT_PATH, {
      boardId: team.board.id,
      baseVersion: 2,
      file: datei,
    })

    expect(response.status).toBe(403)
    expect(await aktuelleVersion(team.board.id)).toBe(2)
  })

  it('schuetzt den Import mit derselben Versionspruefung wie eine Speicherung', async () => {
    const team = await boardMitZweiStaenden()
    const datei = await exportiere(app, team.ada, team.board.id)
    await speichere(app, team.ada, team.board.id, 2, [element('a'), element('b'), element('c')])

    const response = await post(app, team.ada, BOARD_IMPORT_PATH, {
      boardId: team.board.id,
      baseVersion: 2,
      file: datei,
    })

    expect(response.status).toBe(409)
    expect(await aktuelleVersion(team.board.id)).toBe(3)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Aufbewahrungsgrenze und Importlimit                                                                   */
/* ---------------------------------------------------------------------------------------------------- */

describe('Aufbewahrungsgrenze und Importlimit', () => {
  it('haelt genau die juengsten Versionen und laesst aeltere fallen', async () => {
    const ada = await signedInAs(eng, 'ada')
    const workspace = await createWorkspace(eng, ada, 'Team Nord')
    const board = await createBoard(eng, ada, workspace.id, 'Skizze')
    const runden = ENGE_RETENTION + 2
    for (let runde = 0; runde < runden; runde += 1) {
      await speichere(eng, ada, board.id, runde, [element('a', runde + 1)])
    }

    const liste = await versionen(eng, ada, board.id)

    expect(await storedVersions(pool, board.id)).toBe(ENGE_RETENTION)
    expect(liste.retention).toBe(ENGE_RETENTION)
    expect(liste.versions).toHaveLength(ENGE_RETENTION)
    expect(liste.versions[0]?.version).toBe(runden)
    // Was herausgefallen ist, gibt es auch in der Vorschau und in der Wiederherstellung nicht mehr.
    const vorschau = await get(eng, ada, BOARD_VERSION_SCENE_PATH, {
      [BOARD_ID_PARAM]: board.id,
      [BOARD_VERSION_PARAM]: '1',
    })
    const wiederherstellung = await post(eng, ada, BOARD_VERSION_RESTORE_PATH, {
      boardId: board.id,
      version: 1,
      baseVersion: runden,
    })
    expect([vorschau.status, wiederherstellung.status]).toEqual([404, 404])
  })

  it('weist eine uebergrosse Importdatei ab, bevor sie vollstaendig im Speicher landet', async () => {
    const ada = await signedInAs(eng, 'ada')
    const workspace = await createWorkspace(eng, ada, 'Team Nord')
    const board = await createBoard(eng, ada, workspace.id, 'Skizze')

    const response = await post(eng, ada, BOARD_IMPORT_PATH, {
      boardId: board.id,
      baseVersion: 0,
      file: {
        type: 'excalidraw',
        version: 2,
        source: 'fremd',
        elements: [element('a', 1, { text: 'x'.repeat(ENGES_IMPORTLIMIT + 1024) })],
        appState: { viewBackgroundColor: '#ffffff', gridSize: null },
      },
    })

    expect(response.status).toBe(413)
    expect(await storedVersions(pool, board.id)).toBe(0)
  })
})
