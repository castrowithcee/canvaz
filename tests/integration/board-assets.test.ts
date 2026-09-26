/**
 * Bildassets gegen die echte Anwendung, eine echte Datenbank und beide echten Storage-Adapter.
 *
 * Es gibt keinen verkuerzten Weg an den Guards vorbei: jeder Test meldet sich ueber den echten OIDC-Fluss
 * an und spricht dieselben HTTP-Endpunkte an wie die SPA - samt CSRF-Token und Session-Cookie. Der
 * Neustart-Nachweis laeuft fuer `filesystem` und fuer `s3` (SeaweedFS); alles andere ist adapterunabhaengig und
 * wird deshalb einmal geprueft, gegen den Adapter, den die Standardkonfiguration faehrt.
 */

import { request as httpRequest } from 'node:http'
import { rm } from 'node:fs/promises'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  ADMIN_USER_STATUS_PATH,
  ASSET_FILE_ID_PARAM,
  ASSET_FILE_NAME_PARAM,
  BOARD_ASSETS_PATH,
  BOARD_ID_PARAM,
  BOARD_SCENE_PATH,
  BOARD_STATUS_PATH,
  BOARDS_PATH,
  CSRF_HEADER,
  ME_PATH,
  WORKSPACE_MEMBER_ADD_PATH,
  WORKSPACE_MEMBER_REMOVE_PATH,
  WORKSPACE_STATUS_PATH,
  WORKSPACES_PATH,
} from '../../src/contracts/api.js'
import type {
  BoardView,
  MeResponse,
  UploadBoardAssetResponse,
  WorkspaceView,
} from '../../src/contracts/api.js'
import type { SceneSnapshot } from '../../src/contracts/scene.js'
import { SCENE_SCHEMA_VERSION } from '../../src/contracts/scene.js'
import type { BinaryFileRef } from '../../src/contracts/scene.js'
import type { WorkspaceRole } from '../../src/domain/workspace/model.js'
import { ensureS3Bucket } from '../../src/persistence/asset-storage-s3.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import {
  MISSING_TEST_S3_HINT,
  TEST_S3,
  createFilesystemRoot,
  filesystemEnv,
  s3Env,
} from '../support/asset-storage-env.js'
import { createJar } from '../support/browser-client.js'
import type { Jar } from '../support/browser-client.js'
import { login } from '../support/login-flow.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

const FREMDE_KENNUNG = '00000000-0000-4000-8000-000000000000'

let pool: Pool
let provider: TestProvider
let app: TestApp
let wurzel = ''

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  try {
    await pool.query('select 1')
  } catch (error) {
    throw new Error(`Keine Testdatenbank unter ${DATABASE_URL}. Zuerst "npm run db:up" ausfuehren.`, { cause: error })
  }
  await migrate(pool)
  try {
    await ensureS3Bucket(TEST_S3)
  } catch (error) {
    throw new Error(MISSING_TEST_S3_HINT, { cause: error })
  }
  provider = await startTestProvider()
  wurzel = await createFilesystemRoot()
  app = await startTestApp({ provider, pool, databaseUrl: DATABASE_URL, storage: filesystemEnv(wurzel) })
})

afterAll(async () => {
  await app.close()
  await provider.close()
  await pool.end()
  await rm(wurzel, { recursive: true, force: true })
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
  provider.resetBehaviour()
  app.clearLogs()
})

/* ---------------------------------------------------------------------------------------------------- */
/* Testhilfen                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

type Account = { readonly jar: Jar; readonly profile: MeResponse }

async function signedInAs(subject: string, target: TestApp = app): Promise<Account> {
  const jar = createJar()
  const result = await login(target, jar, { subject })
  expect(result.error).toBeNull()
  const response = await jar.fetch(`${target.baseUrl}${ME_PATH}`)
  expect(response.status).toBe(200)
  return { jar, profile: (await response.json()) as MeResponse }
}

function post(account: Account, path: string, body: unknown): Promise<Response> {
  return account.jar.fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: account.profile.csrfToken },
    body: JSON.stringify(body),
  })
}

async function createWorkspace(account: Account, name: string): Promise<WorkspaceView> {
  const response = await post(account, WORKSPACES_PATH, { name })
  expect(response.status).toBe(201)
  return (await response.json()) as WorkspaceView
}

async function addMember(owner: Account, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
  expect((await post(owner, WORKSPACE_MEMBER_ADD_PATH, { workspaceId, userId, role })).status).toBe(201)
}

async function createBoard(account: Account, workspaceId: string, title: string): Promise<BoardView> {
  const response = await post(account, BOARDS_PATH, { workspaceId, title })
  expect(response.status).toBe(201)
  return (await response.json()) as BoardView
}

/** Gueltige PNG-Signatur plus beliebiger Rest. Fuer die Inhaltspruefung zaehlen nur die ersten Bytes. */
function png(inhalt: string): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(inhalt)])
}

function gif(inhalt: string): Uint8Array {
  return new Uint8Array([...new TextEncoder().encode('GIF89a'), ...new TextEncoder().encode(inhalt)])
}

type UploadOptions = {
  readonly contentType?: string
  readonly csrf?: boolean
  readonly fileName?: string
  readonly app?: TestApp
}

function assetUrl(target: TestApp, boardId: string, fileId: string, fileName?: string): string {
  const params = new URLSearchParams({ [BOARD_ID_PARAM]: boardId, [ASSET_FILE_ID_PARAM]: fileId })
  if (fileName !== undefined) {
    params.set(ASSET_FILE_NAME_PARAM, fileName)
  }
  return `${target.baseUrl}${BOARD_ASSETS_PATH}?${params.toString()}`
}

function upload(
  account: Account,
  boardId: string,
  fileId: string,
  bytes: Uint8Array,
  options: UploadOptions = {},
): Promise<Response> {
  const target = options.app ?? app
  return account.jar.fetch(assetUrl(target, boardId, fileId, options.fileName), {
    method: 'POST',
    headers: {
      'content-type': options.contentType ?? 'image/png',
      ...(options.csrf === false ? {} : { [CSRF_HEADER]: account.profile.csrfToken }),
    },
    body: bytes.slice(),
  })
}

function download(account: Account, boardId: string, fileId: string, target: TestApp = app): Promise<Response> {
  return account.jar.fetch(assetUrl(target, boardId, fileId))
}

async function uploadOk(account: Account, boardId: string, fileId: string, bytes: Uint8Array): Promise<BinaryFileRef> {
  const response = await upload(account, boardId, fileId, bytes)
  expect(response.status).toBe(201)
  return ((await response.json()) as UploadBoardAssetResponse).file
}

async function assetCount(boardId: string): Promise<number> {
  const result = await pool.query<{ count: string }>('select count(*)::text as count from board_assets where board_id = $1', [
    boardId,
  ])
  return Number(result.rows[0]?.count ?? '0')
}

/**
 * Bricht einen Upload mitten im Transfer ab: angekuendigt werden mehr Bytes, als geliefert werden, dann
 * faellt die Verbindung. `fetch` kann das nicht, deshalb hier die rohe HTTP-Anfrage.
 */
async function abgebrochenerUpload(account: Account, boardId: string, fileId: string): Promise<void> {
  const url = new URL(assetUrl(app, boardId, fileId))
  await new Promise<void>((resolve) => {
    const anfrage = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'content-length': '4096',
        [CSRF_HEADER]: account.profile.csrfToken,
        cookie: account.jar.cookieHeader(),
      },
    })
    anfrage.on('error', () => {
      resolve()
    })
    anfrage.write(Buffer.from(png('nur der Anfang')), () => {
      anfrage.destroy()
      resolve()
    })
  })
  // Dem Server einen Augenblick lassen, den Abbruch zu bemerken.
  await new Promise((resolve) => setTimeout(resolve, 150))
}

function szeneMitBild(boardId: string, file: BinaryFileRef | null): SceneSnapshot {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    boardId,
    elements:
      file === null
        ? []
        : [{ id: 'bild-1', type: 'image', version: 1, versionNonce: 1, fileId: file.id, status: 'saved' }],
    appState: { viewBackgroundColor: '#ffffff', gridSize: null, gridModeEnabled: false, name: 'Bildboard' },
    files: file === null ? {} : { [file.id]: file },
    updatedAt: 1_700_000_000_000,
  }
}

/* ---------------------------------------------------------------------------------------------------- */
/* Upload                                                                                                */
/* ---------------------------------------------------------------------------------------------------- */

describe('Upload', () => {
  it('nimmt ein Bild an, speichert Metadaten und liefert die Referenz der Szene', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    const bytes = png('erstes Bild')

    const response = await upload(ada, board.id, 'datei-1', bytes, { fileName: 'skizze.png' })

    expect(response.status).toBe(201)
    const { file } = (await response.json()) as UploadBoardAssetResponse
    expect(file.id).toBe('datei-1')
    expect(file.mimeType).toBe('image/png')
    expect(file.byteSize).toBe(bytes.byteLength)
    // Der Speicherschluessel entsteht auf dem Server aus Board und Pruefsumme; der Client denkt ihn sich nicht aus.
    expect(file.storageKey.startsWith(`boards/${board.id}/`)).toBe(true)

    const zeile = await pool.query<{ file_name: string; mime_type: string; checksum_sha256: string; workspace_id: string }>(
      'select file_name, mime_type, checksum_sha256, workspace_id from board_assets where board_id = $1',
      [board.id],
    )
    expect(zeile.rows[0]?.file_name).toBe('skizze.png')
    expect(zeile.rows[0]?.mime_type).toBe('image/png')
    expect(zeile.rows[0]?.workspace_id).toBe(workspace.id)
    expect(zeile.rows[0]?.checksum_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('behandelt denselben Inhalt unter derselben Kennung als bereits erledigt', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    const bytes = png('doppelt haelt besser')

    const erste = await upload(ada, board.id, 'datei-1', bytes)
    const zweite = await upload(ada, board.id, 'datei-1', bytes)

    expect(erste.status).toBe(201)
    // Kein Fehler und kein zweiter Datensatz: der Upload ist idempotent ueber die Pruefsumme.
    expect(zweite.status).toBe(200)
    expect(((await erste.json()) as UploadBoardAssetResponse).file).toEqual(
      ((await zweite.json()) as UploadBoardAssetResponse).file,
    )
    expect(await assetCount(board.id)).toBe(1)
  })

  it('weist einen anderen Inhalt unter einer vergebenen Kennung ab, statt ihn zu ueberschreiben', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    await uploadOk(ada, board.id, 'datei-1', png('das Original'))

    const response = await upload(ada, board.id, 'datei-1', png('etwas ganz anderes'))

    expect(response.status).toBe(409)
    expect(await assetCount(board.id)).toBe(1)
    const geladen = await download(ada, board.id, 'datei-1')
    expect(Buffer.from(await geladen.arrayBuffer()).toString('utf8')).toContain('das Original')
  })

  it('lehnt einen unzulaessigen Typ und jede Abweichung zwischen Behauptung und Inhalt ab', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

    // 1. Ein Typ, der gar nicht erlaubt ist.
    expect((await upload(ada, board.id, 'a', svg, { contentType: 'image/svg+xml' })).status).toBe(415)
    // 2. Erlaubte Behauptung, aber der Inhalt ist etwas anderes - der klassische Fall "Endung .png".
    expect((await upload(ada, board.id, 'b', svg, { contentType: 'image/png' })).status).toBe(415)
    // 3. Erlaubter Inhalt, aber falsch behauptet. Auch das ist eine Abweichung.
    expect((await upload(ada, board.id, 'c', png('echt'), { contentType: 'image/jpeg' })).status).toBe(415)
    // 4. Ohne jede Behauptung.
    expect((await upload(ada, board.id, 'd', png('echt'), { contentType: 'application/octet-stream' })).status).toBe(415)
    // 5. Ein zweites erlaubtes Format wird dagegen angenommen.
    expect((await upload(ada, board.id, 'e', gif('bewegt'), { contentType: 'image/gif' })).status).toBe(201)

    expect(await assetCount(board.id)).toBe(1)
  })

  it('weist ein zu grosses Bild ab, ohne etwas zu speichern', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    const zuGross = png('x'.repeat(app.context.config.storage.maxAssetBytes))

    const response = await upload(ada, board.id, 'datei-1', zuGross)

    expect(response.status).toBe(413)
    expect(await assetCount(board.id)).toBe(0)
    expect((await download(ada, board.id, 'datei-1')).status).toBe(404)
  })

  it('hinterlaesst nach einem abgebrochenen Transfer weder Bytes noch Metadaten', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')

    await abgebrochenerUpload(ada, board.id, 'datei-1')

    expect(await assetCount(board.id)).toBe(0)
    expect((await download(ada, board.id, 'datei-1')).status).toBe(404)
    // Der zweite, vollstaendige Versuch geht durch: der Abbruch hat nichts blockiert.
    expect((await upload(ada, board.id, 'datei-1', png('vollstaendig'))).status).toBe(201)
  })

  it('verlangt Sitzung, CSRF-Token, Inhalt und eine gueltige Dateikennung', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    const anonym: Account = { jar: createJar(), profile: { user: {} as never, csrfToken: 'x' } }

    expect((await upload(anonym, board.id, 'datei-1', png('fremd'))).status).toBe(401)
    expect((await download(anonym, board.id, 'datei-1')).status).toBe(401)
    expect((await upload(ada, board.id, 'datei-1', png('ohne'), { csrf: false })).status).toBe(403)
    expect((await upload(ada, board.id, 'datei-1', new Uint8Array(0))).status).toBe(400)
    for (const kennung of ['../ausbruch', 'mit/schraegstrich', '.versteckt', '', 'x'.repeat(256)]) {
      expect((await upload(ada, board.id, kennung, png('x'))).status, kennung).toBe(400)
    }
    expect(await assetCount(board.id)).toBe(0)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Abruf und Autorisierung                                                                               */
/* ---------------------------------------------------------------------------------------------------- */

describe('Abruf', () => {
  it('liefert die Bytes mit dem gespeicherten Typ und ohne jede Zwischenspeicherung', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    const bytes = png('sichtbarer Inhalt')
    await uploadOk(ada, board.id, 'datei-1', bytes)

    const response = await download(ada, board.id, 'datei-1')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength))
    // Berechtigungsabhaengiger Inhalt gehoert in keinen geteilten und in keinen privaten Zwischenspeicher.
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true)
  })

  it('meldet einen fehlenden Speicherinhalt als Fehler, statt ihn als unbekannt auszugeben', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    const file = await uploadOk(ada, board.id, 'datei-1', png('gleich weg'))

    // Ein Eingriff an der Anwendung vorbei: die Metadaten sagen, dass es die Bytes gibt.
    await app.context.storage.delete(file.storageKey)

    const response = await download(ada, board.id, 'datei-1')
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('fehlt im Speicher')
  })

  it('gibt fremden, geratenen und unbekannten Kennungen nichts preis', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    await uploadOk(ada, board.id, 'datei-1', png('vertraulich'))

    // Nichtmitglied: dieselbe Antwort wie fuer eine erfundene Boardkennung.
    expect((await download(bob, board.id, 'datei-1')).status).toBe(404)
    expect((await upload(bob, board.id, 'datei-2', png('uebernommen'))).status).toBe(404)
    expect((await download(bob, FREMDE_KENNUNG, 'datei-1')).status).toBe(404)
    // Mitglied, aber geratene Dateikennung im eigenen Board.
    expect((await download(ada, board.id, 'geraten')).status).toBe(404)
    expect((await download(ada, board.id, 'ungueltige/kennung')).status).toBe(404)
    expect(await assetCount(board.id)).toBe(1)
  })

  it('gibt einem Systemadmin ohne Mitgliedschaft keinen Bildzugriff', async () => {
    const root = await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    await uploadOk(ada, board.id, 'datei-1', png('intern'))

    expect((await download(root, board.id, 'datei-1')).status).toBe(404)
    expect((await upload(root, board.id, 'datei-2', png('von oben'))).status).toBe(404)
  })

  it('entzieht einem deaktivierten Nutzer den Bildzugriff', async () => {
    const root = await signedInAs('root')
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    await addMember(ada, workspace.id, bob.profile.user.id, 'member')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    await uploadOk(ada, board.id, 'datei-1', png('gemeinsam'))
    expect((await download(bob, board.id, 'datei-1')).status).toBe(200)

    expect(
      (await post(root, ADMIN_USER_STATUS_PATH, { userId: bob.profile.user.id, status: 'deactivated' })).status,
    ).toBe(200)

    expect((await download(bob, board.id, 'datei-1')).status).toBe(401)
  })

  it('beendet den Zugriff in dem Augenblick, in dem die Berechtigung entzogen wird', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    await addMember(ada, workspace.id, bob.profile.user.id, 'member')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    await uploadOk(ada, board.id, 'datei-1', png('nur fuer Mitglieder'))
    expect((await download(bob, board.id, 'datei-1')).status).toBe(200)

    expect(
      (await post(ada, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: bob.profile.user.id }))
        .status,
    ).toBe(200)

    // Es gibt keine vorsignierte oder anderweitig vorab ausgestellte Bild-URL, die den Entzug ueberleben
    // koennte: jeder einzelne Abruf entscheidet neu.
    expect((await download(bob, board.id, 'datei-1')).status).toBe(404)
    expect((await bob.jar.fetch(assetUrl(app, board.id, 'datei-1'))).status).toBe(404)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Archivierung und Aufraeumen                                                                           */
/* ---------------------------------------------------------------------------------------------------- */

describe('Archivierung und Bestand', () => {
  it('haelt Bilder eines archivierten Boards lesbar und den Upload unveraenderlich', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    await uploadOk(ada, board.id, 'datei-1', png('bleibt lesbar'))

    expect((await post(ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(200)

    // Lesbar wie die Szene: Archivieren loescht nichts, es macht unveraenderlich.
    expect((await download(ada, board.id, 'datei-1')).status).toBe(200)
    expect((await upload(ada, board.id, 'datei-2', png('neu'))).status).toBe(403)
    expect(await assetCount(board.id)).toBe(1)

    expect((await post(ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'active' })).status).toBe(200)
    expect((await upload(ada, board.id, 'datei-2', png('neu'))).status).toBe(201)
  })

  it('macht mit dem Arbeitsbereich auch den Bildupload unveraenderlich', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    await uploadOk(ada, board.id, 'datei-1', png('vorher'))

    expect((await post(ada, WORKSPACE_STATUS_PATH, { workspaceId: workspace.id, status: 'archived' })).status).toBe(200)

    expect((await download(ada, board.id, 'datei-1')).status).toBe(200)
    expect((await upload(ada, board.id, 'datei-2', png('nachher'))).status).toBe(403)
  })

  it('behaelt ein Bild, dessen Element aus der Szene entfernt wurde', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    const file = await uploadOk(ada, board.id, 'datei-1', png('erst drin, dann raus'))
    expect(
      (await post(ada, BOARD_SCENE_PATH, { boardId: board.id, baseVersion: 0, scene: szeneMitBild(board.id, file) }))
        .status,
    ).toBe(200)

    // Der Nutzer loescht das Bildelement und speichert erneut - die Szene verweist nicht mehr darauf.
    expect(
      (await post(ada, BOARD_SCENE_PATH, { boardId: board.id, baseVersion: 1, scene: szeneMitBild(board.id, null) }))
        .status,
    ).toBe(200)

    // Bewusst kein Hard Delete: die aeltere Szenenversion verweist weiter auf das Bild, und ein Rueckgaengig
    // oder ein Blick in die Historie muesste es sonst ins Leere laufen lassen.
    expect(await assetCount(board.id)).toBe(1)
    expect((await download(ada, board.id, 'datei-1')).status).toBe(200)
    const kennungen = await pool.query<{ file_id: string }>(
      'select file_id from board_assets where board_id = $1',
      [board.id],
    )
    expect(kennungen.rows.map((row) => row.file_id)).toEqual(['datei-1'])
  })

  it('nimmt Assetdatensaetze mit dem Board aus der Datenbank, wenn dort geloescht wird', async () => {
    await signedInAs('root')
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    const board = await createBoard(ada, workspace.id, 'Bildboard')
    await uploadOk(ada, board.id, 'datei-1', png('haengt am Board'))

    // Ueber die Anwendung gibt es diesen Weg nicht; der Fremdschluessel beschreibt nur, was direkt in der
    // Datenbank geschieht.
    await pool.query('delete from workspaces where id = $1', [workspace.id])

    expect(await assetCount(board.id)).toBe(0)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Neustart, fuer beide Adapter                                                                          */
/* ---------------------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------------------- */
/* Gleicher Inhalt unter zwei Kennungen, fuer beide Adapter                                               */
/* ---------------------------------------------------------------------------------------------------- */

describe('Derselbe Inhalt unter zwei Dateikennungen', () => {
  /** Meldet einen Nutzer an und legt Arbeitsbereich und Board auf der angegebenen Instanz an. */
  async function boardAuf(instanz: TestApp): Promise<{ readonly account: Account; readonly boardId: string }> {
    await signedInAs('root', instanz)
    const account = await signedInAs('ada', instanz)
    const workspaceAntwort = await account.jar.fetch(`${instanz.baseUrl}${WORKSPACES_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: account.profile.csrfToken },
      body: JSON.stringify({ name: 'Team Nord' }),
    })
    expect(workspaceAntwort.status).toBe(201)
    const workspace = (await workspaceAntwort.json()) as WorkspaceView
    const boardAntwort = await account.jar.fetch(`${instanz.baseUrl}${BOARDS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: account.profile.csrfToken },
      body: JSON.stringify({ workspaceId: workspace.id, title: 'Bildboard' }),
    })
    expect(boardAntwort.status).toBe(201)
    return { account, boardId: ((await boardAntwort.json()) as BoardView).id }
  }

  /**
   * Zwei Dateikennungen mit identischem Inhalt im selben Board sind ein gueltiger Fall. Der zweite Upload
   * darf weder scheitern noch die Bytes des ersten anruehren - der erste bleibt vollstaendig abrufbar.
   */
  async function zweiKennungen(storage: Readonly<Record<string, string>>): Promise<void> {
    const instanz = await startTestApp({ provider, pool, databaseUrl: DATABASE_URL, storage })
    try {
      const { account, boardId } = await boardAuf(instanz)
      const bytes = png(`derselbe Inhalt fuer ${storage['CANVAZ_STORAGE_ADAPTER'] ?? ''}`)

      expect((await upload(account, boardId, 'erste', bytes, { app: instanz })).status).toBe(201)
      expect((await upload(account, boardId, 'zweite', bytes, { app: instanz })).status).toBe(201)

      for (const kennung of ['erste', 'zweite']) {
        const geladen = await download(account, boardId, kennung, instanz)
        expect(geladen.status, kennung).toBe(200)
        expect(Buffer.from(await geladen.arrayBuffer()).equals(Buffer.from(bytes)), kennung).toBe(true)
      }
      expect(await assetCount(boardId)).toBe(2)
    } finally {
      await instanz.close()
    }
  }

  it('haelt beide Dateien abrufbar: Adapter filesystem', async () => {
    const eigeneWurzel = await createFilesystemRoot()
    try {
      await zweiKennungen(filesystemEnv(eigeneWurzel))
    } finally {
      await rm(eigeneWurzel, { recursive: true, force: true })
    }
  })

  it('haelt beide Dateien abrufbar: Adapter s3 (SeaweedFS)', async () => {
    await zweiKennungen(s3Env())
  })
})

describe('Neustart der Anwendung', () => {
  /**
   * Derselbe Ablauf fuer beide Adapter: hochladen, den Anwendungsprozess vollstaendig ersetzen, abrufen.
   * Weder Browserspeicher noch Containerlayer sind beteiligt - die Bytes liegen im konfigurierten Ziel.
   */
  async function ueberlebtNeustart(storage: Readonly<Record<string, string>>): Promise<void> {
    const erste = await startTestApp({ provider, pool, databaseUrl: DATABASE_URL, storage })
    let boardId: string
    const bytes = png(`Inhalt fuer ${storage['CANVAZ_STORAGE_ADAPTER'] ?? ''}`)
    try {
      await signedInAs('root', erste)
      const ada = await signedInAs('ada', erste)
      const workspaceAntwort = await ada.jar.fetch(`${erste.baseUrl}${WORKSPACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: ada.profile.csrfToken },
        body: JSON.stringify({ name: 'Team Nord' }),
      })
      expect(workspaceAntwort.status).toBe(201)
      const workspace = (await workspaceAntwort.json()) as WorkspaceView
      const boardAntwort = await ada.jar.fetch(`${erste.baseUrl}${BOARDS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: ada.profile.csrfToken },
        body: JSON.stringify({ workspaceId: workspace.id, title: 'Bildboard' }),
      })
      expect(boardAntwort.status).toBe(201)
      boardId = ((await boardAntwort.json()) as BoardView).id
      expect((await upload(ada, boardId, 'datei-1', bytes, { app: erste })).status).toBe(201)
    } finally {
      await erste.close()
    }

    const zweite = await startTestApp({ provider, pool, databaseUrl: DATABASE_URL, storage })
    try {
      const ada = await signedInAs('ada', zweite)
      const response = await download(ada, boardId, 'datei-1', zweite)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true)
    } finally {
      await zweite.close()
    }
  }

  it('haelt ein Bild ueber einen Neustart hinweg: Adapter filesystem', async () => {
    const eigeneWurzel = await createFilesystemRoot()
    try {
      await ueberlebtNeustart(filesystemEnv(eigeneWurzel))
    } finally {
      await rm(eigeneWurzel, { recursive: true, force: true })
    }
  })

  it('haelt ein Bild ueber einen Neustart hinweg: Adapter s3 (SeaweedFS)', async () => {
    await ueberlebtNeustart(s3Env())
  })
})
