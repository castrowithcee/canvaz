/**
 * Workspaces, Mitgliedschaften und Autorisierung gegen die echte Anwendung und eine echte Datenbank.
 *
 * Es gibt keinen verkuerzten Weg an den Guards vorbei: jeder Test meldet sich ueber den echten OIDC-Fluss an
 * und spricht danach dieselben HTTP-Endpunkte an wie die SPA - samt CSRF-Token und Session-Cookie.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  ADMIN_USER_STATUS_PATH,
  CSRF_HEADER,
  ME_PATH,
  WORKSPACE_ID_PARAM,
  WORKSPACE_MEMBER_ADD_PATH,
  WORKSPACE_MEMBER_CANDIDATES_PATH,
  WORKSPACE_MEMBER_MAX_CANDIDATES,
  WORKSPACE_MEMBER_QUERY_PARAM,
  WORKSPACE_MEMBER_REMOVE_PATH,
  WORKSPACE_MEMBER_ROLE_PATH,
  WORKSPACE_MEMBERS_PATH,
  WORKSPACE_RENAME_PATH,
  WORKSPACE_STATUS_PATH,
  WORKSPACES_PATH,
} from '../../src/contracts/api.js'
import type {
  DirectoryUserView,
  MeResponse,
  WorkspaceCandidatesResponse,
  WorkspaceMembersResponse,
  WorkspaceView,
  WorkspacesResponse,
} from '../../src/contracts/api.js'
import type { WorkspaceRole } from '../../src/domain/workspace/model.js'
import type { WorkspaceScope } from '../../src/server/realtime.js'
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

async function signedInAs(subject: string, displayName?: string): Promise<Account> {
  const jar = createJar()
  const result = await login(app, jar, displayName === undefined ? { subject } : { subject, name: displayName })
  expect(result.error).toBeNull()
  const response = await jar.fetch(`${app.baseUrl}${ME_PATH}`)
  expect(response.status).toBe(200)
  return { jar, profile: (await response.json()) as MeResponse }
}

function get(account: Account, path: string, workspaceId?: string): Promise<Response> {
  const query = workspaceId === undefined ? '' : `?${new URLSearchParams({ [WORKSPACE_ID_PARAM]: workspaceId })}`
  return account.jar.fetch(`${app.baseUrl}${path}${query}`)
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

async function createWorkspace(account: Account, name: string): Promise<WorkspaceView> {
  const response = await post(account, WORKSPACES_PATH, { name })
  expect(response.status).toBe(201)
  return (await response.json()) as WorkspaceView
}

async function addMember(
  owner: Account,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<Response> {
  return post(owner, WORKSPACE_MEMBER_ADD_PATH, { workspaceId, userId, role })
}

/** Die Nutzersuche der Mitgliederaufnahme. Ohne `query` fehlt der Parameter vollstaendig. */
function searchCandidates(account: Account, workspaceId: string, query?: string): Promise<Response> {
  const params = new URLSearchParams({ [WORKSPACE_ID_PARAM]: workspaceId })
  if (query !== undefined) {
    params.set(WORKSPACE_MEMBER_QUERY_PARAM, query)
  }
  return account.jar.fetch(`${app.baseUrl}${WORKSPACE_MEMBER_CANDIDATES_PATH}?${params.toString()}`)
}

async function foundUsers(account: Account, workspaceId: string, query: string): Promise<readonly DirectoryUserView[]> {
  const response = await searchCandidates(account, workspaceId, query)
  expect(response.status).toBe(200)
  return ((await response.json()) as WorkspaceCandidatesResponse).users
}

async function listWorkspaces(account: Account): Promise<readonly WorkspaceView[]> {
  const response = await get(account, WORKSPACES_PATH)
  expect(response.status).toBe(200)
  return ((await response.json()) as WorkspacesResponse).workspaces
}

/** Der erste angemeldete Nutzer einer leeren Instanz wird Systemadmin; danach folgen gewoehnliche Nutzer. */
async function instanzMitAdmin(): Promise<Account> {
  return signedInAs('root')
}

describe('Workspaces anlegen und sehen', () => {
  it('macht den Ersteller zum Owner und zeigt den Workspace nur ihm', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')

    const workspace = await createWorkspace(ada, '  Team   Nord ')

    expect(workspace.name).toBe('Team Nord')
    expect(workspace.role).toBe('owner')
    expect(workspace.status).toBe('active')
    expect((await listWorkspaces(ada)).map((entry) => entry.id)).toEqual([workspace.id])
    expect(await listWorkspaces(bob)).toEqual([])
  })

  it('laesst einen Systemadmin ohne Mitgliedschaft keine fremden Workspaces erben', async () => {
    const root = await instanzMitAdmin()
    const ada = await signedInAs('ada')
    await createWorkspace(ada, 'Team Nord')

    // Verwaltungsrechte ja, Mitgliedschaft nein: die eigene Liste bleibt leer.
    expect(await listWorkspaces(root)).toEqual([])
  })

  it('weist leere und zu lange Namen zurueck', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')

    expect((await post(ada, WORKSPACES_PATH, { name: '   ' })).status).toBe(400)
    expect((await post(ada, WORKSPACES_PATH, { name: 'x'.repeat(81) })).status).toBe(400)
    expect((await post(ada, WORKSPACES_PATH, {})).status).toBe(400)
  })

  it('verlangt fuer jede Aenderung das CSRF-Token', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')

    const response = await post(ada, WORKSPACES_PATH, { name: 'Ohne Token' }, { csrf: false })

    expect(response.status).toBe(403)
    expect(await listWorkspaces(ada)).toEqual([])
  })

  it('verweigert jeden Workspaceendpunkt ohne Sitzung', async () => {
    const anonym: Account = { jar: createJar(), profile: { user: {} as never, csrfToken: 'x' } }

    expect((await get(anonym, WORKSPACES_PATH)).status).toBe(401)
    expect((await get(anonym, WORKSPACE_MEMBERS_PATH, FREMDE_KENNUNG)).status).toBe(401)
    expect((await post(anonym, WORKSPACES_PATH, { name: 'X' })).status).toBe(401)
  })
})

describe('Geratene und fremde Kennungen', () => {
  it('antwortet auf jede fremde Workspacekennung mit 404, nie mit 403', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const fremd = await createWorkspace(ada, 'Team Nord')

    for (const workspaceId of [fremd.id, FREMDE_KENNUNG]) {
      expect((await get(bob, WORKSPACE_MEMBERS_PATH, workspaceId)).status).toBe(404)
      expect((await get(bob, WORKSPACE_MEMBER_CANDIDATES_PATH, workspaceId)).status).toBe(404)
      expect((await post(bob, WORKSPACE_RENAME_PATH, { workspaceId, name: 'Uebernommen' })).status).toBe(404)
      expect((await post(bob, WORKSPACE_STATUS_PATH, { workspaceId, status: 'archived' })).status).toBe(404)
      expect((await addMember(bob, workspaceId, bob.profile.user.id, 'owner')).status).toBe(404)
      const rolle = { workspaceId, userId: ada.profile.user.id, role: 'member' }
      expect((await post(bob, WORKSPACE_MEMBER_ROLE_PATH, rolle)).status).toBe(404)
      expect(
        (await post(bob, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId, userId: ada.profile.user.id })).status,
      ).toBe(404)
    }
    // Der fremde Workspace ist unveraendert geblieben.
    const members = (await (await get(ada, WORKSPACE_MEMBERS_PATH, fremd.id)).json()) as WorkspaceMembersResponse
    expect(members.workspace.name).toBe('Team Nord')
    expect(members.members).toHaveLength(1)
  })

  it('behandelt eine syntaktisch unmoegliche Kennung wie eine unbekannte', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')

    expect((await get(ada, WORKSPACE_MEMBERS_PATH, 'keine-uuid')).status).toBe(404)
    expect((await post(ada, WORKSPACE_RENAME_PATH, { workspaceId: 'keine-uuid', name: 'X' })).status).toBe(404)
  })

  it('gibt eine fremde Mitgliedschaft nicht ueber ihre Kennung preis', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const carl = await signedInAs('carl')
    const adas = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, adas.id, carl.profile.user.id, 'member')).status).toBe(201)

    // Bob kennt beide Kennungen, gehoert aber nicht dazu.
    const versuch = await post(bob, WORKSPACE_MEMBER_ROLE_PATH, {
      workspaceId: adas.id,
      userId: carl.profile.user.id,
      role: 'owner',
    })

    expect(versuch.status).toBe(404)
    const members = (await (await get(ada, WORKSPACE_MEMBERS_PATH, adas.id)).json()) as WorkspaceMembersResponse
    expect(members.members.find((entry) => entry.userId === carl.profile.user.id)?.role).toBe('member')
  })
})

describe('Rollen im Workspace', () => {
  it('laesst ein Mitglied lesen, aber nichts aendern', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'member')).status).toBe(201)

    expect((await get(bob, WORKSPACE_MEMBERS_PATH, workspace.id)).status).toBe(200)
    expect((await post(bob, WORKSPACE_RENAME_PATH, { workspaceId: workspace.id, name: 'Meins' })).status).toBe(403)
    expect((await addMember(bob, workspace.id, bob.profile.user.id, 'owner')).status).toBe(403)
    // Auch das Nutzerverzeichnis bleibt zu, wer niemanden aufnehmen darf.
    expect((await get(bob, WORKSPACE_MEMBER_CANDIDATES_PATH, workspace.id)).status).toBe(403)
  })

  it('laesst einen Admin verwalten, aber keinen Owner anfassen und keinen Owner ernennen', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const carl = await signedInAs('carl')
    const workspace = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'admin')).status).toBe(201)

    // Erlaubt: Mitglieder aufnehmen, umbenennen, Mitglieder verwalten.
    expect((await addMember(bob, workspace.id, carl.profile.user.id, 'member')).status).toBe(201)
    expect((await post(bob, WORKSPACE_RENAME_PATH, { workspaceId: workspace.id, name: 'Team Sued' })).status).toBe(200)
    const hoch = { workspaceId: workspace.id, userId: carl.profile.user.id, role: 'admin' }
    expect((await post(bob, WORKSPACE_MEMBER_ROLE_PATH, hoch)).status).toBe(200)

    // Verwehrt: die Ownerrolle vergeben, den Owner herabstufen oder entfernen, archivieren.
    const zumOwner = { workspaceId: workspace.id, userId: carl.profile.user.id, role: 'owner' }
    expect((await post(bob, WORKSPACE_MEMBER_ROLE_PATH, zumOwner)).status).toBe(403)
    const ownerHerab = { workspaceId: workspace.id, userId: ada.profile.user.id, role: 'member' }
    expect((await post(bob, WORKSPACE_MEMBER_ROLE_PATH, ownerHerab)).status).toBe(403)
    expect(
      (await post(bob, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: ada.profile.user.id }))
        .status,
    ).toBe(403)
    expect((await post(bob, WORKSPACE_STATUS_PATH, { workspaceId: workspace.id, status: 'archived' })).status).toBe(403)
    expect((await addMember(bob, workspace.id, carl.profile.user.id, 'owner')).status).toBe(403)
  })

  it('gibt einem Systemadmin Verwaltung ohne Mitgliedschaft', async () => {
    const root = await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')

    const gelesen = await get(root, WORKSPACE_MEMBERS_PATH, workspace.id)
    expect(gelesen.status).toBe(200)
    // Sichtbar fuer die Administration, aber ohne eigene Rolle.
    expect(((await gelesen.json()) as WorkspaceMembersResponse).workspace.role).toBeNull()
    expect((await addMember(root, workspace.id, bob.profile.user.id, 'owner')).status).toBe(201)
    expect((await post(root, WORKSPACE_RENAME_PATH, { workspaceId: workspace.id, name: 'Verwaltet' })).status).toBe(200)
    expect(await listWorkspaces(root)).toEqual([])
  })

  it('nimmt keinen deaktivierten Nutzer auf und entzieht ihm jeden Zugriff', async () => {
    const root = await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'member')).status).toBe(201)

    const deaktiviert = await post(root, ADMIN_USER_STATUS_PATH, {
      userId: bob.profile.user.id,
      status: 'deactivated',
    })
    expect(deaktiviert.status).toBe(200)

    // Die Mitgliedschaft besteht weiter, der Zugriff nicht.
    expect((await get(bob, WORKSPACES_PATH)).status).toBe(401)
    expect((await get(bob, WORKSPACE_MEMBERS_PATH, workspace.id)).status).toBe(401)
    const members = (await (await get(ada, WORKSPACE_MEMBERS_PATH, workspace.id)).json()) as WorkspaceMembersResponse
    expect(members.members).toHaveLength(2)

    // Ein deaktivierter Nutzer wird gar nicht erst wieder aufgenommen.
    const erneut = await addMember(ada, workspace.id, bob.profile.user.id, 'member')
    expect(erneut.status).toBe(400)
  })

  it('bietet einen deaktivierten Nutzer nicht zur Aufnahme an', async () => {
    const root = await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')

    await post(root, ADMIN_USER_STATUS_PATH, { userId: bob.profile.user.id, status: 'deactivated' })

    // Auch die gezielte Suche nach seiner Adresse findet ihn nicht mehr.
    expect(await foundUsers(ada, workspace.id, 'bob@example.com')).toEqual([])
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'member')).status).toBe(400)
  })
})

describe('Nutzersuche fuer die Aufnahme', () => {
  it('gibt ohne oder mit zu kurzem Suchbegriff keine Daten heraus', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')

    // Ein eigener Arbeitsbereich macht das Verzeichnis nicht abfragbar: ohne Suchbegriff gibt es nichts.
    for (const query of [undefined, '', '   ', 'bo']) {
      const response = await searchCandidates(ada, workspace.id, query)
      expect(response.status).toBe(400)
      expect(await response.text()).not.toContain('bob@example.com')
    }
  })

  it('liefert nur genaue Treffer und deutet keine Platzhalter', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const carla = await signedInAs('carla')
    const workspace = await createWorkspace(ada, 'Team Nord')

    // Weder ein Praefix noch ein Platzhalter noch ein SQL-Versuch macht aus der Suche eine Liste.
    for (const query of ['car', '%%%', '___', "' or 1=1 --", '@example.com']) {
      expect(await foundUsers(ada, workspace.id, query)).toEqual([])
    }

    const treffer = await foundUsers(ada, workspace.id, 'CARLA@example.com')
    expect(treffer.map((user) => user.id)).toEqual([carla.profile.user.id])
    // Wer nach der Adresse sucht, kennt sie bereits; nur dann steht sie auch im Treffer.
    expect(treffer[0]?.email).toBe('carla@example.com')
  })

  it('gibt bei der Suche ueber den Anzeigenamen keine Adresse preis und begrenzt die Trefferzahl', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')
    for (let index = 0; index <= WORKSPACE_MEMBER_MAX_CANDIDATES; index += 1) {
      await signedInAs(`doppel-${String(index)}`, 'Doppel Gaenger')
    }

    const treffer = await foundUsers(ada, workspace.id, 'doppel gaenger')

    expect(treffer).toHaveLength(WORKSPACE_MEMBER_MAX_CANDIDATES)
    expect(treffer.every((user) => user.email === null)).toBe(true)
  })

  it('bietet ein bestehendes Mitglied nicht noch einmal an', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')

    expect((await foundUsers(ada, workspace.id, 'bob@example.com')).map((user) => user.id)).toEqual([
      bob.profile.user.id,
    ])
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'member')).status).toBe(201)
    expect(await foundUsers(ada, workspace.id, 'bob@example.com')).toEqual([])
  })
})

describe('Entzug einer Mitgliedschaft', () => {
  it('wirkt auf den naechsten Request', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'admin')).status).toBe(201)
    expect((await listWorkspaces(bob)).map((entry) => entry.id)).toEqual([workspace.id])

    const entzogen = await post(ada, WORKSPACE_MEMBER_REMOVE_PATH, {
      workspaceId: workspace.id,
      userId: bob.profile.user.id,
    })

    expect(entzogen.status).toBe(200)
    expect(await listWorkspaces(bob)).toEqual([])
    // Der naechste Request sieht den Workspace nicht mehr - und erfaehrt auch nicht, dass es ihn gibt.
    expect((await get(bob, WORKSPACE_MEMBERS_PATH, workspace.id)).status).toBe(404)
    expect((await post(bob, WORKSPACE_RENAME_PATH, { workspaceId: workspace.id, name: 'X' })).status).toBe(404)
    // Die Sitzung selbst bleibt gueltig: entzogen wurde die Mitgliedschaft, nicht die Anmeldung.
    expect((await bob.jar.fetch(`${app.baseUrl}${ME_PATH}`)).status).toBe(200)
  })
})

describe('Gleichzeitige Deaktivierung des Zielnutzers', () => {
  it('nimmt einen zeitgleich deaktivierten Nutzer nicht mehr auf', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')

    // Die Deaktivierung laeuft in einer noch offenen Transaktion: sie ist begonnen, aber nicht sichtbar.
    // Wird der Status ausserhalb der schreibenden Transaktion gelesen, entsteht eine Karteileiche.
    const blocker = await pool.connect()
    let response: Response
    try {
      await blocker.query('begin')
      await blocker.query(`update users set status = 'deactivated' where id = $1`, [bob.profile.user.id])
      const pending = addMember(ada, workspace.id, bob.profile.user.id, 'member')
      await new Promise((resolve) => setTimeout(resolve, 250))
      await blocker.query('commit')
      response = await pending
    } finally {
      blocker.release()
    }

    expect(response.status).toBe(400)
    const members = (await (await get(ada, WORKSPACE_MEMBERS_PATH, workspace.id)).json()) as WorkspaceMembersResponse
    expect(members.members.map((member) => member.userId)).toEqual([ada.profile.user.id])
  })
})

describe('Antwort erst nach dem Commit', () => {
  it('quittiert keinen Erfolg, wenn der Commit scheitert', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')

    // Ein aufgeschobener Constraint-Trigger schlaegt genau beim Commit fehl - also nachdem der
    // Transaktionsrumpf durchgelaufen ist. Genau dann darf der Client noch keine Erfolgsantwort haben.
    await pool.query(
      `create or replace function canvaz_test_commit_fails() returns trigger language plpgsql as
       $$ begin raise exception 'Commit im Test abgelehnt'; end $$`,
    )
    await pool.query(
      `create constraint trigger canvaz_test_commit_fails after update on workspaces
       deferrable initially deferred for each row execute function canvaz_test_commit_fails()`,
    )
    let response: Response
    try {
      response = await post(ada, WORKSPACE_RENAME_PATH, { workspaceId: workspace.id, name: 'Umbenannt' })
    } finally {
      await pool.query('drop trigger if exists canvaz_test_commit_fails on workspaces')
      await pool.query('drop function if exists canvaz_test_commit_fails()')
    }

    expect(response.status).toBe(500)
    // Und die Aenderung ist zurueckgerollt: Antwort und Datenstand widersprechen sich nicht.
    const members = (await (await get(ada, WORKSPACE_MEMBERS_PATH, workspace.id)).json()) as WorkspaceMembersResponse
    expect(members.workspace.name).toBe('Team Nord')
  })
})

describe('Ownerinvariante', () => {
  it('laesst den letzten Owner weder entfernen noch herabstufen', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'admin')).status).toBe(201)

    const herab = await post(ada, WORKSPACE_MEMBER_ROLE_PATH, {
      workspaceId: workspace.id,
      userId: ada.profile.user.id,
      role: 'member',
    })
    const entfernt = await post(ada, WORKSPACE_MEMBER_REMOVE_PATH, {
      workspaceId: workspace.id,
      userId: ada.profile.user.id,
    })

    expect(herab.status).toBe(409)
    expect(entfernt.status).toBe(409)
    const members = (await (await get(ada, WORKSPACE_MEMBERS_PATH, workspace.id)).json()) as WorkspaceMembersResponse
    expect(members.members.filter((entry) => entry.role === 'owner')).toHaveLength(1)
  })

  it('laesst einen Owner gehen, sobald ein zweiter Owner da ist', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'owner')).status).toBe(201)

    const herab = await post(ada, WORKSPACE_MEMBER_ROLE_PATH, {
      workspaceId: workspace.id,
      userId: ada.profile.user.id,
      role: 'member',
    })

    expect(herab.status).toBe(200)
    expect((await listWorkspaces(ada))[0]?.role).toBe('member')
  })

  it('haelt den Workspace beim gleichzeitigen Herabstufen beider Owner besetzt', async () => {
    // Der Akteur ist ein Dritter, der beide Owner gleichzeitig herabstuft. Nur so entscheidet wirklich die
    // Ownerinvariante: wuerden die Owner sich gegenseitig herabstufen, verloere der Zweite schon vorher
    // seine Rolle und die Ablehnung kaeme aus der Policy statt aus der Invariante.
    const root = await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'owner')).status).toBe(201)

    const [erste, zweite] = await Promise.all([
      post(root, WORKSPACE_MEMBER_ROLE_PATH, {
        workspaceId: workspace.id,
        userId: ada.profile.user.id,
        role: 'member',
      }),
      post(root, WORKSPACE_MEMBER_ROLE_PATH, {
        workspaceId: workspace.id,
        userId: bob.profile.user.id,
        role: 'member',
      }),
    ])

    expect([erste.status, zweite.status].sort()).toEqual([200, 409])
    const members = (await (await get(ada, WORKSPACE_MEMBERS_PATH, workspace.id)).json()) as WorkspaceMembersResponse
    expect(members.members.filter((entry) => entry.role === 'owner')).toHaveLength(1)
  })

  it('haelt den Workspace beim gleichzeitigen Entfernen beider Owner besetzt', async () => {
    const root = await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'owner')).status).toBe(201)

    const [erste, zweite] = await Promise.all([
      post(root, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: ada.profile.user.id }),
      post(root, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: bob.profile.user.id }),
    ])

    expect([erste.status, zweite.status].sort()).toEqual([200, 409])
    const uebrig = await pool.query<{ count: string }>(
      "select count(*) from workspace_memberships where workspace_id = $1 and role = 'owner'",
      [workspace.id],
    )
    expect(uebrig.rows[0]?.count).toBe('1')
  })

  it('loest auch den gegenseitigen Entzug zweier Owner ohne ownerlosen Workspace auf', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'owner')).status).toBe(201)

    const [erste, zweite] = await Promise.all([
      post(ada, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: bob.profile.user.id }),
      post(bob, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: ada.profile.user.id }),
    ])

    // Genau einer gewinnt; der Verlierer ist zu diesem Zeitpunkt selbst schon kein Mitglied mehr und
    // erfaehrt deshalb nur noch, dass es den Workspace fuer ihn nicht gibt.
    expect([erste.status, zweite.status].sort()).toEqual([200, 404])
    const uebrig = await pool.query<{ count: string }>(
      "select count(*) from workspace_memberships where workspace_id = $1 and role = 'owner'",
      [workspace.id],
    )
    expect(uebrig.rows[0]?.count).toBe('1')
  })
})

describe('Archivierung', () => {
  it('bleibt lesbar und wird unveraenderlich, bis die Archivierung aufgehoben wird', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const carl = await signedInAs('carl')
    const workspace = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'admin')).status).toBe(201)

    const archiviert = await post(ada, WORKSPACE_STATUS_PATH, { workspaceId: workspace.id, status: 'archived' })
    expect(archiviert.status).toBe(200)
    expect(((await archiviert.json()) as WorkspaceView).status).toBe('archived')

    // Lesbar bleibt alles.
    expect((await get(ada, WORKSPACE_MEMBERS_PATH, workspace.id)).status).toBe(200)
    expect((await get(bob, WORKSPACE_MEMBERS_PATH, workspace.id)).status).toBe(200)
    expect((await listWorkspaces(bob))[0]?.status).toBe('archived')

    // Aenderbar ist nichts mehr - auch nicht fuer den Owner.
    expect((await post(ada, WORKSPACE_RENAME_PATH, { workspaceId: workspace.id, name: 'Neu' })).status).toBe(403)
    expect((await addMember(ada, workspace.id, carl.profile.user.id, 'member')).status).toBe(403)
    const rolle = { workspaceId: workspace.id, userId: bob.profile.user.id, role: 'member' }
    expect((await post(ada, WORKSPACE_MEMBER_ROLE_PATH, rolle)).status).toBe(403)
    expect(
      (await post(ada, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: bob.profile.user.id }))
        .status,
    ).toBe(403)
    // Der Admin kann die Archivierung nicht aufheben, der Owner schon.
    expect((await post(bob, WORKSPACE_STATUS_PATH, { workspaceId: workspace.id, status: 'active' })).status).toBe(403)
    expect((await post(ada, WORKSPACE_STATUS_PATH, { workspaceId: workspace.id, status: 'active' })).status).toBe(200)
    expect((await post(ada, WORKSPACE_RENAME_PATH, { workspaceId: workspace.id, name: 'Neu' })).status).toBe(200)
  })
})

describe('Auditereignisse', () => {
  it('haelt Akteur, Aktion, Ziel und Zeitpunkt fest, ohne sensible Inhalte aufzunehmen', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const vorher = new Date()
    const workspace = await createWorkspace(ada, 'Team Nord')
    await addMember(ada, workspace.id, bob.profile.user.id, 'member')
    await post(ada, WORKSPACE_MEMBER_ROLE_PATH, {
      workspaceId: workspace.id,
      userId: bob.profile.user.id,
      role: 'admin',
    })
    await post(ada, WORKSPACE_RENAME_PATH, { workspaceId: workspace.id, name: 'Team Sued' })
    await post(ada, WORKSPACE_STATUS_PATH, { workspaceId: workspace.id, status: 'archived' })
    await post(ada, WORKSPACE_STATUS_PATH, { workspaceId: workspace.id, status: 'active' })
    await post(ada, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: bob.profile.user.id })

    const events = await app.workspaces.audit.listForWorkspace(workspace.id)

    expect(events.map((event) => event.action)).toEqual([
      'workspace.created',
      'membership.added',
      'membership.added',
      'membership.role-changed',
      'workspace.renamed',
      'workspace.archived',
      'workspace.unarchived',
      'membership.removed',
    ])
    for (const event of events) {
      expect(event.actorId).toBe(ada.profile.user.id)
      expect(event.workspaceId).toBe(workspace.id)
      expect(event.targetId).toBeTruthy()
      expect(['workspace', 'membership']).toContain(event.targetType)
      expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(vorher.getTime())
    }
    expect(events.filter((event) => event.targetType === 'membership').map((event) => event.targetId)).toEqual([
      ada.profile.user.id,
      bob.profile.user.id,
      bob.profile.user.id,
      bob.profile.user.id,
    ])
    expect(events.find((event) => event.action === 'membership.role-changed')?.details).toEqual({
      previousRole: 'member',
      role: 'admin',
    })

    // Kein Tokenmaterial, keine Sitzungsgeheimnisse, keine Adressen und keine Boardinhalte im Nachweis.
    const rohdaten = JSON.stringify(events)
    const cookie = ada.jar.cookieHeader()
    expect(cookie.length).toBeGreaterThan(20)
    expect(rohdaten).not.toContain(cookie)
    expect(rohdaten).not.toContain(ada.profile.csrfToken)
    expect(rohdaten.toLowerCase()).not.toContain('token')
    expect(rohdaten).not.toContain('@example.com')
    const erlaubteSchluessel = new Set(['name', 'previousName', 'role', 'previousRole', 'status', 'reason'])
    for (const event of events) {
      for (const key of Object.keys(event.details)) {
        expect(erlaubteSchluessel).toContain(key)
      }
    }
  })

  it('schreibt kein Ereignis, wenn die Aenderung abgelehnt wurde', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    await addMember(ada, workspace.id, bob.profile.user.id, 'member')
    const vorher = (await app.workspaces.audit.listForWorkspace(workspace.id)).length

    expect((await post(bob, WORKSPACE_RENAME_PATH, { workspaceId: workspace.id, name: 'Meins' })).status).toBe(403)
    expect(
      (await post(ada, WORKSPACE_MEMBER_ROLE_PATH, {
        workspaceId: workspace.id,
        userId: ada.profile.user.id,
        role: 'member',
      })).status,
    ).toBe(409)

    expect(await app.workspaces.audit.listForWorkspace(workspace.id)).toHaveLength(vorher)
  })
})

describe('Workspace-Persistenz', () => {
  it('gibt die sperrende Abfrage nur innerhalb einer Transaktion heraus', async () => {
    await expect(app.workspaces.workspaces.findForUpdate(FREMDE_KENNUNG, FREMDE_KENNUNG)).rejects.toThrow()
    await expect(
      app.workspaces.transaction((tx) => tx.workspaces.findForUpdate(FREMDE_KENNUNG, FREMDE_KENNUNG)),
    ).resolves.toBeNull()
  })

  it('raeumt Mitgliedschaften und Nachweise mit dem Workspace ab', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const workspace = await createWorkspace(ada, 'Team Nord')

    await pool.query('delete from workspaces where id = $1', [workspace.id])

    const mitgliedschaften = await pool.query('select 1 from workspace_memberships where workspace_id = $1', [
      workspace.id,
    ])
    expect(mitgliedschaften.rowCount).toBe(0)
    expect(await app.workspaces.audit.listForWorkspace(workspace.id)).toEqual([])
  })
})

describe('Andockpunkt der Realtime-Strecke', () => {
  it('beantwortet die Workspacezugehoerigkeit live, sodass ein Entzug auf neue Verbindungen wirkt', async () => {
    await instanzMitAdmin()
    const ada = await signedInAs('ada')
    const bob = await signedInAs('bob')
    const workspace = await createWorkspace(ada, 'Team Nord')
    expect((await addMember(ada, workspace.id, bob.profile.user.id, 'member')).status).toBe(201)

    // Der Andockpunkt bekommt genau die Abfrage, die ein spaeterer Boardraum beim Beitritt braucht.
    const scopes = new Map<string, WorkspaceScope>()
    const realtimeApp = await startTestApp({
      provider,
      pool,
      databaseUrl: DATABASE_URL,
      onConnection: (_socket, auth, scope) => {
        scopes.set(auth.user.id, scope)
      },
    })
    try {
      const jar = createJar()
      expect((await login(realtimeApp, jar, { subject: 'bob' })).error).toBeNull()
      const { WebSocket } = await import('ws')
      const socket = new WebSocket(`${realtimeApp.baseUrl.replace('http:', 'ws:')}/api/realtime`, {
        headers: { cookie: jar.cookieHeader() },
      })
      await new Promise((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      const scope = scopes.get(bob.profile.user.id)
      expect(scope).toBeDefined()
      expect(await scope?.role(workspace.id)).toBe('member')

      await post(ada, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: bob.profile.user.id })

      // Dieselbe, bereits offene Verbindung sieht die Aenderung sofort: es wird nichts zwischengespeichert.
      expect(await scope?.role(workspace.id)).toBeNull()
      socket.close()
    } finally {
      await realtimeApp.close()
    }
  })
})
