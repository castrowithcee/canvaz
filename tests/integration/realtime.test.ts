/**
 * Echtzeit-Kollaboration gegen die echte Anwendung, echte WebSocket-Verbindungen und eine echte Datenbank.
 *
 * Es gibt keinen verkuerzten Weg an den Guards vorbei: jeder Teilnehmer meldet sich ueber den echten
 * OIDC-Fluss an, verbindet sich mit demselben Cookie wie ein Browser und spricht ausschliesslich das
 * Protokoll aus `src/contracts/realtime.ts`. Die Negativtests umgehen bewusst jede Oberflaeche und schicken
 * die manipulierte Nachricht direkt auf den Socket - genau das, wogegen die Serverpruefung schuetzen muss.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { WebSocket } from 'ws'

import {
  ADMIN_USER_STATUS_PATH,
  BOARD_SCENE_PATH,
  BOARD_STATUS_PATH,
  BOARDS_PATH,
  CSRF_HEADER,
  ME_PATH,
  REALTIME_PATH,
  WORKSPACE_MEMBER_ADD_PATH,
  WORKSPACE_MEMBER_REMOVE_PATH,
  WORKSPACE_STATUS_PATH,
  WORKSPACES_PATH,
} from '../../src/contracts/api.js'
import type { BoardView, MeResponse, WorkspaceView } from '../../src/contracts/api.js'
import type { ServerMessage } from '../../src/contracts/realtime.js'
import { BOARD_ACCESS_REVOKED_CLOSE_CODE, REALTIME_PROTOCOL_VERSION } from '../../src/contracts/realtime.js'
import type { SceneSnapshot, SyncElement } from '../../src/contracts/scene.js'
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

/** So lange wartet ein Test, bevor er behauptet, dass **nichts** angekommen ist. */
const RUHE_MS = 200

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

type Account = { readonly jar: Jar; readonly profile: MeResponse }

async function signedInAs(subject: string): Promise<Account> {
  const jar = createJar()
  expect((await login(app, jar, { subject })).error).toBeNull()
  const response = await jar.fetch(`${app.baseUrl}${ME_PATH}`)
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

async function createBoard(account: Account, workspaceId: string, title: string): Promise<BoardView> {
  const response = await post(account, BOARDS_PATH, { workspaceId, title })
  expect(response.status).toBe(201)
  return (await response.json()) as BoardView
}

function ruhe(ms = RUHE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type Client = {
  readonly socket: WebSocket
  /** Alles, was je angekommen ist. Auch die bereits abgeholten Nachrichten bleiben stehen. */
  readonly log: readonly ServerMessage[]
  send(message: unknown): void
  /** Rohtext statt Vertrag - nur die Negativtests brauchen das. */
  sendRaw(raw: string): void
  /** Naechste noch nicht abgeholte Nachricht dieses Typs, die `passt` erfuellt. */
  next<T extends ServerMessage['type']>(
    type: T,
    passt?: (message: Extract<ServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { type: T }>>
  readonly closeCode: Promise<number>
  close(): void
}

const clients: Client[] = []

/** Verbindet wie ein Browser: dasselbe Cookie, dieselbe Herkunft, kein Sonderweg. */
async function connect(account: Account): Promise<Client> {
  const socket = new WebSocket(`${app.baseUrl.replace('http:', 'ws:')}${REALTIME_PATH}`, {
    headers: { cookie: account.jar.cookieHeader(), origin: app.baseUrl },
  })
  const log: ServerMessage[] = []
  const taken = new Set<number>()
  type Waiter = {
    readonly type: string
    readonly passt: (message: ServerMessage) => boolean
    readonly resolve: (message: ServerMessage) => void
  }
  const waiters: Waiter[] = []

  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString('utf8')) as ServerMessage
    const index = log.length
    log.push(message)
    const waiting = waiters.findIndex((waiter) => waiter.type === message.type && waiter.passt(message))
    if (waiting >= 0) {
      taken.add(index)
      waiters.splice(waiting, 1)[0]?.resolve(message)
    }
  })

  const closeCode = new Promise<number>((resolve) => {
    socket.once('close', resolve)
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  const client: Client = {
    socket,
    log,
    send(message: unknown): void {
      socket.send(JSON.stringify(message))
    },
    sendRaw(raw: string): void {
      socket.send(raw)
    },
    next<T extends ServerMessage['type']>(
      type: T,
      passt: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    ): Promise<Extract<ServerMessage, { type: T }>> {
      const trifft = (message: ServerMessage): boolean =>
        message.type === type && passt(message as Extract<ServerMessage, { type: T }>)
      const index = log.findIndex((message, position) => !taken.has(position) && trifft(message))
      if (index >= 0) {
        taken.add(index)
        return Promise.resolve(log[index] as Extract<ServerMessage, { type: T }>)
      }
      return new Promise((resolve) => {
        waiters.push({ type, passt: trifft, resolve: resolve as (message: ServerMessage) => void })
      })
    },
    closeCode,
    close(): void {
      socket.close()
    },
  }
  clients.push(client)
  await client.next('ready')
  return client
}

async function join(client: Client, boardId: string) {
  client.send({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId })
  return client.next('joined')
}

function change(boardId: string, elements: readonly SyncElement[], fileIds: readonly string[] = []): unknown {
  return { type: 'scene-change', boardId, elements, appState: null, fileIds }
}

/** Ein Element mit frei waehlbarer Version und Nonce; die Reconciliation entscheidet ueber genau diese. */
function element(id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}): SyncElement {
  return { id, version, versionNonce, type: 'rectangle', x: 10, y: 20, width: 30, height: 40, ...extra }
}

function ids(elements: readonly SyncElement[]): string[] {
  return elements.map((entry) => entry.id)
}

async function storedScene(boardId: string): Promise<{ readonly version: number; readonly scene: SceneSnapshot }> {
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

async function storedVersions(boardId: string): Promise<number> {
  const rows = await pool.query<{ count: string }>('select count(*) from scene_versions where board_id = $1', [boardId])
  return Number(rows.rows[0]?.count ?? '0')
}

/** Wartet, bis ein Checkpoint die erwartete Version geschrieben hat. */
async function warteAufVersion(boardId: string, version: number): Promise<void> {
  for (let versuch = 0; versuch < 100; versuch += 1) {
    const rows = await pool.query<{ current_scene_version: number }>(
      'select current_scene_version from boards where id = $1',
      [boardId],
    )
    if ((rows.rows[0]?.current_scene_version ?? 0) >= version) {
      return
    }
    await ruhe(20)
  }
  throw new Error(`Version ${String(version)} wurde nicht persistiert`)
}

beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
  provider.resetBehaviour()
  app.clearLogs()
})

afterEach(async () => {
  // Erst die Verbindungen schliessen, dann die Datenbank leeren: sonst liefe der abschliessende Checkpoint
  // gegen ein bereits geloeschtes Board.
  for (const client of clients.splice(0)) {
    client.close()
    await client.closeCode
  }
  for (let versuch = 0; versuch < 100 && app.rooms.roomCount > 0; versuch += 1) {
    await ruhe(10)
  }
  expect(app.rooms.roomCount).toBe(0)
  // Der abschliessende Checkpoint eines gerade geschlossenen Raums laeuft noch; erst danach darf geleert
  // werden, sonst raeumt der Test unter einer offenen Transaktion auf.
  await ruhe(100)
})

/** Standardaufbau: Ada besitzt den Arbeitsbereich, Bob ist Mitglied, ein Board ist angelegt. */
async function teamMitBoard() {
  const ada = await signedInAs('ada')
  const bob = await signedInAs('bob')
  const workspace = await createWorkspace(ada, 'Team Nord')
  expect((await post(ada, WORKSPACE_MEMBER_ADD_PATH, {
    workspaceId: workspace.id,
    userId: bob.profile.user.id,
    role: 'member',
  })).status).toBe(201)
  const board = await createBoard(ada, workspace.id, 'Skizze')
  return { ada, bob, workspace, board }
}

/* ---------------------------------------------------------------------------------------------------- */
/* Beitritt                                                                                              */
/* ---------------------------------------------------------------------------------------------------- */

describe('Autorisierter Raumbeitritt', () => {
  it('laesst ein Mitglied beitreten und liefert den vollstaendigen Raumzustand', async () => {
    const { ada, board } = await teamMitBoard()
    const client = await connect(ada)

    const joined = await join(client, board.id)

    expect(joined.boardId).toBe(board.id)
    expect(joined.canWrite).toBe(true)
    expect(joined.version).toBe(0)
    expect(joined.scene.elements).toEqual([])
    expect(joined.peers).toHaveLength(1)
    expect(joined.peers[0]?.clientId).toBe(joined.clientId)
  })

  it('verraet einem Nichtmitglied nicht, ob das Board existiert', async () => {
    const { board } = await teamMitBoard()
    const mallory = await signedInAs('mallory')
    const client = await connect(mallory)

    client.send({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId: board.id })
    const fremdesBoard = await client.next('error')

    client.send({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId: FREMDE_KENNUNG })
    const erfundeneKennung = await client.next('error')

    expect(fremdesBoard.code).toBe('board-nicht-gefunden')
    expect(erfundeneKennung).toEqual(fremdesBoard)
  })

  it('laesst bei einem archivierten Board lesen, aber nicht schreiben', async () => {
    const { ada, board } = await teamMitBoard()
    expect((await post(ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(200)
    const client = await connect(ada)

    const joined = await join(client, board.id)

    expect(joined.canWrite).toBe(false)
    client.send(change(board.id, [element('a', 1, 5)]))
    expect((await client.next('error')).code).toBe('kein-schreibrecht')
    expect(await storedVersions(board.id)).toBe(0)
  })

  it('weist eine abweichende Protokollversion ab', async () => {
    const { ada, board } = await teamMitBoard()
    const client = await connect(ada)

    client.send({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION + 1, boardId: board.id })

    expect((await client.next('error')).code).toBe('protokoll-version')
  })

  it('weist einen zweiten Beitritt derselben Verbindung ab, ohne den Raum zu wechseln', async () => {
    const { ada, workspace, board } = await teamMitBoard()
    const zweites = await createBoard(ada, workspace.id, 'Zweites')
    const client = await connect(ada)
    await join(client, board.id)

    client.send({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId: zweites.id })
    expect((await client.next('error')).code).toBe('falscher-zustand')

    // Der urspruengliche Raum traegt weiter: die Aenderung wird angenommen.
    client.send(change(board.id, [element('a', 1, 5)]))
    await warteAufVersion(board.id, 1)
  })

  it('trennt den Raum beim Verlassen und laesst danach einen neuen Beitritt zu', async () => {
    const { ada, workspace, board } = await teamMitBoard()
    const zweites = await createBoard(ada, workspace.id, 'Zweites')
    const client = await connect(ada)
    await join(client, board.id)

    client.send({ type: 'leave', boardId: board.id })
    expect((await client.next('left')).boardId).toBe(board.id)

    expect((await join(client, zweites.id)).boardId).toBe(zweites.id)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Rechteaenderung waehrend der Verbindung                                                               */
/* ---------------------------------------------------------------------------------------------------- */

describe('Rechteaenderung wirkt auf die offene Verbindung', () => {
  it('beendet die Verbindung bei einem Mitgliedschaftsentzug', async () => {
    const { ada, bob, workspace, board } = await teamMitBoard()
    const client = await connect(bob)
    await join(client, board.id)

    expect(
      (await post(ada, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: bob.profile.user.id }))
        .status,
    ).toBe(200)

    expect((await client.next('error')).code).toBe('board-nicht-gefunden')
    expect(await client.closeCode).toBe(BOARD_ACCESS_REVOKED_CLOSE_CODE)
  })

  it('beendet die Verbindung bei der Deaktivierung des Nutzers', async () => {
    const { bob, board } = await teamMitBoard()
    // Der erste angemeldete Nutzer ist Systemadmin; hier legt ein eigener Admin Hand an.
    const admin = await signedInAs('ada')
    const client = await connect(bob)
    await join(client, board.id)

    expect(
      (await post(admin, ADMIN_USER_STATUS_PATH, { userId: bob.profile.user.id, status: 'deactivated' })).status,
    ).toBe(200)

    // Die Sitzungsebene schliesst bereits; auf welchem Weg, entscheidet nicht der Raum.
    expect(await client.closeCode).toBeGreaterThan(0)
  })

  it('stuft eine offene Verbindung herab, sobald das Board archiviert wird', async () => {
    const { ada, bob, board } = await teamMitBoard()
    const client = await connect(bob)
    expect((await join(client, board.id)).canWrite).toBe(true)

    expect((await post(ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(200)

    expect(await client.next('access')).toEqual({ type: 'access', boardId: board.id, canWrite: false })
    client.send(change(board.id, [element('a', 1, 5)]))
    expect((await client.next('error')).code).toBe('kein-schreibrecht')
    expect(await storedVersions(board.id)).toBe(0)
  })

  it('stuft eine offene Verbindung herab, sobald der Arbeitsbereich archiviert wird', async () => {
    const { ada, workspace, board } = await teamMitBoard()
    const client = await connect(ada)
    await join(client, board.id)

    expect((await post(ada, WORKSPACE_STATUS_PATH, { workspaceId: workspace.id, status: 'archived' })).status).toBe(200)

    expect((await client.next('access')).canWrite).toBe(false)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Negativtests: manipulierte Nachrichten                                                                */
/* ---------------------------------------------------------------------------------------------------- */

describe('Manipulierte Nachrichten', () => {
  it('weist unbekannten Typ und fehlerhafte Struktur ab, ohne die Verbindung zu verlieren', async () => {
    const { ada, board } = await teamMitBoard()
    const client = await connect(ada)
    await join(client, board.id)

    client.send({ type: 'board:drop', boardId: board.id })
    expect((await client.next('error')).code).toBe('unbekannter-typ')

    client.sendRaw('{kein json')
    expect((await client.next('error')).code).toBe('ungueltige-nachricht')

    client.send({ type: 'scene-change', boardId: board.id, elements: [{ id: 'a' }], appState: null, fileIds: [] })
    expect((await client.next('error')).code).toBe('ungueltige-nachricht')

    client.send({ type: 'presence', boardId: board.id, pointer: { x: 'links', y: 2 }, selectedElementIds: [] })
    expect((await client.next('error')).code).toBe('ungueltige-nachricht')

    // Die Verbindung ist danach unveraendert benutzbar.
    client.send(change(board.id, [element('a', 1, 5)]))
    await warteAufVersion(board.id, 1)
  })

  it('weist eine Aenderung vor dem Beitritt ab', async () => {
    const { ada, board } = await teamMitBoard()
    const client = await connect(ada)

    client.send(change(board.id, [element('a', 1, 5)]))

    expect((await client.next('error')).code).toBe('falscher-zustand')
    expect(await storedVersions(board.id)).toBe(0)
  })

  it('weist einen fremden Boardbezug in einer Nachricht ab und gibt nichts weiter', async () => {
    const { ada, bob, workspace, board } = await teamMitBoard()
    const fremdes = await createBoard(ada, workspace.id, 'Fremdes')
    const schreiber = await connect(bob)
    const zuschauer = await connect(ada)
    await join(schreiber, board.id)
    const zuschauerRaum = await join(zuschauer, fremdes.id)

    // Bob ist in "board", nennt aber "fremdes" - beides sind Boards, die er sehen darf.
    schreiber.send(change(fremdes.id, [element('a', 1, 5)]))

    expect((await schreiber.next('error')).code).toBe('board-nicht-gefunden')
    await ruhe()
    expect(zuschauer.log.filter((message) => message.type === 'scene-change')).toEqual([])
    expect(await storedVersions(fremdes.id)).toBe(0)
    expect(await storedVersions(board.id)).toBe(0)
    expect(zuschauerRaum.scene.elements).toEqual([])
  })

  it('verwirft eine nicht speicherbare Aenderung, statt sie weiterzugeben', async () => {
    const { ada, bob, board } = await teamMitBoard()
    const schreiber = await connect(bob)
    const zuschauer = await connect(ada)
    await join(schreiber, board.id)
    await join(zuschauer, board.id)

    schreiber.send(change(board.id, [element('a', 1, 5, { text: 'kaputt ' })]))

    expect((await schreiber.next('error')).code).toBe('nicht-speicherbar')
    await ruhe()
    expect(zuschauer.log.filter((message) => message.type === 'scene-change')).toEqual([])
    expect(await storedVersions(board.id)).toBe(0)
  })

  it('verwirft den Schreibversuch eines Teilnehmers ohne Schreibrecht vollstaendig', async () => {
    const { ada, bob, board } = await teamMitBoard()
    const zuschauer = await connect(bob)
    const leser = await connect(ada)
    await join(zuschauer, board.id)
    await join(leser, board.id)
    // Serverseitiger Entzug des Schreibrechts: das Board wird archiviert.
    expect((await post(ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(200)
    expect((await zuschauer.next('access')).canWrite).toBe(false)
    await leser.next('access')

    // Die Oberflaeche waere jetzt im Nur-Lese-Modus; der Test schickt die Nachricht trotzdem.
    zuschauer.send(change(board.id, [element('a', 1, 5)]))

    expect((await zuschauer.next('error')).code).toBe('kein-schreibrecht')
    await ruhe()
    expect(leser.log.filter((message) => message.type === 'scene-change')).toEqual([])
    expect(await storedVersions(board.id)).toBe(0)
    leser.send({ type: 'resync', boardId: board.id })
    expect((await leser.next('snapshot')).scene.elements).toEqual([])
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Fanout und Presence                                                                                   */
/* ---------------------------------------------------------------------------------------------------- */

describe('Fanout und Presence', () => {
  it('verteilt eine Aenderung an die anderen, aber nicht an den Absender', async () => {
    const { ada, bob, board } = await teamMitBoard()
    const schreiber = await connect(ada)
    const empfaenger = await connect(bob)
    await join(schreiber, board.id)
    await join(empfaenger, board.id)

    schreiber.send(change(board.id, [element('a', 1, 5)]))

    const weitergabe = await empfaenger.next('scene-change')
    expect(ids(weitergabe.elements)).toEqual(['a'])
    await ruhe()
    expect(schreiber.log.filter((message) => message.type === 'scene-change')).toEqual([])
  })

  it('meldet Beitritt, Zeiger, Auswahl und Verlassen als fluechtige Presence', async () => {
    const { ada, bob, board } = await teamMitBoard()
    const erster = await connect(ada)
    const zweiter = await connect(bob)
    await join(erster, board.id)
    await join(zweiter, board.id)

    const nachBeitritt = await erster.next('presence', (message) => message.peers.length === 2)
    expect(nachBeitritt.peers.map((peer) => peer.displayName).sort()).toEqual(['ada', 'bob'])
    // Presence traegt nur Anzeigename und fluechtige Kennung - keine E-Mail, keine Nutzerkennung, keine Rolle.
    for (const peer of nachBeitritt.peers) {
      expect(Object.keys(peer).sort()).toEqual(['canWrite', 'clientId', 'displayName', 'pointer', 'selectedElementIds'])
    }
    expect(JSON.stringify(nachBeitritt)).not.toContain('@example.com')

    zweiter.send({ type: 'presence', boardId: board.id, pointer: { x: 12, y: 34 }, selectedElementIds: ['a'] })
    const mitZeiger = await erster.next('presence', (message) =>
      message.peers.some((peer) => peer.pointer !== null),
    )
    const fremder = mitZeiger.peers.find((peer) => peer.displayName === 'bob')
    expect(fremder?.pointer).toEqual({ x: 12, y: 34 })
    expect(fremder?.selectedElementIds).toEqual(['a'])

    zweiter.send({ type: 'leave', boardId: board.id })
    await zweiter.next('left')
    const nachVerlassen = await erster.next('presence', (message) => message.peers.length === 1)
    expect(nachVerlassen.peers.map((peer) => peer.displayName)).toEqual(['ada'])
  })

  it('buendelt viele Zeigerbewegungen zu wenigen Nachrichten', async () => {
    const { ada, bob, board } = await teamMitBoard()
    const beobachter = await connect(ada)
    const beweger = await connect(bob)
    await join(beobachter, board.id)
    await join(beweger, board.id)
    await beobachter.next('presence', (message) => message.peers.length === 2)
    const vorher = beobachter.log.length

    for (let schritt = 0; schritt < 100; schritt += 1) {
      beweger.send({ type: 'presence', boardId: board.id, pointer: { x: schritt, y: schritt }, selectedElementIds: [] })
    }
    await ruhe()

    const nachrichten = beobachter.log.slice(vorher).filter((message) => message.type === 'presence')
    expect(nachrichten.length).toBeLessThan(10)
    // Der zuletzt gemeldete Stand kommt trotzdem an.
    const letzte = nachrichten.at(-1)
    expect(letzte?.peers.find((peer) => peer.displayName === 'bob')?.pointer).toEqual({ x: 99, y: 99 })
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Konfliktfaelle                                                                                        */
/* ---------------------------------------------------------------------------------------------------- */

describe('Konfliktfaelle', () => {
  it('fuehrt die gleichzeitige Aenderung desselben Elements auf beiden Seiten und in der Persistenz gleich zusammen', async () => {
    const { ada, bob, board } = await teamMitBoard()
    const einer = await connect(ada)
    const anderer = await connect(bob)
    await join(einer, board.id)
    await join(anderer, board.id)

    // Gleiche Version, verschiedener Nonce: der kleinere gewinnt - unabhaengig von der Reihenfolge.
    einer.send(change(board.id, [element('a', 7, 900, { text: 'verliert' })]))
    anderer.send(change(board.id, [element('a', 7, 100, { text: 'gewinnt' })]))

    await warteAufVersion(board.id, 1)
    const gespeichert = await storedScene(board.id)
    expect(gespeichert.scene.elements).toHaveLength(1)
    expect(gespeichert.scene.elements[0]?.['text']).toBe('gewinnt')

    // Beide Seiten fragen den Raum und sehen denselben Stand wie die Persistenz.
    einer.send({ type: 'resync', boardId: board.id })
    anderer.send({ type: 'resync', boardId: board.id })
    const links = await einer.next('snapshot')
    const rechts = await anderer.next('snapshot')
    expect(links.scene.elements).toEqual(rechts.scene.elements)
    expect(links.scene.elements[0]?.['text']).toBe('gewinnt')
  })

  it('haelt eine Loeschung gegen eine gleichzeitige Aenderung als Tombstone fest', async () => {
    const { ada, bob, board } = await teamMitBoard()
    const einer = await connect(ada)
    const anderer = await connect(bob)
    await join(einer, board.id)
    await join(anderer, board.id)
    einer.send(change(board.id, [element('a', 1, 500)]))
    await anderer.next('scene-change')

    // Die Loeschung traegt die hoehere Version und gewinnt gegen die spaeter eintreffende Aenderung.
    einer.send(change(board.id, [element('a', 3, 500, { isDeleted: true })]))
    await anderer.next('scene-change')
    anderer.send(change(board.id, [element('a', 2, 100, { text: 'wiederbelebt' })]))

    await ruhe()
    einer.send({ type: 'resync', boardId: board.id })
    const stand = await einer.next('snapshot')
    expect(stand.scene.elements).toHaveLength(1)
    expect(stand.scene.elements[0]?.['isDeleted']).toBe(true)
    expect(stand.scene.elements[0]?.['text']).toBeUndefined()
    await warteAufVersion(board.id, 1)
    expect((await storedScene(board.id)).scene.elements[0]?.['isDeleted']).toBe(true)
  })

  it('gibt eine verspaetete Nachricht mit aelterer Version nicht weiter', async () => {
    const { ada, bob, board } = await teamMitBoard()
    const einer = await connect(ada)
    const anderer = await connect(bob)
    await join(einer, board.id)
    await join(anderer, board.id)
    einer.send(change(board.id, [element('a', 5, 100)]))
    await anderer.next('scene-change')
    const vorher = anderer.log.length

    anderer.send(change(board.id, [element('a', 2, 100, { text: 'veraltet' })]))

    await ruhe()
    expect(anderer.log.slice(vorher).filter((message) => message.type === 'scene-change')).toEqual([])
    expect(einer.log.filter((message) => message.type === 'scene-change')).toEqual([])
    einer.send({ type: 'resync', boardId: board.id })
    expect((await einer.next('snapshot')).scene.elements[0]?.['version']).toBe(5)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Persistente Checkpoints                                                                               */
/* ---------------------------------------------------------------------------------------------------- */

describe('Persistente Checkpoints', () => {
  it('schreibt bestaetigte Staende getaktet und meldet sie allen Teilnehmern', async () => {
    const { ada, bob, board } = await teamMitBoard()
    const schreiber = await connect(ada)
    const mitleser = await connect(bob)
    await join(schreiber, board.id)
    await join(mitleser, board.id)

    schreiber.send(change(board.id, [element('a', 1, 5)]))
    schreiber.send(change(board.id, [element('b', 1, 6)]))

    const gemeldet = await schreiber.next('saved')
    expect(gemeldet.version).toBe(1)
    expect((await mitleser.next('saved')).version).toBe(1)
    const gespeichert = await storedScene(board.id)
    expect(ids(gespeichert.scene.elements).sort()).toEqual(['a', 'b'])
    // Zwei Aenderungen, ein Checkpoint: es entsteht nicht je Aenderung eine Version.
    expect(await storedVersions(board.id)).toBe(1)
  })

  it('schreibt beim Verlassen des letzten Teilnehmers noch, was offen ist', async () => {
    const { ada, board } = await teamMitBoard()
    const client = await connect(ada)
    await join(client, board.id)

    client.send(change(board.id, [element('a', 1, 5)]))
    // Ohne auf den Takt zu warten: der Raum wird sofort geschlossen.
    client.close()
    await client.closeCode

    await warteAufVersion(board.id, 1)
    expect(ids((await storedScene(board.id)).scene.elements)).toEqual(['a'])
  })

  it('ueberschreibt eine neuere Speicherung der HTTP-API nicht, sondern fuehrt sie zusammen', async () => {
    const { ada, bob, board } = await teamMitBoard()
    const client = await connect(bob)
    await join(client, board.id)
    client.send(change(board.id, [element('raum', 1, 5)]))
    await client.next('saved')

    // Ein zweiter Weg speichert an der laufenden Verbindung vorbei - genau der Fall, den die optimistische
    // Versionspruefung abdeckt.
    const ueberHttp: SceneSnapshot = {
      schemaVersion: 1,
      boardId: board.id,
      elements: [element('http', 1, 9)],
      appState: { viewBackgroundColor: '#ffffff', gridSize: null, gridModeEnabled: false, name: 'Skizze' },
      files: {},
      updatedAt: Date.now(),
    }
    const antwort = await post(ada, BOARD_SCENE_PATH, { boardId: board.id, baseVersion: 1, scene: ueberHttp })
    expect(antwort.status).toBe(200)

    client.send(change(board.id, [element('spaeter', 1, 7)]))
    await warteAufVersion(board.id, 3)

    const gespeichert = await storedScene(board.id)
    expect(gespeichert.version).toBe(3)
    // Nichts ist verloren: der fremde Stand steht neben dem des Raums.
    expect(ids(gespeichert.scene.elements).sort()).toEqual(['http', 'raum', 'spaeter'])
  })
})
