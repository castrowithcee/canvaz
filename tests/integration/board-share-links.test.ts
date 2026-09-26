/**
 * Oeffentliche Gastfreigaben gegen die echte Anwendung und eine echte Datenbank.
 *
 * Es gibt keinen verkuerzten Weg an den Guards vorbei: der Owner meldet sich ueber den echten OIDC-Fluss an,
 * und der Gast tritt ausschliesslich mit dem Token bei, das die Anlage genau einmal ausgegeben hat - danach
 * spricht er dieselben Endpunkte an wie die SPA, samt Gastcookie und eigenem CSRF-Token.
 *
 * Die Wirkung einer Freigabe wird nie an ihrer eigenen Antwort gemessen, sondern an dem, was der Gast
 * danach tatsaechlich noch darf: welche Szene er sieht, was er speichern kann, was ihm verschlossen bleibt
 * und was mit seiner offenen Verbindung geschieht, wenn der Link endet.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  ADMIN_USERS_PATH,
  ADMIN_USER_STATUS_PATH,
  BOARDS_PATH,
  BOARD_ASSETS_PATH,
  BOARD_GRANTS_PATH,
  BOARD_GRANT_ADD_PATH,
  BOARD_GUEST_JOIN_PATH,
  BOARD_GUEST_SESSION_PATH,
  BOARD_ID_PARAM,
  BOARD_OWNER_PATH,
  BOARD_RENAME_PATH,
  BOARD_SCENE_PATH,
  BOARD_SHARE_LINKS_PATH,
  BOARD_SHARE_LINK_CREATE_PATH,
  BOARD_SHARE_LINK_REVOKE_PATH,
  BOARD_STATUS_PATH,
  CSRF_HEADER,
  WORKSPACES_PATH,
  WORKSPACE_ID_PARAM,
  WORKSPACE_MEMBERS_PATH,
  WORKSPACE_MEMBER_ADD_PATH,
  WORKSPACE_MEMBER_CANDIDATES_PATH,
} from '../../src/contracts/api.js'
import type {
  BoardSceneResponse,
  BoardShareLinksResponse,
  CreateBoardShareLinkResponse,
  GuestBoardSceneResponse,
  GuestSessionResponse,
} from '../../src/contracts/api.js'
import { BOARD_ACCESS_REVOKED_CLOSE_CODE, SESSION_REVOKED_CLOSE_CODE } from '../../src/contracts/realtime.js'
import type { SceneSnapshot } from '../../src/contracts/scene.js'
import { DEFAULT_APP_STATE, SCENE_SCHEMA_VERSION } from '../../src/contracts/scene.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { GUEST_COOKIE } from '../../src/server/guest-session.js'
import { addMember, createBoard, createWorkspace, post, signedInAs } from '../support/board-fixture.js'
import type { Account } from '../support/board-fixture.js'
import { createJar } from '../support/browser-client.js'
import type { Jar } from '../support/browser-client.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { change, element, openRealtime, ruhe } from '../support/realtime-socket.js'
import type { RealtimeTestClient } from '../support/realtime-socket.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

/** Eine erfundene, gueltig geformte Kennung. Sie darf sich von einer fremden nicht unterscheiden lassen. */
const FREMDE_KENNUNG = '00000000-0000-4000-8000-000000000000'

/**
 * Die beiden endgueltigen Schliessgruende, mit denen ein beendeter Gastzugang ankommt.
 *
 * `4401` kommt vom Widerruf und vom Ablauf der Gastsession selbst, `4403` von der Nachpruefung des Raums.
 * Fuer einen Gast treffen beim Ende seines Links beide zu; welcher zuerst greift, ist Reihenfolge und keine
 * Zusage. Gemeinsam ist ihnen das, worauf es ankommt: die Verbindung ist zu und kommt nicht wieder.
 */
const BEENDET = [SESSION_REVOKED_CLOSE_CODE, BOARD_ACCESS_REVOKED_CLOSE_CODE]

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
  app = await startTestApp({
    provider,
    pool,
    databaseUrl: DATABASE_URL,
    // Kurze Takte: der Test soll nicht auf Sekunden warten, die Logik bleibt dieselbe.
    rooms: { checkpointIdleMs: 60, checkpointMaxMs: 200, presenceIntervalMs: 15, accessCheckIntervalMs: 40 },
  })
})

afterAll(async () => {
  await app.close()
  await provider.close()
  await pool.end()
})

/* ---------------------------------------------------------------------------------------------------- */
/* Testhilfen                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

const clients: RealtimeTestClient[] = []

async function connect(cookieHeader: string): Promise<RealtimeTestClient> {
  const client = await openRealtime(app.baseUrl, cookieHeader)
  clients.push(client)
  return client
}

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
  expect(app.rooms.roomCount).toBe(0)
  await ruhe(100)
})

function szene(boardId: string, elementId = 'a'): SceneSnapshot {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    boardId,
    elements: [{ id: elementId, version: 1, versionNonce: 5, type: 'rectangle', x: 1, y: 2, width: 3, height: 4 }],
    appState: DEFAULT_APP_STATE,
    files: {},
    updatedAt: 1,
  }
}

type Freigabe = { readonly token: string; readonly id: string }

/** Legt einen Freigabelink ueber den echten Endpunkt an und gibt das genau einmal sichtbare Token zurueck. */
async function createShareLink(
  owner: Account,
  boardId: string,
  options: { readonly role?: string; readonly expiresInHours?: number } = {},
): Promise<Freigabe> {
  const response = await post(app, owner, BOARD_SHARE_LINK_CREATE_PATH, { boardId, ...options })
  expect(response.status, 'Freigabelink anlegen').toBe(201)
  const body = (await response.json()) as CreateBoardShareLinkResponse
  const url = new URL(body.url)
  expect(url.pathname).toBe('/gast')
  // Das Token steht im Fragment und nie in der Abfragezeichenfolge.
  expect(url.search).toBe('')
  expect(url.hash.length).toBeGreaterThan(1)
  return { token: url.hash.slice(1), id: body.link.id }
}

type Gast = { readonly jar: Jar; readonly session: GuestSessionResponse }

/** Tritt als Gast bei - genau so, wie es die Gastansicht tut: Token im Koerper, Cookie in der Antwort. */
async function joinAsGuest(token: string, displayName: string): Promise<Gast> {
  const jar = createJar()
  const response = await jar.fetch(`${app.baseUrl}${BOARD_GUEST_JOIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, displayName }),
  })
  expect(response.status, 'Gastbeitritt').toBe(201)
  const session = (await response.json()) as GuestSessionResponse
  expect(jar.cookies.get(GUEST_COOKIE)).toBeDefined()
  return { jar, session }
}

function guestGet(gast: Gast, path: string): Promise<Response> {
  return gast.jar.fetch(`${app.baseUrl}${path}`)
}

function guestPost(gast: Gast, path: string, body: unknown): Promise<Response> {
  return gast.jar.fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: gast.session.csrfToken },
    body: JSON.stringify(body),
  })
}

/** Standardaufbau: Ada besitzt Arbeitsbereich und Board, Bob ist Mitglied. */
async function aufbau() {
  const ada = await signedInAs(app, 'ada')
  const bob = await signedInAs(app, 'bob')
  const workspace = await createWorkspace(app, ada, 'Team Nord')
  await addMember(app, ada, workspace.id, bob)
  const board = await createBoard(app, ada, workspace.id, 'Skizze')
  return { ada, bob, workspace, board }
}

async function auditEvents(workspaceId: string) {
  return app.workspaces.audit.listForWorkspace(workspaceId)
}

/* ---------------------------------------------------------------------------------------------------- */
/* Anlegen, Auflisten, Widerrufen                                                                        */
/* ---------------------------------------------------------------------------------------------------- */

describe('Freigabelinks verwalten', () => {
  it('legt einen Link mit der lesenden Standardrolle an und zeigt das Token genau einmal', async () => {
    const { ada, workspace, board } = await aufbau()

    const antwort = await post(app, ada, BOARD_SHARE_LINK_CREATE_PATH, { boardId: board.id })
    expect(antwort.status).toBe(201)
    const angelegt = (await antwort.json()) as CreateBoardShareLinkResponse
    // Ohne ausdrueckliche Wahl bleibt es beim Lesen.
    expect(angelegt.link.role).toBe('guest-viewer')
    expect(angelegt.link.expiresAt).toBeNull()
    expect(angelegt.link.revokedAt).toBeNull()
    expect(angelegt.link.createdByDisplayName).toBe(ada.profile.user.displayName)
    const token = new URL(angelegt.url).hash.slice(1)

    // Die Liste kennt den Link, aber nirgends sein Token - auch nicht in einem anderen Feld.
    const liste = await ada.jar.fetch(`${app.baseUrl}${BOARD_SHARE_LINKS_PATH}?${BOARD_ID_PARAM}=${board.id}`)
    expect(liste.status).toBe(200)
    const roh = await liste.text()
    expect(roh).not.toContain(token)
    const gelistet = JSON.parse(roh) as BoardShareLinksResponse
    expect(gelistet.links).toHaveLength(1)
    expect(gelistet.links[0]?.id).toBe(angelegt.link.id)
    expect(gelistet.links[0]?.guestCount).toBe(0)

    // In der Datenbank steht ausschliesslich der Hash.
    const rows = await pool.query<{ token_hash: string }>('select token_hash from board_share_links')
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows.rows[0]?.token_hash).not.toBe(token)

    const events = await auditEvents(workspace.id)
    const erzeugt = events.filter((event) => event.action === 'board-share-link.created')
    expect(erzeugt).toHaveLength(1)
    expect(erzeugt[0]?.targetId).toBe(angelegt.link.id)
    expect(erzeugt[0]?.details).toEqual({ boardId: board.id, role: 'guest-viewer', expiresAt: null })
    expect(JSON.stringify(events)).not.toContain(token)
    expect(JSON.stringify(app.logs)).not.toContain(token)
  })

  it('nimmt die schreibende Rolle nur ausdruecklich und weist Unbekanntes ab', async () => {
    const { ada, board } = await aufbau()

    const schreibend = await post(app, ada, BOARD_SHARE_LINK_CREATE_PATH, { boardId: board.id, role: 'guest-editor' })
    expect(schreibend.status).toBe(201)
    expect(((await schreibend.json()) as CreateBoardShareLinkResponse).link.role).toBe('guest-editor')

    // Eine interne Boardrolle ist keine Gastrolle und darf hier nicht durchrutschen.
    for (const role of ['editor', 'viewer', 'owner', 'guest-admin']) {
      expect((await post(app, ada, BOARD_SHARE_LINK_CREATE_PATH, { boardId: board.id, role })).status, role).toBe(400)
    }
    for (const expiresInHours of [0, -1, 1.5, '24', 8_761]) {
      expect(
        (await post(app, ada, BOARD_SHARE_LINK_CREATE_PATH, { boardId: board.id, expiresInHours })).status,
        String(expiresInHours),
      ).toBe(400)
    }
  })

  it('laesst Links nur verwalten, wer das Board verantwortet', async () => {
    const { ada, bob, workspace, board } = await aufbau()
    const carl = await signedInAs(app, 'carl')
    const vorher = (await auditEvents(workspace.id)).length

    // Bob ist Mitglied und damit `editor` auf dem Board - Freigaben verwaltet er trotzdem nicht.
    expect((await post(app, bob, BOARD_SHARE_LINK_CREATE_PATH, { boardId: board.id })).status).toBe(403)
    const bobsListe = await bob.jar.fetch(`${app.baseUrl}${BOARD_SHARE_LINKS_PATH}?${BOARD_ID_PARAM}=${board.id}`)
    expect(bobsListe.status).toBe(403)

    // Carl ist nicht einmal Mitglied: fuer ihn gibt es das Board nicht.
    expect((await post(app, carl, BOARD_SHARE_LINK_CREATE_PATH, { boardId: board.id })).status).toBe(404)
    const carlsListe = await carl.jar.fetch(`${app.baseUrl}${BOARD_SHARE_LINKS_PATH}?${BOARD_ID_PARAM}=${board.id}`)
    expect(carlsListe.status).toBe(404)

    // Und eine erfundene Kennung sieht genauso aus wie ein fremdes Board.
    expect((await post(app, ada, BOARD_SHARE_LINK_CREATE_PATH, { boardId: FREMDE_KENNUNG })).status).toBe(404)

    // Kein abgelehnter Versuch hinterlaesst einen Nachweis - es ist ja nichts geschehen.
    expect(await auditEvents(workspace.id)).toHaveLength(vorher)
  })

  it('widerruft einen Link, haelt den Zeitpunkt fest und schreibt den Nachweis', async () => {
    const { ada, workspace, board } = await aufbau()
    const link = await createShareLink(ada, board.id)

    const erster = await post(app, ada, BOARD_SHARE_LINK_REVOKE_PATH, { boardId: board.id, shareLinkId: link.id })
    expect(erster.status).toBe(200)
    const rows = await pool.query<{ revoked_at: Date }>('select revoked_at from board_share_links')
    const zeitpunkt = rows.rows[0]?.revoked_at
    expect(zeitpunkt).not.toBeNull()

    // Ein zweiter Widerruf verschiebt den Nachweis nicht.
    expect(
      (await post(app, ada, BOARD_SHARE_LINK_REVOKE_PATH, { boardId: board.id, shareLinkId: link.id })).status,
    ).toBe(200)
    const wieder = await pool.query<{ revoked_at: Date }>('select revoked_at from board_share_links')
    expect(wieder.rows[0]?.revoked_at).toEqual(zeitpunkt)

    // Ein unbekannter Link ergibt 404, auch fuer den Owner.
    expect(
      (await post(app, ada, BOARD_SHARE_LINK_REVOKE_PATH, { boardId: board.id, shareLinkId: FREMDE_KENNUNG })).status,
    ).toBe(404)

    const widerrufen = (await auditEvents(workspace.id)).filter(
      (event) => event.action === 'board-share-link.revoked',
    )
    expect(widerrufen).toHaveLength(2)
    expect(widerrufen[0]?.details).toEqual({ boardId: board.id, role: 'guest-viewer' })
  })

  it('laesst einen Link eines fremden Boards nicht ueber das eigene widerrufen', async () => {
    const { ada, board } = await aufbau()
    const zweites = await createBoard(app, ada, board.workspaceId, 'Zweites')
    const link = await createShareLink(ada, board.id)

    // Der Link gehoert dem ersten Board; ueber das zweite ist er nicht erreichbar.
    expect(
      (await post(app, ada, BOARD_SHARE_LINK_REVOKE_PATH, { boardId: zweites.id, shareLinkId: link.id })).status,
    ).toBe(404)
    const gast = await joinAsGuest(link.token, 'Gast')
    expect((await guestGet(gast, BOARD_GUEST_SESSION_PATH)).status).toBe(200)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Beitritt                                                                                              */
/* ---------------------------------------------------------------------------------------------------- */

describe('Gastbeitritt', () => {
  it('tauscht ein gueltiges Token gegen eine Gastsession fuer genau ein Board', async () => {
    const { ada, workspace, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })

    const gast = await joinAsGuest(link.token, '  Gast   aus Nord  ')
    expect(gast.session.role).toBe('guest-editor')
    // Der Anzeigename wird normalisiert uebernommen.
    expect(gast.session.displayName).toBe('Gast aus Nord')
    expect(gast.session.board.id).toBe(board.id)
    expect(gast.session.board.title).toBe('Skizze')
    // Die Gastsicht traegt keinen Workspacebezug und keine Ownerangaben - nur den Inhalt und die eigene
    // Rolle, die der Gast mit dem Beitritt ohnehin erfaehrt.
    expect(Object.keys(gast.session.board).sort()).toEqual([
      'id',
      'sceneVersion',
      'status',
      'title',
      'viewerRole',
    ])

    // Auch das Gastgeheimnis steht nur als Hash in der Datenbank.
    const rows = await pool.query<{ token_hash: string; display_name: string; board_id: string }>(
      'select token_hash, display_name, board_id from board_guest_sessions',
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows.rows[0]?.board_id).toBe(board.id)
    expect(rows.rows[0]?.token_hash).not.toBe(gast.jar.cookies.get(GUEST_COOKIE))

    const beitritte = (await auditEvents(workspace.id)).filter((event) => event.action === 'board-guest.joined')
    expect(beitritte).toHaveLength(1)
    // Ein Gast ist kein interner Nutzer; der Nachweis nennt Link, Gastsession und Rolle - nie ein Token.
    expect(beitritte[0]?.actorId).toBeNull()
    expect(beitritte[0]?.targetId).toBe(link.id)
    expect(beitritte[0]?.details['role']).toBe('guest-editor')
    expect(beitritte[0]?.details['displayName']).toBe('Gast aus Nord')
    expect(JSON.stringify(beitritte)).not.toContain(link.token)
    expect(JSON.stringify(app.logs)).not.toContain(link.token)
    expect(JSON.stringify(app.logs)).not.toContain(gast.jar.cookies.get(GUEST_COOKIE))
  })

  it('zaehlt die Beitritte in der Liste des Owners mit', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id)
    await joinAsGuest(link.token, 'Erste')
    await joinAsGuest(link.token, 'Zweite')

    const liste = await ada.jar.fetch(`${app.baseUrl}${BOARD_SHARE_LINKS_PATH}?${BOARD_ID_PARAM}=${board.id}`)
    const body = (await liste.json()) as BoardShareLinksResponse
    expect(body.links[0]?.guestCount).toBe(2)
  })

  it('weist ein erfundenes, widerrufenes und abgelaufenes Token ununterscheidbar ab', async () => {
    const { ada, board } = await aufbau()
    const widerrufen = await createShareLink(ada, board.id)
    await post(app, ada, BOARD_SHARE_LINK_REVOKE_PATH, { boardId: board.id, shareLinkId: widerrufen.id })
    const abgelaufen = await createShareLink(ada, board.id, { expiresInHours: 1 })

    const antworten: number[] = []
    for (const token of ['gibt-es-nicht', widerrufen.token, '']) {
      const response = await fetch(`${app.baseUrl}${BOARD_GUEST_JOIN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, displayName: 'Gast' }),
      })
      antworten.push(response.status)
    }
    expect(antworten).toEqual([404, 404, 404])

    // Zwei Stunden spaeter ist auch der befristete Link nur noch eine erfundene Zeichenkette.
    app.setNow(new Date(Date.now() + 2 * 3600 * 1000))
    const spaeter = await fetch(`${app.baseUrl}${BOARD_GUEST_JOIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: abgelaufen.token, displayName: 'Gast' }),
    })
    expect(spaeter.status).toBe(404)
    expect(await pool.query('select 1 from board_guest_sessions')).toHaveProperty('rowCount', 0)
  })

  it('verlangt einen brauchbaren Anzeigenamen', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id)

    for (const displayName of ['', '   ', 'x'.repeat(61), 42, null]) {
      const response = await fetch(`${app.baseUrl}${BOARD_GUEST_JOIN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: link.token, displayName }),
      })
      expect(response.status, String(displayName)).toBe(400)
    }
  })

  it('lehnt einen Beitritt aus fremder Herkunft ab', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id)

    const response = await fetch(`${app.baseUrl}${BOARD_GUEST_JOIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://boese.example' },
      body: JSON.stringify({ token: link.token, displayName: 'Gast' }),
    })
    expect(response.status).toBe(403)
    expect(response.headers.getSetCookie()).toHaveLength(0)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Was ein Gast darf                                                                                     */
/* ---------------------------------------------------------------------------------------------------- */

describe('Rechte eines Gastes', () => {
  it('laesst einen guest-viewer die Szene lesen, aber nicht speichern', async () => {
    const { ada, board } = await aufbau()
    await post(app, ada, BOARD_SCENE_PATH, { boardId: board.id, baseVersion: 0, scene: szene(board.id) })
    const link = await createShareLink(ada, board.id)
    const gast = await joinAsGuest(link.token, 'Lesegast')

    const geladen = await guestGet(gast, `${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${board.id}`)
    expect(geladen.status).toBe(200)
    const inhalt = (await geladen.json()) as GuestBoardSceneResponse
    expect(inhalt.viewer).toBe('guest')
    expect(inhalt.version).toBe(1)
    expect(inhalt.scene.elements.map((entry) => entry.id)).toEqual(['a'])

    const gespeichert = await guestPost(gast, BOARD_SCENE_PATH, {
      boardId: board.id,
      baseVersion: 1,
      scene: szene(board.id, 'b'),
    })
    expect(gespeichert.status).toBe(403)
    const rows = await pool.query('select 1 from scene_versions where board_id = $1', [board.id])
    expect(rows.rowCount).toBe(1)
  })

  it('laesst einen guest-editor speichern und schreibt ihn nicht als Autor fort', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Schreibgast')

    const gespeichert = await guestPost(gast, BOARD_SCENE_PATH, {
      boardId: board.id,
      baseVersion: 0,
      scene: szene(board.id, 'gast'),
    })
    expect(gespeichert.status).toBe(200)

    const rows = await pool.query<{ version: number; author_user_id: string | null; scene: SceneSnapshot }>(
      'select version, author_user_id, scene from scene_versions where board_id = $1',
      [board.id],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.version).toBe(1)
    // Ein Gast ist kein Nutzer und steht deshalb nicht in der Autorenspalte.
    expect(rows.rows[0]?.author_user_id).toBeNull()
    expect(rows.rows[0]?.scene.elements.map((entry) => entry.id)).toEqual(['gast'])

    // Und das Mitglied sieht denselben Stand ueber seinen eigenen Weg.
    const gelesen = await ada.jar.fetch(`${app.baseUrl}${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${board.id}`)
    expect(((await gelesen.json()) as BoardSceneResponse).version).toBe(1)
  })

  it('verwehrt einem Gast jede Verwaltung des Boards', async () => {
    const { ada, bob, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Schreibgast')

    // Verwaltungsstrecken nehmen gar keine Gastsession an: dieselbe Antwort wie ohne jede Sitzung.
    for (const [path, body] of [
      [BOARD_RENAME_PATH, { boardId: board.id, title: 'Meins' }],
      [BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' }],
      [BOARD_GRANT_ADD_PATH, { boardId: board.id, userId: bob.profile.user.id, role: 'editor' }],
      [BOARD_OWNER_PATH, { boardId: board.id, userId: bob.profile.user.id }],
      [BOARD_SHARE_LINK_CREATE_PATH, { boardId: board.id }],
      [BOARD_SHARE_LINK_REVOKE_PATH, { boardId: board.id, shareLinkId: link.id }],
      [BOARDS_PATH, { workspaceId: board.workspaceId, title: 'Eigenes' }],
      [WORKSPACES_PATH, { name: 'Eigener' }],
    ] as const) {
      expect((await guestPost(gast, path, body)).status, path).toBe(401)
    }
    for (const path of [
      `${BOARD_GRANTS_PATH}?${BOARD_ID_PARAM}=${board.id}`,
      `${BOARD_SHARE_LINKS_PATH}?${BOARD_ID_PARAM}=${board.id}`,
    ]) {
      expect((await guestGet(gast, path)).status, path).toBe(401)
    }

    // Nichts davon hat etwas veraendert.
    const unveraendert = await ada.jar.fetch(`${app.baseUrl}${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${board.id}`)
    expect(((await unveraendert.json()) as BoardSceneResponse).board.title).toBe('Skizze')
  })

  it('laesst einen Gast an keinen Workspace-, Mitglieder- oder Adminendpunkt', async () => {
    const { ada, bob, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Schreibgast')

    for (const path of [
      WORKSPACES_PATH,
      `${WORKSPACE_MEMBERS_PATH}?${WORKSPACE_ID_PARAM}=${board.workspaceId}`,
      `${WORKSPACE_MEMBER_CANDIDATES_PATH}?${WORKSPACE_ID_PARAM}=${board.workspaceId}&q=bob`,
      `${BOARDS_PATH}?${WORKSPACE_ID_PARAM}=${board.workspaceId}`,
      ADMIN_USERS_PATH,
    ]) {
      const response = await guestGet(gast, path)
      // 401 und nicht 403: diese Strecken nehmen gar keine Gastsession an - sie sind fuer ihn nicht
      // vorhanden. Und ihr Koerper nennt weder einen internen Namen noch eine Kennung.
      expect(response.status, path).toBe(401)
      const koerper = await response.text()
      expect(koerper, path).not.toContain(board.workspaceId)
      expect(koerper, path).not.toContain(bob.profile.user.displayName)
    }
    for (const [path, body] of [
      [WORKSPACES_PATH, { name: 'Eigener' }],
      [WORKSPACE_MEMBER_ADD_PATH, { workspaceId: board.workspaceId, userId: bob.profile.user.id, role: 'member' }],
      [ADMIN_USER_STATUS_PATH, { userId: bob.profile.user.id, status: 'deactivated' }],
    ] as const) {
      expect((await guestPost(gast, path, body)).status, path).toBe(401)
    }
    // Und nichts davon hat etwas bewirkt.
    const mitglieder = await ada.jar.fetch(
      `${app.baseUrl}${WORKSPACE_MEMBERS_PATH}?${WORKSPACE_ID_PARAM}=${board.workspaceId}`,
    )
    expect(mitglieder.status).toBe(200)
  })

  it('gibt einem Gast in der Szenenantwort keinen Workspace und keinen Owner preis', async () => {
    const { ada, board } = await aufbau()
    await post(app, ada, BOARD_SCENE_PATH, { boardId: board.id, baseVersion: 0, scene: szene(board.id) })
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Schreibgast')

    const geladen = await guestGet(gast, `${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${board.id}`)
    expect(geladen.status).toBe(200)
    const roh = await geladen.text()
    // Weder Workspacekennung noch Ownerkennung noch der Anzeigename eines internen Nutzers - auch nicht in
    // einem Feld, an das hier niemand gedacht hat.
    expect(roh).not.toContain(board.workspaceId)
    expect(roh).not.toContain(ada.profile.user.id)
    expect(roh).not.toContain(ada.profile.user.displayName)
    const inhalt = JSON.parse(roh) as GuestBoardSceneResponse
    expect(inhalt.viewer).toBe('guest')
    expect(Object.keys(inhalt.board).sort()).toEqual([
      'id',
      'sceneVersion',
      'status',
      'title',
      'viewerRole',
    ])
    expect(inhalt.board.title).toBe('Skizze')

    // Der Gastzugang selbst sagt genauso wenig.
    const sitzung = await guestGet(gast, BOARD_GUEST_SESSION_PATH)
    const sitzungRoh = await sitzung.text()
    expect(sitzungRoh).not.toContain(board.workspaceId)
    expect(sitzungRoh).not.toContain(ada.profile.user.id)
    expect(sitzungRoh).not.toContain(ada.profile.user.displayName)

    // Ein Mitglied bekommt unveraendert die volle Sicht - die Reduktion gilt nur fuer Gaeste.
    const intern = await ada.jar.fetch(`${app.baseUrl}${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${board.id}`)
    const internInhalt = (await intern.json()) as BoardSceneResponse
    expect(internInhalt.viewer).toBe('member')
    expect(internInhalt.board.workspaceId).toBe(board.workspaceId)
    expect(internInhalt.board.ownerUserId).toBe(ada.profile.user.id)
    expect(internInhalt.board.ownerDisplayName).toBe(ada.profile.user.displayName)
  })

  it('nennt einem Gast die Rolle seines Freigabelinks', async () => {
    const { ada, board } = await aufbau()
    // Ohne ausdrueckliche Rolle gilt `guest-viewer`.
    const link = await createShareLink(ada, board.id)
    const gast = await joinAsGuest(link.token, 'Lesegast')
    expect(gast.session.board.viewerRole).toBe('guest-viewer')

    const geladen = await guestGet(gast, `${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${board.id}`)
    expect(geladen.status).toBe(200)
    expect(((await geladen.json()) as GuestBoardSceneResponse).board.viewerRole).toBe('guest-viewer')
  })

  it('gibt einem Gast auch beim Speichern und ueber Bilder nichts Internes preis', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Schreibgast')

    const gespeichert = await guestPost(gast, BOARD_SCENE_PATH, {
      boardId: board.id,
      baseVersion: 0,
      scene: szene(board.id),
    })
    expect(gespeichert.status).toBe(200)
    const gespeichertRoh = await gespeichert.text()
    expect(gespeichertRoh).not.toContain(board.workspaceId)
    expect(gespeichertRoh).not.toContain(ada.profile.user.id)
    expect(gespeichertRoh).not.toContain(ada.profile.user.displayName)

    // Der Konfliktkoerper derselben Route ebenso wenig.
    const konflikt = await guestPost(gast, BOARD_SCENE_PATH, {
      boardId: board.id,
      baseVersion: 0,
      scene: szene(board.id),
    })
    expect(konflikt.status).toBe(409)
    const konfliktRoh = await konflikt.text()
    expect(konfliktRoh).not.toContain(board.workspaceId)
    expect(konfliktRoh).not.toContain(ada.profile.user.id)

    // Ein hochgeladenes Bild: der Speicherschluessel nennt das eigene Board und sonst nichts.
    const bild = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const hochgeladen = await gast.jar.fetch(
      `${app.baseUrl}${BOARD_ASSETS_PATH}?${BOARD_ID_PARAM}=${board.id}&fileId=bild1`,
      {
        method: 'POST',
        headers: { 'content-type': 'image/png', [CSRF_HEADER]: gast.session.csrfToken },
        body: bild,
      },
    )
    expect(hochgeladen.status).toBe(201)
    const bildRoh = await hochgeladen.text()
    expect(bildRoh).not.toContain(board.workspaceId)
    expect(bildRoh).not.toContain(ada.profile.user.id)
    expect(bildRoh).not.toContain(ada.profile.user.displayName)
  })

  it('laesst einen Gast nie an ein fremdes Board', async () => {
    const { ada, board } = await aufbau()
    const fremdes = await createBoard(app, ada, board.workspaceId, 'Fremdes')
    await post(app, ada, BOARD_SCENE_PATH, { boardId: fremdes.id, baseVersion: 0, scene: szene(fremdes.id) })
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Schreibgast')

    // Dasselbe Ergebnis fuer ein wirklich vorhandenes Nachbarboard wie fuer eine erfundene Kennung.
    for (const boardId of [fremdes.id, FREMDE_KENNUNG]) {
      expect((await guestGet(gast, `${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${boardId}`)).status, boardId).toBe(404)
      expect(
        (await guestGet(gast, `${BOARD_ASSETS_PATH}?${BOARD_ID_PARAM}=${boardId}&fileId=beliebig`)).status,
        boardId,
      ).toBe(404)
      expect(
        (await guestPost(gast, BOARD_SCENE_PATH, { boardId, baseVersion: 0, scene: szene(boardId) })).status,
        boardId,
      ).toBe(404)
    }
    const rows = await pool.query('select 1 from scene_versions where board_id = $1', [fremdes.id])
    expect(rows.rowCount).toBe(1)
  })

  it('verlangt vom Gast dasselbe CSRF-Token wie von einem Mitglied', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Schreibgast')
    const koerper = JSON.stringify({ boardId: board.id, baseVersion: 0, scene: szene(board.id) })

    const ohne = await gast.jar.fetch(`${app.baseUrl}${BOARD_SCENE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: koerper,
    })
    expect(ohne.status).toBe(403)

    // Das Token der internen Sitzung legitimiert eine Gastanfrage nicht - beide tragen eine eigene Marke.
    const fremdesToken = await gast.jar.fetch(`${app.baseUrl}${BOARD_SCENE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: ada.profile.csrfToken },
      body: koerper,
    })
    expect(fremdesToken.status).toBe(403)
    expect(await pool.query('select 1 from scene_versions')).toHaveProperty('rowCount', 0)
  })

  it('haelt ein archiviertes Board fuer den Gast lesbar und unveraenderlich', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Schreibgast')
    await post(app, ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })

    expect((await guestGet(gast, `${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${board.id}`)).status).toBe(200)
    const gespeichert = await guestPost(gast, BOARD_SCENE_PATH, {
      boardId: board.id,
      baseVersion: 0,
      scene: szene(board.id),
    })
    expect(gespeichert.status).toBe(403)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Ablauf und Widerruf                                                                                   */
/* ---------------------------------------------------------------------------------------------------- */

describe('Ablauf und Widerruf einer Gastsession', () => {
  it('sperrt eine bestehende Gastsession sofort, wenn der Link widerrufen wird', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Schreibgast')
    expect((await guestGet(gast, `${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${board.id}`)).status).toBe(200)

    await post(app, ada, BOARD_SHARE_LINK_REVOKE_PATH, { boardId: board.id, shareLinkId: link.id })

    // Dieselbe Antwort wie ohne jede Sitzung: die Gastsession traegt ohne ihren Link nichts mehr.
    expect((await guestGet(gast, `${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${board.id}`)).status).toBe(401)
    expect((await guestGet(gast, BOARD_GUEST_SESSION_PATH)).status).toBe(401)
    expect(
      (await guestPost(gast, BOARD_SCENE_PATH, { boardId: board.id, baseVersion: 0, scene: szene(board.id) })).status,
    ).toBe(401)
  })

  it('sperrt eine bestehende Gastsession mit dem Ablauf des Links', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { expiresInHours: 1 })
    const gast = await joinAsGuest(link.token, 'Lesegast')
    // Die Gastsession endet nie spaeter als ihr Link.
    expect(new Date(gast.session.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 5_000)

    app.setNow(new Date(Date.now() + 2 * 3600 * 1000))
    expect((await guestGet(gast, `${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${board.id}`)).status).toBe(401)
  })

  it('gibt einem Gast weiterhin Zugang, solange sein Link gilt', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { expiresInHours: 4 })
    const gast = await joinAsGuest(link.token, 'Lesegast')

    app.setNow(new Date(Date.now() + 3600 * 1000))
    const wieder = await guestGet(gast, BOARD_GUEST_SESSION_PATH)
    expect(wieder.status).toBe(200)
    expect(((await wieder.json()) as GuestSessionResponse).role).toBe('guest-viewer')
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Realtime                                                                                              */
/* ---------------------------------------------------------------------------------------------------- */

describe('Gaeste an der Realtime-Strecke', () => {
  it('laesst einen Gast demselben Raum beitreten und zeigt ihn im Teilnehmerfeld', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Gast Nord')

    const mitglied = await connect(ada.jar.cookieHeader())
    await mitglied.join(board.id)
    const verbindung = await connect(gast.jar.cookieHeader())
    const beigetreten = await verbindung.join(board.id)
    expect(beigetreten.canWrite).toBe(true)

    // Presence traegt den selbst gewaehlten Namen und wie bisher keine Profildaten.
    const feld = await mitglied.next('presence', (message) => message.peers.length === 2)
    const gastfeld = feld.peers.find((peer) => peer.displayName === 'Gast Nord')
    expect(gastfeld).toBeDefined()
    expect(Object.keys(gastfeld ?? {}).sort()).toEqual([
      'canWrite',
      'clientId',
      'displayName',
      'pointer',
      'selectedElementIds',
    ])

    // Eine Aenderung des Gastes erreicht das Mitglied ueber denselben Raum.
    verbindung.send(change(board.id, [element('vom-gast', 1, 1)]))
    const angekommen = await mitglied.next('scene-change')
    expect(angekommen.elements.map((entry) => entry.id)).toEqual(['vom-gast'])
  })

  it('laesst einen guest-viewer lesen und weist seine Aenderung benannt ab', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id)
    const gast = await joinAsGuest(link.token, 'Lesegast')

    const verbindung = await connect(gast.jar.cookieHeader())
    const beigetreten = await verbindung.join(board.id)
    expect(beigetreten.canWrite).toBe(false)

    verbindung.send(change(board.id, [element('verboten', 1, 1)]))
    expect((await verbindung.next('error')).code).toBe('kein-schreibrecht')
    await ruhe(150)
    expect(await pool.query('select 1 from scene_versions')).toHaveProperty('rowCount', 0)
  })

  it('beendet eine offene Gastverbindung beim Widerruf des Links', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Schreibgast')
    const verbindung = await connect(gast.jar.cookieHeader())
    await verbindung.join(board.id)

    await post(app, ada, BOARD_SHARE_LINK_REVOKE_PATH, { boardId: board.id, shareLinkId: link.id })

    // Beide Wege beenden die Verbindung und beide sind endgueltig: der Widerruf schliesst sie unmittelbar
    // (`4401`), und die Nachpruefung des Raums wuerde sie andernfalls binnen zwei Sekunden entziehen
    // (`4403`). Welcher zuerst greift, entscheidet nur die Reihenfolge - beide verbieten den Wiederaufbau.
    expect(BEENDET).toContain(await verbindung.closeCode)
    // Und ein Wiederverbinden gibt es nicht: der Upgrade selbst wird abgelehnt.
    await expect(openRealtime(app.baseUrl, gast.jar.cookieHeader())).rejects.toThrow()
  })

  it('beendet eine offene Gastverbindung mit dem Ablauf des Links', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor', expiresInHours: 1 })
    const gast = await joinAsGuest(link.token, 'Schreibgast')
    const verbindung = await connect(gast.jar.cookieHeader())
    await verbindung.join(board.id)

    app.setNow(new Date(Date.now() + 2 * 3600 * 1000))

    expect(BEENDET).toContain(await verbindung.closeCode)
    await expect(openRealtime(app.baseUrl, gast.jar.cookieHeader())).rejects.toThrow()
  })

  it('schickt einem Gast ueber die Strecke keine Workspacekennung und keine Nutzerkennung', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Gast Nord')

    const mitglied = await connect(ada.jar.cookieHeader())
    await mitglied.join(board.id)
    const verbindung = await connect(gast.jar.cookieHeader())
    await verbindung.join(board.id)
    // Auch eine abgelehnte Nachricht wird geprueft: Fehlerkoerper sind ein beliebter Ort fuer zu viel.
    verbindung.send({ type: 'presence', boardId: FREMDE_KENNUNG, pointer: null, selectedElementIds: [] })
    await verbindung.next('error')
    const feld = await verbindung.next('presence', (message) => message.peers.length === 2)
    await ruhe(100)

    const gesehen = JSON.stringify(verbindung.log)
    expect(gesehen).not.toContain(board.workspaceId)
    expect(gesehen).not.toContain(ada.profile.user.id)
    // Der Anzeigename der anwesenden Mitbearbeiter ist ausdruecklich gewollt und bleibt.
    expect(feld.peers.map((peer) => peer.displayName).sort()).toEqual([
      'Gast Nord',
      ada.profile.user.displayName,
    ])
    // `ready` nennt einem Gast seine Gastsession, nie eine Nutzerkennung.
    const bereit = verbindung.log.find((message) => message.type === 'ready')
    expect(bereit).toBeDefined()
    expect(bereit?.type === 'ready' ? bereit.userId : null).not.toBe(ada.profile.user.id)
  })

  it('sichert die Arbeit im Raum, auch wenn nur ein Gast sie beigetragen hat', async () => {
    const { ada, board } = await aufbau()
    const link = await createShareLink(ada, board.id, { role: 'guest-editor' })
    const gast = await joinAsGuest(link.token, 'Schreibgast')

    const verbindung = await connect(gast.jar.cookieHeader())
    await verbindung.join(board.id)
    verbindung.send(change(board.id, [element('nur-gast', 1, 1)]))
    const gesichert = await verbindung.next('saved')

    const rows = await pool.query<{ author_user_id: string | null; scene: SceneSnapshot }>(
      'select author_user_id, scene from scene_versions where board_id = $1 and version = $2',
      [board.id, gesichert.version],
    )
    expect(rows.rows[0]?.author_user_id).toBeNull()
    expect(rows.rows[0]?.scene.elements.map((entry) => entry.id)).toEqual(['nur-gast'])
  })
})
