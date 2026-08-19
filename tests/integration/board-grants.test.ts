/**
 * Interne Boardfreigaben gegen die echte Anwendung und eine echte Datenbank.
 *
 * Es gibt keinen verkuerzten Weg an den Guards vorbei: jeder Beteiligte meldet sich ueber den echten
 * OIDC-Fluss an und spricht danach dieselben HTTP-Endpunkte an wie die SPA - samt CSRF-Token und
 * Session-Cookie. Die Wirkung einer Freigabe wird nie an ihrer eigenen Antwort gemessen, sondern an dem,
 * was der Betroffene danach tatsaechlich noch darf.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  ADMIN_USER_STATUS_PATH,
  BOARD_GRANT_ADD_PATH,
  BOARD_GRANT_REMOVE_PATH,
  BOARD_GRANT_ROLE_PATH,
  BOARD_GRANTS_PATH,
  BOARD_ID_PARAM,
  BOARD_OWNER_PATH,
  BOARD_RENAME_PATH,
  BOARD_SCENE_PATH,
  BOARD_STATUS_PATH,
  CSRF_HEADER,
  WORKSPACE_MEMBER_REMOVE_PATH,
} from '../../src/contracts/api.js'
import type {
  BoardGrantsResponse,
  BoardSceneResponse,
  BoardView,
  ErrorResponse,
} from '../../src/contracts/api.js'
import type { SceneSnapshot } from '../../src/contracts/scene.js'
import { DEFAULT_APP_STATE, SCENE_SCHEMA_VERSION } from '../../src/contracts/scene.js'
import { BOARD_ACCESS_REVOKED_CLOSE_CODE } from '../../src/contracts/realtime.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { addMember, createBoard, createWorkspace, post, signedInAs } from '../support/board-fixture.js'
import type { Account } from '../support/board-fixture.js'
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

async function connect(account: Account): Promise<RealtimeTestClient> {
  const client = await openRealtime(app.baseUrl, account.jar.cookieHeader())
  clients.push(client)
  return client
}

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
  expect(app.rooms.roomCount).toBe(0)
  await ruhe(100)
})

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

function speichere(account: Account, board: BoardView, baseVersion: number): Promise<Response> {
  return post(app, account, BOARD_SCENE_PATH, { boardId: board.id, baseVersion, scene: szene(board.id) })
}

function oeffne(account: Account, boardId: string): Promise<Response> {
  return account.jar.fetch(`${app.baseUrl}${BOARD_SCENE_PATH}?${BOARD_ID_PARAM}=${boardId}`)
}

function freigabe(account: Account, boardId: string, userId: string, role: string): Promise<Response> {
  return post(app, account, BOARD_GRANT_ADD_PATH, { boardId, userId, role })
}

async function grantsOf(account: Account, boardId: string): Promise<BoardGrantsResponse> {
  const response = await account.jar.fetch(`${app.baseUrl}${BOARD_GRANTS_PATH}?${BOARD_ID_PARAM}=${boardId}`)
  expect(response.status).toBe(200)
  return (await response.json()) as BoardGrantsResponse
}

async function gespeicherterOwner(boardId: string): Promise<string> {
  const rows = await pool.query<{ owner_user_id: string; anzahl: string }>(
    `select owner_user_id, (select count(*) from boards where id = $1) as anzahl from boards where id = $1`,
    [boardId],
  )
  const row = rows.rows[0]
  if (row === undefined) {
    throw new Error('Board nicht gefunden')
  }
  // Genau eine Zeile mit genau einem Owner: die Invariante haengt an der Spalte, nicht an einer Zaehlung.
  expect(row.anzahl).toBe('1')
  return row.owner_user_id
}

async function gespeicherteRolle(boardId: string, userId: string): Promise<string | null> {
  const rows = await pool.query<{ role: string }>(
    'select role from board_grants where board_id = $1 and user_id = $2',
    [boardId, userId],
  )
  return rows.rows[0]?.role ?? null
}

/**
 * Standardaufbau dieser Datei.
 *
 * Ada besitzt den Arbeitsbereich, Bob und Carl sind Mitglieder, **Bob** legt das Board an und ist damit
 * Board-Owner ohne Workspace-Ownerschaft. Genau diese Trennung braucht der Test: sie zeigt, dass die
 * Boardrolle eine eigene Ebene ist.
 */
async function team() {
  const ada = await signedInAs(app, 'ada')
  const bob = await signedInAs(app, 'bob')
  const carl = await signedInAs(app, 'carl')
  const workspace = await createWorkspace(app, ada, 'Team Nord')
  await addMember(app, ada, workspace.id, bob)
  await addMember(app, ada, workspace.id, carl)
  const board = await createBoard(app, bob, workspace.id, 'Skizze')
  return { ada, bob, carl, workspace, board }
}

/* ---------------------------------------------------------------------------------------------------- */
/* Wirkung der Boardrollen                                                                               */
/* ---------------------------------------------------------------------------------------------------- */

describe('Wirkung der Boardrollen', () => {
  it('laesst ein Mitglied ohne Freigabe weiterhin lesen und speichern', async () => {
    const { carl, board } = await team()

    expect((await oeffne(carl, board.id)).status).toBe(200)
    expect((await speichere(carl, board, 0)).status).toBe(200)
  })

  it('laesst einen viewer lesen, aber weder speichern noch umbenennen', async () => {
    const { bob, carl, board } = await team()
    expect((await freigabe(bob, board.id, carl.profile.user.id, 'viewer')).status).toBe(201)

    const geoeffnet = await oeffne(carl, board.id)
    expect(geoeffnet.status).toBe(200)
    expect(((await geoeffnet.json()) as BoardSceneResponse).board.id).toBe(board.id)

    const gespeichert = await speichere(carl, board, 0)
    expect(gespeichert.status).toBe(403)
    expect(((await gespeichert.json()) as ErrorResponse).error).toBe('Keine Berechtigung fuer diese Aktion')
    expect((await post(app, carl, BOARD_RENAME_PATH, { boardId: board.id, title: 'Meins' })).status).toBe(403)
  })

  it('laesst einen editor lesen und speichern, aber keine Freigabe verwalten', async () => {
    const { ada, bob, carl, board } = await team()
    expect((await freigabe(bob, board.id, carl.profile.user.id, 'editor')).status).toBe(201)

    expect((await speichere(carl, board, 0)).status).toBe(200)
    // Ein editor gibt sein Recht nicht weiter; sonst waere jede Abstufung mit einem Schritt aufgehoben.
    expect((await freigabe(carl, board.id, ada.profile.user.id, 'viewer')).status).toBe(403)
  })

  it('hebt eine Herabstufung wieder auf, sobald die Freigabe entzogen wird', async () => {
    const { bob, carl, board } = await team()
    expect((await freigabe(bob, board.id, carl.profile.user.id, 'viewer')).status).toBe(201)
    expect((await speichere(carl, board, 0)).status).toBe(403)

    expect(
      (await post(app, bob, BOARD_GRANT_REMOVE_PATH, { boardId: board.id, userId: carl.profile.user.id })).status,
    ).toBe(200)

    // Eine Freigabe ist eine Verfeinerung der Mitgliedschaft und kein zweites Tor: ohne sie gilt wieder
    // die Mitgliedschaft.
    expect(await gespeicherteRolle(board.id, carl.profile.user.id)).toBeNull()
    expect((await speichere(carl, board, 0)).status).toBe(200)
  })

  it('aendert eine bestehende Freigabe, statt eine zweite anzulegen', async () => {
    const { bob, carl, board } = await team()
    expect((await freigabe(bob, board.id, carl.profile.user.id, 'editor')).status).toBe(201)

    expect(
      (await post(app, bob, BOARD_GRANT_ROLE_PATH, { boardId: board.id, userId: carl.profile.user.id, role: 'viewer' }))
        .status,
    ).toBe(200)

    expect(await gespeicherteRolle(board.id, carl.profile.user.id)).toBe('viewer')
    expect((await speichere(carl, board, 0)).status).toBe(403)
    // Unveraenderte Rolle ist kein Fehler, sondern derselbe Zustand.
    expect(
      (await post(app, bob, BOARD_GRANT_ROLE_PATH, { boardId: board.id, userId: carl.profile.user.id, role: 'viewer' }))
        .status,
    ).toBe(200)
  })

  it('laesst den Workspace-Owner jedes Board seines Arbeitsbereichs verwalten', async () => {
    // Sonst waere ein Board, dessen Owner den Arbeitsbereich verlassen hat, dauerhaft unverwaltbar.
    const { ada, carl, board } = await team()

    expect((await freigabe(ada, board.id, carl.profile.user.id, 'viewer')).status).toBe(201)
    expect(await gespeicherteRolle(board.id, carl.profile.user.id)).toBe('viewer')
  })

  it('zeigt die Freigabeliste jedem, der das Board sehen darf', async () => {
    const { bob, carl, board } = await team()
    await freigabe(bob, board.id, carl.profile.user.id, 'viewer')

    const liste = await grantsOf(carl, board.id)
    expect(liste.board.ownerUserId).toBe(bob.profile.user.id)
    expect(liste.grants).toHaveLength(1)
    const eintrag = liste.grants[0]
    expect(eintrag?.userId).toBe(carl.profile.user.id)
    expect(eintrag?.displayName).toBe(carl.profile.user.displayName)
    expect(eintrag?.role).toBe('viewer')
    expect(Number.isNaN(Date.parse(eintrag?.grantedAt ?? ''))).toBe(false)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Negativfaelle                                                                                         */
/* ---------------------------------------------------------------------------------------------------- */

describe('Freigaben: Negativfaelle', () => {
  it('antwortet auf jede fremde Boardkennung mit 404, nie mit 403', async () => {
    const { bob, carl } = await team()

    for (const path of [BOARD_GRANT_ADD_PATH, BOARD_GRANT_ROLE_PATH]) {
      const response = await post(app, bob, path, {
        boardId: FREMDE_KENNUNG,
        userId: carl.profile.user.id,
        role: 'viewer',
      })
      expect(response.status).toBe(404)
    }
    expect(
      (await post(app, bob, BOARD_GRANT_REMOVE_PATH, { boardId: FREMDE_KENNUNG, userId: carl.profile.user.id }))
        .status,
    ).toBe(404)
    expect(
      (await post(app, bob, BOARD_OWNER_PATH, { boardId: FREMDE_KENNUNG, userId: carl.profile.user.id })).status,
    ).toBe(404)
    expect(
      (await bob.jar.fetch(`${app.baseUrl}${BOARD_GRANTS_PATH}?${BOARD_ID_PARAM}=${FREMDE_KENNUNG}`)).status,
    ).toBe(404)
  })

  it('verraet einem Nichtmitglied nicht, ob das Board existiert', async () => {
    const { bob, board } = await team()
    const fremder = await signedInAs(app, 'dora')

    expect((await freigabe(fremder, board.id, bob.profile.user.id, 'viewer')).status).toBe(404)
    expect(
      (await fremder.jar.fetch(`${app.baseUrl}${BOARD_GRANTS_PATH}?${BOARD_ID_PARAM}=${board.id}`)).status,
    ).toBe(404)
  })

  it('verlangt fuer jede Freigabeaenderung das CSRF-Token', async () => {
    const { bob, carl, board } = await team()

    const response = await bob.jar.fetch(`${app.baseUrl}${BOARD_GRANT_ADD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ boardId: board.id, userId: carl.profile.user.id, role: 'viewer' }),
    })

    expect(response.status).toBe(403)
    expect(await gespeicherteRolle(board.id, carl.profile.user.id)).toBeNull()
  })

  it('verweigert jede Freigaberoute ohne Sitzung', async () => {
    const { carl, board } = await team()

    for (const path of [BOARD_GRANT_ADD_PATH, BOARD_GRANT_ROLE_PATH, BOARD_GRANT_REMOVE_PATH, BOARD_OWNER_PATH]) {
      const response = await fetch(`${app.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: 'egal' },
        body: JSON.stringify({ boardId: board.id, userId: carl.profile.user.id, role: 'viewer' }),
      })
      expect(response.status).toBe(401)
    }
  })

  it('weist eine unbekannte Rolle und die Ownerrolle als Freigabe zurueck', async () => {
    const { bob, carl, board } = await team()

    // Die Ownerschaft wird uebertragen, nicht vergeben - sonst gaebe es zwei Owner.
    expect((await freigabe(bob, board.id, carl.profile.user.id, 'owner')).status).toBe(400)
    expect((await freigabe(bob, board.id, carl.profile.user.id, 'admin')).status).toBe(400)
    expect(await gespeicherteRolle(board.id, carl.profile.user.id)).toBeNull()
  })

  it('gibt an einen unbekannten oder deaktivierten Nutzer nicht frei', async () => {
    const { ada, bob, carl, board } = await team()

    expect((await freigabe(bob, board.id, FREMDE_KENNUNG, 'viewer')).status).toBe(404)
    // Ada ist als erster angemeldeter Nutzer Systemadmin.
    expect(
      (await post(app, ada, ADMIN_USER_STATUS_PATH, { userId: carl.profile.user.id, status: 'deactivated' })).status,
    ).toBe(200)
    expect((await freigabe(bob, board.id, carl.profile.user.id, 'viewer')).status).toBe(400)
    expect(await gespeicherteRolle(board.id, carl.profile.user.id)).toBeNull()
  })

  it('gibt nicht an jemanden frei, der dem Arbeitsbereich nicht angehoert', async () => {
    const { bob, board } = await team()
    const fremder = await signedInAs(app, 'dora')

    // Eine Boardrolle kann eine fehlende Mitgliedschaft nie umgehen; eine solche Zeile behauptete etwas
    // anderes und entsteht deshalb gar nicht erst.
    expect((await freigabe(bob, board.id, fremder.profile.user.id, 'editor')).status).toBe(400)
    expect(await gespeicherteRolle(board.id, fremder.profile.user.id)).toBeNull()
  })

  it('gibt nicht an den Board-Owner frei und legt keine zweite Freigabe an', async () => {
    const { bob, carl, board } = await team()

    expect((await freigabe(bob, board.id, bob.profile.user.id, 'editor')).status).toBe(409)
    expect((await freigabe(bob, board.id, carl.profile.user.id, 'editor')).status).toBe(201)
    expect((await freigabe(bob, board.id, carl.profile.user.id, 'viewer')).status).toBe(409)
    expect(await gespeicherteRolle(board.id, carl.profile.user.id)).toBe('editor')
  })

  it('meldet eine nicht vorhandene Freigabe beim Aendern und Entziehen', async () => {
    const { bob, carl, board } = await team()

    expect(
      (await post(app, bob, BOARD_GRANT_ROLE_PATH, { boardId: board.id, userId: carl.profile.user.id, role: 'viewer' }))
        .status,
    ).toBe(404)
    expect(
      (await post(app, bob, BOARD_GRANT_REMOVE_PATH, { boardId: board.id, userId: carl.profile.user.id })).status,
    ).toBe(404)
  })

  it('laesst den Owner sich seine eigene Ownerschaft nicht entziehen', async () => {
    const { bob, board } = await team()

    const response = await post(app, bob, BOARD_GRANT_REMOVE_PATH, { boardId: board.id, userId: bob.profile.user.id })

    expect(response.status).toBe(409)
    expect(((await response.json()) as ErrorResponse).error).toContain('Ownerschaft')
    // Ein Board behaelt immer genau einen Owner.
    expect(await gespeicherterOwner(board.id)).toBe(bob.profile.user.id)
  })

  it('aendert an einem archivierten Board keine Freigabe', async () => {
    const { bob, carl, board } = await team()
    expect((await post(app, bob, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(200)

    expect((await freigabe(bob, board.id, carl.profile.user.id, 'viewer')).status).toBe(403)
    expect((await post(app, bob, BOARD_OWNER_PATH, { boardId: board.id, userId: carl.profile.user.id })).status).toBe(
      403,
    )
    expect(await gespeicherteRolle(board.id, carl.profile.user.id)).toBeNull()
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Ownerschaft                                                                                           */
/* ---------------------------------------------------------------------------------------------------- */

describe('Ownerschaft uebertragen', () => {
  it('uebergibt die Verantwortung vollstaendig und laesst genau einen Owner zurueck', async () => {
    const { bob, carl, board } = await team()

    const response = await post(app, bob, BOARD_OWNER_PATH, { boardId: board.id, userId: carl.profile.user.id })

    expect(response.status).toBe(200)
    expect(((await response.json()) as BoardView).ownerUserId).toBe(carl.profile.user.id)
    expect(await gespeicherterOwner(board.id)).toBe(carl.profile.user.id)
    // Der neue Owner verwaltet, der bisherige faellt auf seine Mitgliedschaft zurueck.
    expect((await freigabe(carl, board.id, bob.profile.user.id, 'viewer')).status).toBe(201)
    expect((await post(app, bob, BOARD_OWNER_PATH, { boardId: board.id, userId: bob.profile.user.id })).status).toBe(
      403,
    )
  })

  it('raeumt eine bestehende Freigabe des neuen Owners weg', async () => {
    const { bob, carl, board } = await team()
    expect((await freigabe(bob, board.id, carl.profile.user.id, 'viewer')).status).toBe(201)

    expect((await post(app, bob, BOARD_OWNER_PATH, { boardId: board.id, userId: carl.profile.user.id })).status).toBe(
      200,
    )

    // Eine wirkungslose Zeile waere beim naechsten Wechsel eine stille Ueberraschung.
    expect(await gespeicherteRolle(board.id, carl.profile.user.id)).toBeNull()
    expect((await speichere(carl, board, 0)).status).toBe(200)
  })

  it('uebertraegt nicht an einen Fremden, einen Unbekannten oder einen deaktivierten Nutzer', async () => {
    const { ada, bob, carl, board } = await team()
    const fremder = await signedInAs(app, 'dora')

    expect((await post(app, bob, BOARD_OWNER_PATH, { boardId: board.id, userId: fremder.profile.user.id })).status).toBe(
      400,
    )
    expect((await post(app, bob, BOARD_OWNER_PATH, { boardId: board.id, userId: FREMDE_KENNUNG })).status).toBe(404)
    expect(
      (await post(app, ada, ADMIN_USER_STATUS_PATH, { userId: carl.profile.user.id, status: 'deactivated' })).status,
    ).toBe(200)
    expect((await post(app, bob, BOARD_OWNER_PATH, { boardId: board.id, userId: carl.profile.user.id })).status).toBe(
      400,
    )
    expect(await gespeicherterOwner(board.id)).toBe(bob.profile.user.id)
  })

  it('nimmt die Uebertragung an den bisherigen Owner als unveraendert an', async () => {
    const { bob, board } = await team()

    const response = await post(app, bob, BOARD_OWNER_PATH, { boardId: board.id, userId: bob.profile.user.id })

    expect(response.status).toBe(200)
    expect(await gespeicherterOwner(board.id)).toBe(bob.profile.user.id)
  })

  it('laesst ein Mitglied ohne Ownerstufe nicht uebertragen', async () => {
    const { bob, carl, board } = await team()

    expect((await post(app, carl, BOARD_OWNER_PATH, { boardId: board.id, userId: carl.profile.user.id })).status).toBe(
      403,
    )
    expect(await gespeicherterOwner(board.id)).toBe(bob.profile.user.id)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Nachweis                                                                                              */
/* ---------------------------------------------------------------------------------------------------- */

describe('Nachweis', () => {
  it('haelt jede Freigabe-, Rollen- und Ownerschaftsaenderung fest, ohne Boardinhalt', async () => {
    const { bob, carl, workspace, board } = await team()
    await freigabe(bob, board.id, carl.profile.user.id, 'editor')
    await post(app, bob, BOARD_GRANT_ROLE_PATH, { boardId: board.id, userId: carl.profile.user.id, role: 'viewer' })
    await post(app, bob, BOARD_GRANT_REMOVE_PATH, { boardId: board.id, userId: carl.profile.user.id })
    await post(app, bob, BOARD_OWNER_PATH, { boardId: board.id, userId: carl.profile.user.id })

    const events = await app.workspaces.audit.listForWorkspace(workspace.id)
    const eigene = events.filter(
      (event) => event.targetType === 'board-grant' || event.action === 'board.ownership-transferred',
    )

    expect(eigene.map((event) => event.action)).toEqual([
      'board-grant.added',
      'board-grant.role-changed',
      'board-grant.removed',
      'board.ownership-transferred',
    ])
    expect(eigene.every((event) => event.actorId === bob.profile.user.id)).toBe(true)
    expect(eigene[0]?.details).toEqual({ boardId: board.id, role: 'editor' })
    expect(eigene[1]?.details).toEqual({ boardId: board.id, previousRole: 'editor', role: 'viewer' })
    expect(eigene[2]?.details).toEqual({ boardId: board.id, previousRole: 'viewer' })
    expect(eigene[3]?.details).toEqual({
      previousOwnerId: bob.profile.user.id,
      ownerId: carl.profile.user.id,
    })
    // Kein Boardinhalt und kein Tokenmaterial im Nachweis.
    expect(JSON.stringify(eigene)).not.toContain('rectangle')
  })

  it('schreibt kein Ereignis, wenn die Aenderung abgelehnt wurde', async () => {
    const { ada, carl, workspace, board } = await team()

    expect((await freigabe(carl, board.id, ada.profile.user.id, 'viewer')).status).toBe(403)

    const events = await app.workspaces.audit.listForWorkspace(workspace.id)
    expect(events.filter((event) => event.targetType === 'board-grant')).toEqual([])
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Wirkung auf die offene Echtzeitverbindung                                                             */
/* ---------------------------------------------------------------------------------------------------- */

describe('Boardrolle wirkt auf die offene Verbindung', () => {
  it('stuft eine offene Verbindung herab, sobald die Rolle auf viewer faellt', async () => {
    const { bob, carl, board } = await team()
    const client = await connect(carl)
    expect((await client.join(board.id)).canWrite).toBe(true)

    expect((await freigabe(bob, board.id, carl.profile.user.id, 'viewer')).status).toBe(201)

    // Ohne erneute Anmeldung und ohne Protokollaenderung.
    expect(await client.next('access')).toEqual({ type: 'access', boardId: board.id, canWrite: false })
    client.send(change(board.id, [element('a', 1, 5)]))
    expect((await client.next('error')).code).toBe('kein-schreibrecht')
  })

  it('gibt das Schreibrecht zurueck, sobald die Freigabe entzogen wird', async () => {
    const { bob, carl, board } = await team()
    await freigabe(bob, board.id, carl.profile.user.id, 'viewer')
    const client = await connect(carl)
    expect((await client.join(board.id)).canWrite).toBe(false)

    expect(
      (await post(app, bob, BOARD_GRANT_REMOVE_PATH, { boardId: board.id, userId: carl.profile.user.id })).status,
    ).toBe(200)

    expect(await client.next('access')).toEqual({ type: 'access', boardId: board.id, canWrite: true })
  })

  it('beendet die Verbindung, sobald die Mitgliedschaft entzogen wird - die Boardrolle traegt nichts', async () => {
    const { ada, bob, carl, workspace, board } = await team()
    await freigabe(bob, board.id, carl.profile.user.id, 'editor')
    const client = await connect(carl)
    await client.join(board.id)

    expect(
      (await post(app, ada, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: carl.profile.user.id }))
        .status,
    ).toBe(200)

    expect((await client.next('error')).code).toBe('board-nicht-gefunden')
    expect(await client.closeCode).toBe(BOARD_ACCESS_REVOKED_CLOSE_CODE)
  })
})
