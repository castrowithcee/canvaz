/**
 * Wiederkehrender Ausgangszustand der Board- und Realtime-Tests.
 *
 * Angemeldetes Konto, Arbeitsbereich, Mitgliedschaft und Board entstehen ausschliesslich ueber die echten
 * Endpunkte mit echtem Cookie und echtem CSRF-Token. Es gibt hier keinen direkten Datenbankzugriff und
 * keinen Aufbau an den Guards vorbei - was der Test spaeter prueft, muss er zuerst regulaer erreichen.
 */

import type { Pool } from 'pg'

import { BOARDS_PATH, CSRF_HEADER, ME_PATH, WORKSPACE_MEMBER_ADD_PATH, WORKSPACES_PATH } from '../../src/contracts/api.js'
import type { BoardView, MeResponse, WorkspaceView } from '../../src/contracts/api.js'
import type { SceneSnapshot } from '../../src/contracts/scene.js'
import { createJar } from './browser-client.js'
import type { Jar } from './browser-client.js'
import { login } from './login-flow.js'
import type { TestApp } from './test-app.js'

export type Account = { readonly jar: Jar; readonly profile: MeResponse }

function erwarte(bedingung: boolean, meldung: string): void {
  if (!bedingung) {
    throw new Error(meldung)
  }
}

export async function signedInAs(app: TestApp, subject: string): Promise<Account> {
  const jar = createJar()
  const result = await login(app, jar, { subject })
  erwarte(result.error === null, `Anmeldung als ${subject} scheiterte: ${String(result.error)}`)
  const response = await jar.fetch(`${app.baseUrl}${ME_PATH}`)
  erwarte(response.status === 200, `Profilabruf antwortete mit ${String(response.status)}`)
  return { jar, profile: (await response.json()) as MeResponse }
}

export function post(app: TestApp, account: Account, path: string, body: unknown): Promise<Response> {
  return account.jar.fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: account.profile.csrfToken },
    body: JSON.stringify(body),
  })
}

export async function createWorkspace(app: TestApp, account: Account, name: string): Promise<WorkspaceView> {
  const response = await post(app, account, WORKSPACES_PATH, { name })
  erwarte(response.status === 201, `Arbeitsbereich anlegen antwortete mit ${String(response.status)}`)
  return (await response.json()) as WorkspaceView
}

export async function createBoard(
  app: TestApp,
  account: Account,
  workspaceId: string,
  title: string,
): Promise<BoardView> {
  const response = await post(app, account, BOARDS_PATH, { workspaceId, title })
  erwarte(response.status === 201, `Board anlegen antwortete mit ${String(response.status)}`)
  return (await response.json()) as BoardView
}

export async function addMember(
  app: TestApp,
  owner: Account,
  workspaceId: string,
  member: Account,
): Promise<void> {
  const response = await post(app, owner, WORKSPACE_MEMBER_ADD_PATH, {
    workspaceId,
    userId: member.profile.user.id,
    role: 'member',
  })
  erwarte(response.status === 201, `Mitglied hinzufuegen antwortete mit ${String(response.status)}`)
}

/** Standardaufbau: Ada besitzt den Arbeitsbereich, Bob ist Mitglied, ein Board ist angelegt. */
export async function teamMitBoard(app: TestApp) {
  const ada = await signedInAs(app, 'ada')
  const bob = await signedInAs(app, 'bob')
  const workspace = await createWorkspace(app, ada, 'Team Nord')
  await addMember(app, ada, workspace.id, bob)
  const board = await createBoard(app, ada, workspace.id, 'Skizze')
  return { ada, bob, workspace, board }
}

/* ---------------------------------------------------------------------------------------------------- */
/* Blick in die Persistenz                                                                               */
/* ---------------------------------------------------------------------------------------------------- */

/**
 * Gelesen wird direkt aus `scene_versions`, nicht ueber die API.
 *
 * Ein Test, der die Speicherung ueber denselben Weg prueft, ueber den sie entstanden ist, belegt nur, dass
 * der Weg mit sich selbst uebereinstimmt.
 */
export async function storedScene(
  pool: Pool,
  boardId: string,
): Promise<{ readonly version: number; readonly scene: SceneSnapshot }> {
  const rows = await pool.query<{ version: number; scene: SceneSnapshot }>(
    'select version, scene from scene_versions where board_id = $1 order by version desc limit 1',
    [boardId],
  )
  const row = rows.rows[0]
  if (row === undefined) {
    throw new Error('Zu diesem Board wurde noch nichts gespeichert')
  }
  return { version: row.version, scene: row.scene }
}

export async function storedVersions(pool: Pool, boardId: string): Promise<number> {
  const rows = await pool.query<{ count: string }>('select count(*) from scene_versions where board_id = $1', [boardId])
  return Number(rows.rows[0]?.count ?? '0')
}

/** Wartet, bis ein Checkpoint die erwartete Version geschrieben hat. */
export async function warteAufVersion(pool: Pool, boardId: string, version: number): Promise<void> {
  for (let versuch = 0; versuch < 100; versuch += 1) {
    const rows = await pool.query<{ current_scene_version: number }>(
      'select current_scene_version from boards where id = $1',
      [boardId],
    )
    if ((rows.rows[0]?.current_scene_version ?? 0) >= version) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Version ${String(version)} wurde nicht persistiert`)
}

/** Wartet, bis der gespeicherte Stand ein bestimmtes Element enthaelt. */
export async function warteAufElement(pool: Pool, boardId: string, elementId: string): Promise<SceneSnapshot> {
  for (let versuch = 0; versuch < 100; versuch += 1) {
    const rows = await pool.query<{ scene: SceneSnapshot }>(
      'select scene from scene_versions where board_id = $1 order by version desc limit 1',
      [boardId],
    )
    const scene = rows.rows[0]?.scene
    if (scene !== undefined && scene.elements.some((element) => element.id === elementId)) {
      return scene
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Element ${elementId} wurde nicht persistiert`)
}
