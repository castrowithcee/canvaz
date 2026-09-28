/**
 * Dashboard: die arbeitsbereichsuebergreifende Boardliste gegen die echte Anwendung und eine echte
 * Datenbank.
 *
 * Geprueft wird nicht, dass der Endpunkt antwortet, sondern **was er zeigt und was er verschweigt**: nur
 * Boards mit tatsaechlichem Zugriff, ueber mehrere Arbeitsbereiche hinweg, ohne archivierte, und je Filter
 * genau die erwartete Menge. Jeder Aufbau entsteht ueber dieselben Endpunkte wie in der Oberflaeche - samt
 * Anmeldung, Cookie und CSRF-Token.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  BOARD_DASHBOARD_PATH,
  BOARD_GRANT_ADD_PATH,
  BOARD_GRANT_REMOVE_PATH,
  BOARD_GUEST_JOIN_PATH,
  BOARD_QUERY_PARAM,
  BOARD_RENAME_PATH,
  BOARD_SHARE_LINK_CREATE_PATH,
  BOARD_SHARE_LINK_REVOKE_PATH,
  BOARD_STATUS_PATH,
  DASHBOARD_FILTER_PARAM,
  WORKSPACE_MEMBER_REMOVE_PATH,
} from '../../src/contracts/api.js'
import type {
  CreateBoardShareLinkResponse,
  DashboardBoardView,
  DashboardFilterView,
  DashboardResponse,
} from '../../src/contracts/api.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { addMember, createBoard, createWorkspace, post, signedInAs } from '../support/board-fixture.js'
import type { Account } from '../support/board-fixture.js'
import { createJar } from '../support/browser-client.js'
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

/* ---------------------------------------------------------------------------------------------------- */
/* Testhilfen                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

async function dashboard(
  account: Account,
  options: { readonly filter?: DashboardFilterView; readonly q?: string } = {},
): Promise<readonly DashboardBoardView[]> {
  const params = new URLSearchParams()
  if (options.filter !== undefined) {
    params.set(DASHBOARD_FILTER_PARAM, options.filter)
  }
  if (options.q !== undefined) {
    params.set(BOARD_QUERY_PARAM, options.q)
  }
  const response = await account.jar.fetch(`${app.baseUrl}${BOARD_DASHBOARD_PATH}?${params.toString()}`)
  expect(response.status, 'Dashboardliste').toBe(200)
  return ((await response.json()) as DashboardResponse).boards
}

function titles(boards: readonly DashboardBoardView[]): readonly string[] {
  return boards.map((board) => board.title)
}

/** Interne Freigabe ueber den echten Endpunkt; die Rolle ist fuer diese Tests nie der Gegenstand. */
async function shareWith(owner: Account, boardId: string, userId: string): Promise<void> {
  const response = await post(app, owner, BOARD_GRANT_ADD_PATH, { boardId, userId, role: 'editor' })
  expect(response.status, 'Board freigeben').toBe(201)
}

async function createShareLink(owner: Account, boardId: string): Promise<string> {
  const response = await post(app, owner, BOARD_SHARE_LINK_CREATE_PATH, { boardId })
  expect(response.status, 'Freigabelink anlegen').toBe(201)
  return ((await response.json()) as CreateBoardShareLinkResponse).link.id
}

/* ---------------------------------------------------------------------------------------------------- */
/* Die Liste selbst                                                                                      */
/* ---------------------------------------------------------------------------------------------------- */

describe('Dashboardliste', () => {
  it('zeigt Boards aller Arbeitsbereiche, zuletzt geaendertes zuerst', async () => {
    const ada = await signedInAs(app, 'ada')
    const nord = await createWorkspace(app, ada, 'Team Nord')
    const sued = await createWorkspace(app, ada, 'Team Sued')
    const skizze = await createBoard(app, ada, nord.id, 'Skizze')
    await createBoard(app, ada, sued.id, 'Plan')

    // Eine Aenderung hebt das Board an die Spitze - das ist die Zusage der Sortierung.
    const umbenannt = await post(app, ada, BOARD_RENAME_PATH, { boardId: skizze.id, title: 'Skizze v2' })
    expect(umbenannt.status).toBe(200)

    const boards = await dashboard(ada)
    expect(titles(boards)).toEqual(['Skizze v2', 'Plan'])
    // Die Liste ist uebergreifend und nennt deshalb je Zeile ihren Arbeitsbereich.
    expect(boards.map((board) => board.workspaceName)).toEqual(['Team Nord', 'Team Sued'])
  })

  it('zeigt weder ein fremdes Board noch eines nach entzogenem Zugang', async () => {
    const ada = await signedInAs(app, 'ada')
    const bob = await signedInAs(app, 'bob')
    const nord = await createWorkspace(app, ada, 'Team Nord')
    await addMember(app, ada, nord.id, bob)
    const geteilt = await createBoard(app, ada, nord.id, 'Skizze')
    await shareWith(ada, geteilt.id, bob.profile.user.id)

    // Ein Arbeitsbereich, dem Ada nicht angehoert: weder Titel noch Arbeitsbereich noch Zeitpunkt.
    const fremd = await createWorkspace(app, bob, 'Bobs Kammer')
    await createBoard(app, bob, fremd.id, 'Geheimplan')
    expect(titles(await dashboard(ada))).toEqual(['Skizze'])

    // Entzogene Boardrolle: der Zugriff faellt auf die Mitgliedschaft zurueck, die Freigabesicht endet.
    const entzogen = await post(app, ada, BOARD_GRANT_REMOVE_PATH, {
      boardId: geteilt.id,
      userId: bob.profile.user.id,
    })
    expect(entzogen.status).toBe(200)
    expect(titles(await dashboard(bob, { filter: 'shared-with-me' }))).toEqual([])
    expect(titles(await dashboard(bob)).toSorted()).toEqual(['Geheimplan', 'Skizze'])

    // Entzogene Mitgliedschaft: das Board verschwindet vollstaendig.
    const entfernt = await post(app, ada, WORKSPACE_MEMBER_REMOVE_PATH, {
      workspaceId: nord.id,
      userId: bob.profile.user.id,
    })
    expect(entfernt.status).toBe(200)
    expect(titles(await dashboard(bob))).toEqual(['Geheimplan'])
  })

  it('ist leer, solange es keinen Arbeitsbereich und kein Board gibt', async () => {
    const ada = await signedInAs(app, 'ada')
    expect(await dashboard(ada)).toEqual([])

    const nord = await createWorkspace(app, ada, 'Team Nord')
    expect(await dashboard(ada)).toEqual([])
    // Erst das Board erzeugt die erste Zeile.
    await createBoard(app, ada, nord.id, 'Skizze')
    expect(titles(await dashboard(ada))).toEqual(['Skizze'])
  })

  it('zeigt archivierte Boards nicht', async () => {
    const ada = await signedInAs(app, 'ada')
    const nord = await createWorkspace(app, ada, 'Team Nord')
    const skizze = await createBoard(app, ada, nord.id, 'Skizze')
    await createBoard(app, ada, nord.id, 'Plan')

    const archiviert = await post(app, ada, BOARD_STATUS_PATH, { boardId: skizze.id, status: 'archived' })
    expect(archiviert.status).toBe(200)
    expect(titles(await dashboard(ada))).toEqual(['Plan'])
  })

  it('nennt je Eintrag die Herkunft des Zugriffs', async () => {
    const ada = await signedInAs(app, 'ada')
    const bob = await signedInAs(app, 'bob')
    const nord = await createWorkspace(app, ada, 'Team Nord')
    await addMember(app, ada, nord.id, bob)
    const geteilt = await createBoard(app, ada, nord.id, 'Geteilt')
    await shareWith(ada, geteilt.id, bob.profile.user.id)
    await createBoard(app, ada, nord.id, 'Nur Ada')
    const eigenes = await createBoard(app, bob, nord.id, 'Bobs Board')
    expect(eigenes.workspaceId).toBe(nord.id)

    const herkunft = new Map(
      (await dashboard(bob)).map((board) => [board.title, board.accessOrigin] as const),
    )
    expect(herkunft.get('Bobs Board')).toBe('owner')
    expect(herkunft.get('Geteilt')).toBe('grant')
    // Auch ohne eigenen Boardbezug ist die Herkunft benannt - die Mitgliedschaft im Arbeitsbereich.
    expect(herkunft.get('Nur Ada')).toBe('workspace')
  })

  it('bleibt einem Gast und einer anonymen Anfrage verschlossen', async () => {
    const ada = await signedInAs(app, 'ada')
    const nord = await createWorkspace(app, ada, 'Team Nord')
    const board = await createBoard(app, ada, nord.id, 'Skizze')
    const antwort = await post(app, ada, BOARD_SHARE_LINK_CREATE_PATH, { boardId: board.id })
    expect(antwort.status).toBe(201)
    const token = new URL(((await antwort.json()) as CreateBoardShareLinkResponse).url).hash.slice(1)

    const gast = createJar()
    const beitritt = await gast.fetch(`${app.baseUrl}${BOARD_GUEST_JOIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, displayName: 'Kundin' }),
    })
    expect(beitritt.status).toBe(201)

    // Ein Gast kennt genau ein Board und hat kein Dashboard.
    expect((await gast.fetch(`${app.baseUrl}${BOARD_DASHBOARD_PATH}`)).status).toBe(401)
    expect((await fetch(`${app.baseUrl}${BOARD_DASHBOARD_PATH}`)).status).toBe(401)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Die vier Filter                                                                                       */
/* ---------------------------------------------------------------------------------------------------- */

describe('Filter des Dashboards', () => {
  /** Ada besitzt zwei Boards, Bob eines - und teilt es mit Ada. Alle im selben Arbeitsbereich. */
  async function aufbau() {
    const ada = await signedInAs(app, 'ada')
    const bob = await signedInAs(app, 'bob')
    const nord = await createWorkspace(app, ada, 'Team Nord')
    await addMember(app, ada, nord.id, bob)
    const allein = await createBoard(app, ada, nord.id, 'Allein')
    const intern = await createBoard(app, ada, nord.id, 'Intern geteilt')
    await shareWith(ada, intern.id, bob.profile.user.id)
    const fremd = await createBoard(app, bob, nord.id, 'Bobs Board')
    await shareWith(bob, fremd.id, ada.profile.user.id)
    return { ada, bob, nord, allein, intern, fremd }
  }

  it('"Meine Boards" nennt genau die eigenen - auch zusammen mit der Suche', async () => {
    const { ada } = await aufbau()

    expect(titles(await dashboard(ada, { filter: 'owned' })).toSorted()).toEqual(['Allein', 'Intern geteilt'])
    // Filter und Suche wirken gemeinsam und beide serverseitig.
    expect(titles(await dashboard(ada, { filter: 'owned', q: 'allein' }))).toEqual(['Allein'])
  })

  it('"Von mir geteilt" nennt nur das eigene Board mit Freigabe', async () => {
    const { ada, allein } = await aufbau()

    expect(titles(await dashboard(ada, { filter: 'shared-by-me' }))).toEqual(['Intern geteilt'])

    // Ein Gastlink zaehlt ebenso als eigene Freigabe.
    await createShareLink(ada, allein.id)
    expect(titles(await dashboard(ada, { filter: 'shared-by-me' })).toSorted()).toEqual([
      'Allein',
      'Intern geteilt',
    ])
  })

  it('"Mit mir geteilt" nennt nur das fremde Board mit Freigabe an mich', async () => {
    const { ada } = await aufbau()

    expect(titles(await dashboard(ada, { filter: 'shared-with-me' }))).toEqual(['Bobs Board'])
  })

  it('"Mit extern geteilt" nennt nur Boards mit gueltigem Gastlink', async () => {
    const { ada, allein, intern } = await aufbau()

    expect(await dashboard(ada, { filter: 'shared-externally' })).toEqual([])

    const gueltig = await createShareLink(ada, allein.id)
    const widerrufen = await createShareLink(ada, intern.id)
    const antwort = await post(app, ada, BOARD_SHARE_LINK_REVOKE_PATH, {
      boardId: intern.id,
      shareLinkId: widerrufen,
    })
    expect(antwort.status).toBe(200)

    const extern = await dashboard(ada, { filter: 'shared-externally' })
    expect(titles(extern)).toEqual(['Allein'])
    // Die Marke sagt, **dass** extern geteilt wurde - nie mit welchem Link und nie mit welchem Token.
    expect(extern[0]?.sharedExternally).toBe(true)
    expect(JSON.stringify(extern)).not.toContain(gueltig)

    // Ein Board mit ausschliesslich widerrufenem Link traegt die Marke nicht mehr.
    const alle = await dashboard(ada)
    expect(alle.find((board) => board.title === 'Intern geteilt')?.sharedExternally).toBe(false)
  })
})
