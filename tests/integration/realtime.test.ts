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

import {
  ADMIN_USER_STATUS_PATH,
  BOARD_SCENE_PATH,
  BOARD_STATUS_PATH,
  WORKSPACE_MEMBER_REMOVE_PATH,
  WORKSPACE_STATUS_PATH,
} from '../../src/contracts/api.js'
import { BOARD_ACCESS_REVOKED_CLOSE_CODE, REALTIME_PROTOCOL_VERSION } from '../../src/contracts/realtime.js'
import type { SceneSnapshot } from '../../src/contracts/scene.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import {
  createBoard,
  post,
  signedInAs,
  storedScene,
  storedVersions,
  teamMitBoard,
  warteAufVersion,
} from '../support/board-fixture.js'
import type { Account } from '../support/board-fixture.js'
import { change, element, ids, openRealtime, ruhe } from '../support/realtime-socket.js'
import type { RealtimeTestClient } from '../support/realtime-socket.js'
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

/** Verbindet wie ein Browser: dasselbe Cookie, dieselbe Herkunft, kein Sonderweg. */
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

/* ---------------------------------------------------------------------------------------------------- */
/* Beitritt                                                                                              */
/* ---------------------------------------------------------------------------------------------------- */

describe('Autorisierter Raumbeitritt', () => {
  it('laesst ein Mitglied beitreten und liefert den vollstaendigen Raumzustand', async () => {
    const { ada, board } = await teamMitBoard(app)
    const client = await connect(ada)

    const joined = await client.join(board.id)

    expect(joined.boardId).toBe(board.id)
    expect(joined.canWrite).toBe(true)
    expect(joined.version).toBe(0)
    expect(joined.scene.elements).toEqual([])
    expect(joined.peers).toHaveLength(1)
    expect(joined.peers[0]?.clientId).toBe(joined.clientId)
  })

  it('verraet einem Nichtmitglied nicht, ob das Board existiert', async () => {
    const { board } = await teamMitBoard(app)
    const mallory = await signedInAs(app, 'mallory')
    const client = await connect(mallory)

    client.send({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId: board.id })
    const fremdesBoard = await client.next('error')

    client.send({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId: FREMDE_KENNUNG })
    const erfundeneKennung = await client.next('error')

    expect(fremdesBoard.code).toBe('board-nicht-gefunden')
    expect(erfundeneKennung).toEqual(fremdesBoard)
  })

  it('laesst bei einem archivierten Board lesen, aber nicht schreiben', async () => {
    const { ada, board } = await teamMitBoard(app)
    expect((await post(app, ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(200)
    const client = await connect(ada)

    const joined = await client.join(board.id)

    expect(joined.canWrite).toBe(false)
    client.send(change(board.id, [element('a', 1, 5)]))
    expect((await client.next('error')).code).toBe('kein-schreibrecht')
    expect(await storedVersions(pool, board.id)).toBe(0)
  })

  it('weist eine abweichende Protokollversion ab', async () => {
    const { ada, board } = await teamMitBoard(app)
    const client = await connect(ada)

    client.send({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION + 1, boardId: board.id })

    expect((await client.next('error')).code).toBe('protokoll-version')
  })

  it('weist einen zweiten Beitritt derselben Verbindung ab, ohne den Raum zu wechseln', async () => {
    const { ada, workspace, board } = await teamMitBoard(app)
    const zweites = await createBoard(app, ada, workspace.id, 'Zweites')
    const client = await connect(ada)
    await client.join(board.id)

    client.send({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId: zweites.id })
    expect((await client.next('error')).code).toBe('falscher-zustand')

    // Der urspruengliche Raum traegt weiter: die Aenderung wird angenommen.
    client.send(change(board.id, [element('a', 1, 5)]))
    await warteAufVersion(pool, board.id, 1)
  })

  it('trennt den Raum beim Verlassen und laesst danach einen neuen Beitritt zu', async () => {
    const { ada, workspace, board } = await teamMitBoard(app)
    const zweites = await createBoard(app, ada, workspace.id, 'Zweites')
    const client = await connect(ada)
    await client.join(board.id)

    client.send({ type: 'leave', boardId: board.id })
    expect((await client.next('left')).boardId).toBe(board.id)

    expect((await client.join(zweites.id)).boardId).toBe(zweites.id)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Rechteaenderung waehrend der Verbindung                                                               */
/* ---------------------------------------------------------------------------------------------------- */

describe('Rechteaenderung wirkt auf die offene Verbindung', () => {
  it('beendet die Verbindung bei einem Mitgliedschaftsentzug', async () => {
    const { ada, bob, workspace, board } = await teamMitBoard(app)
    const client = await connect(bob)
    await client.join(board.id)

    expect(
      (await post(app, ada, WORKSPACE_MEMBER_REMOVE_PATH, { workspaceId: workspace.id, userId: bob.profile.user.id }))
        .status,
    ).toBe(200)

    expect((await client.next('error')).code).toBe('board-nicht-gefunden')
    expect(await client.closeCode).toBe(BOARD_ACCESS_REVOKED_CLOSE_CODE)
  })

  it('beendet die Verbindung bei der Deaktivierung des Nutzers', async () => {
    const { bob, board } = await teamMitBoard(app)
    // Der erste angemeldete Nutzer ist Systemadmin; hier legt ein eigener Admin Hand an.
    const admin = await signedInAs(app, 'ada')
    const client = await connect(bob)
    await client.join(board.id)

    expect(
      (await post(app, admin, ADMIN_USER_STATUS_PATH, { userId: bob.profile.user.id, status: 'deactivated' })).status,
    ).toBe(200)

    // Die Sitzungsebene schliesst bereits; auf welchem Weg, entscheidet nicht der Raum.
    expect(await client.closeCode).toBeGreaterThan(0)
  })

  it('stuft eine offene Verbindung herab, sobald das Board archiviert wird', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const client = await connect(bob)
    expect((await client.join(board.id)).canWrite).toBe(true)

    expect((await post(app, ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(200)

    expect(await client.next('access')).toEqual({ type: 'access', boardId: board.id, canWrite: false })
    client.send(change(board.id, [element('a', 1, 5)]))
    expect((await client.next('error')).code).toBe('kein-schreibrecht')
    expect(await storedVersions(pool, board.id)).toBe(0)
  })

  it('stuft eine offene Verbindung herab, sobald der Arbeitsbereich archiviert wird', async () => {
    const { ada, workspace, board } = await teamMitBoard(app)
    const client = await connect(ada)
    await client.join(board.id)

    expect((await post(app, ada, WORKSPACE_STATUS_PATH, { workspaceId: workspace.id, status: 'archived' })).status).toBe(200)

    expect((await client.next('access')).canWrite).toBe(false)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Negativtests: manipulierte Nachrichten                                                                */
/* ---------------------------------------------------------------------------------------------------- */

describe('Manipulierte Nachrichten', () => {
  it('weist unbekannten Typ und fehlerhafte Struktur ab, ohne die Verbindung zu verlieren', async () => {
    const { ada, board } = await teamMitBoard(app)
    const client = await connect(ada)
    await client.join(board.id)

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
    await warteAufVersion(pool, board.id, 1)
  })

  it('weist eine Aenderung vor dem Beitritt ab', async () => {
    const { ada, board } = await teamMitBoard(app)
    const client = await connect(ada)

    client.send(change(board.id, [element('a', 1, 5)]))

    expect((await client.next('error')).code).toBe('falscher-zustand')
    expect(await storedVersions(pool, board.id)).toBe(0)
  })

  it('weist einen fremden Boardbezug in einer Nachricht ab und gibt nichts weiter', async () => {
    const { ada, bob, workspace, board } = await teamMitBoard(app)
    const fremdes = await createBoard(app, ada, workspace.id, 'Fremdes')
    const schreiber = await connect(bob)
    const zuschauer = await connect(ada)
    await schreiber.join(board.id)
    const zuschauerRaum = await zuschauer.join(fremdes.id)

    // Bob ist in "board", nennt aber "fremdes" - beides sind Boards, die er sehen darf.
    schreiber.send(change(fremdes.id, [element('a', 1, 5)]))

    expect((await schreiber.next('error')).code).toBe('board-nicht-gefunden')
    await ruhe()
    expect(zuschauer.log.filter((message) => message.type === 'scene-change')).toEqual([])
    expect(await storedVersions(pool, fremdes.id)).toBe(0)
    expect(await storedVersions(pool, board.id)).toBe(0)
    expect(zuschauerRaum.scene.elements).toEqual([])
  })

  it('verwirft eine nicht speicherbare Aenderung, statt sie weiterzugeben', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const schreiber = await connect(bob)
    const zuschauer = await connect(ada)
    await schreiber.join(board.id)
    await zuschauer.join(board.id)

    schreiber.send(change(board.id, [element('a', 1, 5, { text: 'kaputt ' })]))

    expect((await schreiber.next('error')).code).toBe('nicht-speicherbar')
    await ruhe()
    expect(zuschauer.log.filter((message) => message.type === 'scene-change')).toEqual([])
    expect(await storedVersions(pool, board.id)).toBe(0)
  })

  it('verwirft den Schreibversuch eines Teilnehmers ohne Schreibrecht vollstaendig', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const zuschauer = await connect(bob)
    const leser = await connect(ada)
    await zuschauer.join(board.id)
    await leser.join(board.id)
    // Serverseitiger Entzug des Schreibrechts: das Board wird archiviert.
    expect((await post(app, ada, BOARD_STATUS_PATH, { boardId: board.id, status: 'archived' })).status).toBe(200)
    expect((await zuschauer.next('access')).canWrite).toBe(false)
    await leser.next('access')

    // Die Oberflaeche waere jetzt im Nur-Lese-Modus; der Test schickt die Nachricht trotzdem.
    zuschauer.send(change(board.id, [element('a', 1, 5)]))

    expect((await zuschauer.next('error')).code).toBe('kein-schreibrecht')
    await ruhe()
    expect(leser.log.filter((message) => message.type === 'scene-change')).toEqual([])
    expect(await storedVersions(pool, board.id)).toBe(0)
    leser.send({ type: 'resync', boardId: board.id })
    expect((await leser.next('snapshot')).scene.elements).toEqual([])
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Fanout und Presence                                                                                   */
/* ---------------------------------------------------------------------------------------------------- */

describe('Fanout und Presence', () => {
  it('verteilt eine Aenderung an die anderen, aber nicht an den Absender', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const schreiber = await connect(ada)
    const empfaenger = await connect(bob)
    await schreiber.join(board.id)
    await empfaenger.join(board.id)

    schreiber.send(change(board.id, [element('a', 1, 5)]))

    const weitergabe = await empfaenger.next('scene-change')
    expect(ids(weitergabe.elements)).toEqual(['a'])
    await ruhe()
    expect(schreiber.log.filter((message) => message.type === 'scene-change')).toEqual([])
  })

  it('meldet Beitritt, Zeiger, Auswahl und Verlassen als fluechtige Presence', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const erster = await connect(ada)
    const zweiter = await connect(bob)
    await erster.join(board.id)
    await zweiter.join(board.id)

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
    const { ada, bob, board } = await teamMitBoard(app)
    const beobachter = await connect(ada)
    const beweger = await connect(bob)
    await beobachter.join(board.id)
    await beweger.join(board.id)
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
    const { ada, bob, board } = await teamMitBoard(app)
    const einer = await connect(ada)
    const anderer = await connect(bob)
    await einer.join(board.id)
    await anderer.join(board.id)

    // Gleiche Version, verschiedener Nonce: der kleinere gewinnt - unabhaengig von der Reihenfolge.
    einer.send(change(board.id, [element('a', 7, 900, { text: 'verliert' })]))
    anderer.send(change(board.id, [element('a', 7, 100, { text: 'gewinnt' })]))

    await warteAufVersion(pool, board.id, 1)
    const gespeichert = await storedScene(pool, board.id)
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
    const { ada, bob, board } = await teamMitBoard(app)
    const einer = await connect(ada)
    const anderer = await connect(bob)
    await einer.join(board.id)
    await anderer.join(board.id)
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
    await warteAufVersion(pool, board.id, 1)
    expect((await storedScene(pool, board.id)).scene.elements[0]?.['isDeleted']).toBe(true)
  })

  it('gibt eine verspaetete Nachricht mit aelterer Version nicht weiter', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const einer = await connect(ada)
    const anderer = await connect(bob)
    await einer.join(board.id)
    await anderer.join(board.id)
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
    const { ada, bob, board } = await teamMitBoard(app)
    const schreiber = await connect(ada)
    const mitleser = await connect(bob)
    await schreiber.join(board.id)
    await mitleser.join(board.id)

    schreiber.send(change(board.id, [element('a', 1, 5)]))
    schreiber.send(change(board.id, [element('b', 1, 6)]))

    const gemeldet = await schreiber.next('saved')
    expect(gemeldet.version).toBe(1)
    expect((await mitleser.next('saved')).version).toBe(1)
    const gespeichert = await storedScene(pool, board.id)
    expect(ids(gespeichert.scene.elements).sort()).toEqual(['a', 'b'])
    // Zwei Aenderungen, ein Checkpoint: es entsteht nicht je Aenderung eine Version.
    expect(await storedVersions(pool, board.id)).toBe(1)
  })

  it('schreibt beim Verlassen des letzten Teilnehmers noch, was offen ist', async () => {
    const { ada, board } = await teamMitBoard(app)
    const client = await connect(ada)
    await client.join(board.id)

    client.send(change(board.id, [element('a', 1, 5)]))
    // Ohne auf den Takt zu warten: der Raum wird sofort geschlossen.
    client.close()
    await client.closeCode

    await warteAufVersion(pool, board.id, 1)
    expect(ids((await storedScene(pool, board.id)).scene.elements)).toEqual(['a'])
  })

  it('ueberschreibt eine neuere Speicherung der HTTP-API nicht, sondern fuehrt sie zusammen', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const client = await connect(bob)
    await client.join(board.id)
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
    const antwort = await post(app, ada, BOARD_SCENE_PATH, { boardId: board.id, baseVersion: 1, scene: ueberHttp })
    expect(antwort.status).toBe(200)

    client.send(change(board.id, [element('spaeter', 1, 7)]))
    await warteAufVersion(pool, board.id, 3)

    const gespeichert = await storedScene(pool, board.id)
    expect(gespeichert.version).toBe(3)
    // Nichts ist verloren: der fremde Stand steht neben dem des Raums.
    expect(ids(gespeichert.scene.elements).sort()).toEqual(['http', 'raum', 'spaeter'])
  })
})
