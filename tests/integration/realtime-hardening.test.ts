/**
 * Haertung der Realtime-Strecke gegen die echte Anwendung: Wiederaufnahme, Grenzen, Herzschlag, Rueckstau.
 *
 * Dieselben Regeln wie in `realtime.test.ts`: echter Anmeldefluss, echte WebSocket-Verbindungen, echte
 * Datenbank, kein Sonderweg an den Guards vorbei. Jeder Grenzwert wird **einzeln** ausgereizt, und jeder
 * Fall belegt zusaetzlich, dass der Raum danach weiterarbeitet und die anderen Teilnehmer unbeschaedigt
 * sind - eine Grenze, die den Raum mitnimmt, waere schlimmer als keine.
 *
 * Die Grenzwerte werden hier eng gesetzt. Das ist kein anderer Code: `createBoardRooms` und
 * `createRealtimeGateway` nehmen dieselben Optionen, die im Betrieb ihre begruendeten Standardwerte haben.
 * Ein Test, der fuenf Megabyte Raumzustand zusammenzeichnet, um eine Ablehnung zu sehen, wuerde die Suite
 * ohne jeden zusaetzlichen Erkenntnisgewinn ausbremsen.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  MAX_CHANGE_ELEMENTS,
  MESSAGE_TOO_BIG_CLOSE_CODE,
  REALTIME_PROTOCOL_VERSION,
  SLOW_CLIENT_CLOSE_CODE,
  TOO_MANY_CLOSE_CODE,
} from '../../src/contracts/realtime.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import {
  addMember,
  signedInAs,
  storedScene,
  storedVersions,
  teamMitBoard,
  warteAufElement,
  warteAufVersion,
} from '../support/board-fixture.js'
import type { Account } from '../support/board-fixture.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { change, element, ids, openRealtime, ruhe } from '../support/realtime-socket.js'
import type { RealtimeTestClient } from '../support/realtime-socket.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

/** Kurze Takte. Die Logik ist dieselbe; nur die Wartezeiten des Tests werden ertraeglich. */
const KURZE_TAKTE = {
  checkpointIdleMs: 60,
  checkpointMaxMs: 200,
  presenceIntervalMs: 15,
  accessCheckIntervalMs: 40,
} as const

let pool: Pool
let provider: TestProvider
const apps: TestApp[] = []
const clients: RealtimeTestClient[] = []

type AppOverrides = Parameters<typeof startTestApp>[0]

async function starteApp(overrides: Omit<AppOverrides, 'provider' | 'pool' | 'databaseUrl'> = {}): Promise<TestApp> {
  const app = await startTestApp({
    provider,
    pool,
    databaseUrl: DATABASE_URL,
    ...overrides,
    rooms: { ...KURZE_TAKTE, ...overrides.rooms },
  })
  apps.push(app)
  return app
}

async function connect(app: TestApp, account: Account): Promise<RealtimeTestClient> {
  const client = await openRealtime(app.baseUrl, account.jar.cookieHeader())
  clients.push(client)
  return client
}

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  try {
    await pool.query('select 1')
  } catch (error) {
    throw new Error(`Keine Testdatenbank unter ${DATABASE_URL}. Zuerst "npm run db:up" ausfuehren.`, { cause: error })
  }
  await migrate(pool)
  provider = await startTestProvider()
})

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()))
  await provider.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
  provider.resetBehaviour()
  for (const app of apps) {
    app.clearLogs()
  }
})

afterEach(async () => {
  // Erst die Verbindungen schliessen, dann die Datenbank leeren: sonst liefe der abschliessende Checkpoint
  // gegen ein bereits geloeschtes Board.
  for (const client of clients.splice(0)) {
    client.resume()
    client.close()
    await client.closeCode
  }
  for (let versuch = 0; versuch < 200 && apps.some((app) => app.rooms.roomCount > 0); versuch += 1) {
    await ruhe(10)
  }
  expect(apps.map((app) => app.rooms.roomCount)).toEqual(apps.map(() => 0))
  await ruhe(100)
})

/**
 * Nachrichten, die ein haengender Client unbeantwortet stehen laesst, bis sein Puffer beim Server waechst.
 *
 * Kernel- und Socketpuffer nehmen auf einer Loopback-Strecke mehrere Megabyte auf, bevor `bufferedAmount`
 * ueberhaupt steigt. Der Wert ist deshalb kein Ziel an sich, sondern die gemessene Menge, ab der der
 * Rueckstau sichtbar wird - mit Zuschlag.
 */
const RUECKSTAU_NACHRICHTEN = 200

/** Ein Element mit vorhersagbarer Groesse. `fuellung` Zeichen Text ergeben rund ebenso viele Bytes. */
function grossesElement(id: string, version: number, fuellung: number) {
  return element(id, version, version * 7 + 1, { text: 'x'.repeat(fuellung) })
}

function fehlerCodes(client: RealtimeTestClient): string[] {
  return client.log.filter((message) => message.type === 'error').map((message) => message.code)
}

function hatEreignis(app: TestApp, event: string): boolean {
  return app.logs.some((entry) => entry.event === event)
}

/* ---------------------------------------------------------------------------------------------------- */
/* Wiederaufnahme nach einem Abbruch                                                                     */
/* ---------------------------------------------------------------------------------------------------- */

describe('Wiederaufnahme nach einem Abbruch', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await starteApp()
  })

  it('holt nach einem Abbruch waehrend fremder Bearbeitung den vollstaendigen Stand nach', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const bleibt = await connect(app, ada)
    const bricht = await connect(app, bob)
    await bleibt.join(board.id)
    await bricht.join(board.id)
    bricht.send(change(board.id, [element('bob-1', 1, 10)]))
    await bleibt.next('scene-change')

    // Die Verbindung bricht mitten in der Bearbeitung der Gegenseite ab.
    bricht.close()
    await bricht.closeCode
    bleibt.send(change(board.id, [element('ada-1', 1, 20)]))
    bleibt.send(change(board.id, [element('ada-2', 1, 21)]))
    await warteAufElement(pool, board.id, 'ada-2')

    // Wiederaufnahme: der Server liefert den vollstaendigen Zustand ...
    const wieder = await connect(app, bob)
    const beigetreten = await wieder.join(board.id)
    expect(ids(beigetreten.scene.elements).sort()).toEqual(['ada-1', 'ada-2', 'bob-1'])

    // ... und danach schickt der Client seine eigenen, noch unbestaetigten Aenderungen erneut, statt auf
    // verpasste Teilstuecke zu hoffen (`board-view.tsx`, `onJoined`). Ein Element, das der Raum schon genau
    // so traegt, aendert dabei nichts.
    wieder.send(change(board.id, [element('bob-1', 1, 10), element('bob-offline', 1, 11)]))
    await bleibt.next('scene-change', (message) => ids(message.elements).includes('bob-offline'))

    // Beide Seiten und die Persistenz tragen denselben Stand; nichts fehlt.
    bleibt.send({ type: 'resync', boardId: board.id })
    wieder.send({ type: 'resync', boardId: board.id })
    const links = await bleibt.next('snapshot')
    const rechts = await wieder.next('snapshot')
    const erwartet = ['ada-1', 'ada-2', 'bob-1', 'bob-offline']
    expect(ids(links.scene.elements).sort()).toEqual(erwartet)
    expect(links.scene.elements).toEqual(rechts.scene.elements)
    const gespeichert = await warteAufElement(pool, board.id, 'bob-offline')
    expect(ids(gespeichert.elements).sort()).toEqual(erwartet)
  })

  it('verliert nichts, wenn der Abbruch genau in den Checkpoint faellt', async () => {
    const { ada, board } = await teamMitBoard(app)

    // Der letzte Teilnehmer geht, waehrend sein Abschluss-Checkpoint noch laeuft, und im selben Moment
    // tritt eine bereits offene Verbindung wieder bei. Wuerde der Wiederbeitritt den Raum neben dem
    // laufenden Checkpoint frisch aus der Datenbank laden, saehe er einen Stand ohne die letzte Zeichnung.
    // Mehrere Runden, weil das Zeitfenster in der Groessenordnung einer Datenbanktransaktion liegt.
    for (let runde = 0; runde < 3; runde += 1) {
      const erste = await connect(app, ada)
      await erste.join(board.id)
      const zweite = await connect(app, ada)
      erste.send(change(board.id, [element(`runde-${String(runde)}`, 3, runde + 1)]))
      erste.socket.terminate()
      // Gerade so viel, dass der Server den Abbruch verarbeitet und den Checkpoint beginnt.
      await ruhe(2)

      const beigetreten = await zweite.join(board.id)

      expect(ids(beigetreten.scene.elements).sort()).toEqual(
        Array.from({ length: runde + 1 }, (_, index) => `runde-${String(index)}`),
      )
      zweite.close()
      await zweite.closeCode
    }

    expect(hatEreignis(app, 'board.checkpoint.conflict')).toBe(false)
    const gespeichert = await warteAufElement(pool, board.id, 'runde-2')
    expect(ids(gespeichert.elements).sort()).toEqual(['runde-0', 'runde-1', 'runde-2'])
  })

  it('haelt auch mehrere Abbrueche hintereinander aus', async () => {
    const { ada, board } = await teamMitBoard(app)

    for (let runde = 0; runde < 5; runde += 1) {
      const client = await connect(app, ada)
      const beigetreten = await client.join(board.id)
      // Jede Runde sieht alles, was die vorherigen gezeichnet haben.
      expect(beigetreten.scene.elements).toHaveLength(runde)
      client.send(change(board.id, [element(`runde-${String(runde)}`, 1, runde + 1)]))
      client.socket.terminate()
      await client.closeCode
    }

    const letzte = await connect(app, ada)
    const beigetreten = await letzte.join(board.id)
    expect(ids(beigetreten.scene.elements).sort()).toEqual([
      'runde-0',
      'runde-1',
      'runde-2',
      'runde-3',
      'runde-4',
    ])
    const gespeichert = await warteAufElement(pool, board.id, 'runde-4')
    expect(gespeichert.elements).toHaveLength(5)
  })

  it('erzeugt aus einem inhaltsgleichen Nachsenden nach dem Beitritt keine Version', async () => {
    const { ada, board } = await teamMitBoard(app)
    const erste = await connect(app, ada)
    await erste.join(board.id)
    erste.send(change(board.id, [element('x', 2, 7)]))
    await warteAufVersion(pool, board.id, 1)
    erste.close()
    await erste.closeCode

    const wieder = await connect(app, ada)
    const beigetreten = await wieder.join(board.id)
    wieder.send(change(board.id, beigetreten.scene.elements))

    await ruhe()
    expect(wieder.log.filter((message) => message.type === 'saved')).toEqual([])
    expect(await storedVersions(pool, board.id)).toBe(1)
  })

  it('laesst eine verspaetete Nachricht nach der Wiederaufnahme keinen neueren Stand ueberschreiben', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const bleibt = await connect(app, ada)
    const bricht = await connect(app, bob)
    await bleibt.join(board.id)
    await bricht.join(board.id)
    bleibt.send(change(board.id, [element('x', 5, 100, { text: 'neu' })]))
    await bricht.next('scene-change')
    bricht.close()
    await bricht.closeCode

    // Waehrend der Trennung entstandener, aelterer Stand desselben Elements.
    const wieder = await connect(app, bob)
    await wieder.join(board.id)
    const vorher = bleibt.log.length
    wieder.send(change(board.id, [element('x', 2, 100, { text: 'veraltet' })]))

    await ruhe()
    expect(bleibt.log.slice(vorher).filter((message) => message.type === 'scene-change')).toEqual([])
    wieder.send({ type: 'resync', boardId: board.id })
    const stand = await wieder.next('snapshot')
    expect(stand.scene.elements[0]?.['version']).toBe(5)
    expect(stand.scene.elements[0]?.['text']).toBe('neu')
    await warteAufVersion(pool, board.id, 1)
    expect((await storedScene(pool, board.id)).scene.elements[0]?.['text']).toBe('neu')
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Groessengrenze am Rahmen                                                                              */
/* ---------------------------------------------------------------------------------------------------- */

describe('Groessengrenze am Rahmen', () => {
  let app: TestApp

  beforeAll(async () => {
    // 64 KiB ist der kleinste zulaessige Wert von CANVAZ_MAX_SCENE_BYTES und wirkt als `maxPayload`.
    app = await starteApp({ env: { CANVAZ_MAX_SCENE_BYTES: String(64 * 1024) } })
  })

  it('beendet nur die uebergrosse Verbindung und laesst Prozess und Raum unbeschaedigt', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const zugross = await connect(app, ada)
    const daneben = await connect(app, bob)
    await zugross.join(board.id)
    await daneben.join(board.id)

    zugross.send(change(board.id, [grossesElement('riesig', 1, 200 * 1024)]))

    // `ws` verwirft den Rahmen und schliesst mit dem Standardcode 1009. Ohne den Fehlerzuhoerer im Gateway
    // waere daraus eine nicht abgefangene Ausnahme geworden - also das Ende des gesamten Serverprozesses.
    expect(await zugross.closeCode).toBe(MESSAGE_TOO_BIG_CLOSE_CODE)
    expect(hatEreignis(app, 'realtime.socket.error')).toBe(true)

    // Der Raum traegt weiter: der andere Teilnehmer zeichnet und wird persistiert.
    daneben.send(change(board.id, [element('klein', 1, 5)]))
    expect((await daneben.next('saved')).version).toBe(1)
    expect(ids((await storedScene(pool, board.id)).scene.elements)).toEqual(['klein'])
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Nachrichtenrate                                                                                       */
/* ---------------------------------------------------------------------------------------------------- */

describe('Nachrichtenrate je Verbindung', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await starteApp({ rooms: { messagesPerSecond: 5, messageBurst: 5 } })
  })

  it('verwirft ueber der Rate benannt und nimmt danach wieder an', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const schnell = await connect(app, ada)
    const ruhig = await connect(app, bob)
    await schnell.join(board.id)
    await ruhig.join(board.id)

    for (let schritt = 0; schritt < 8; schritt += 1) {
      schnell.send({ type: 'presence', boardId: board.id, pointer: { x: schritt, y: 0 }, selectedElementIds: [] })
    }
    expect((await schnell.next('error')).code).toBe('zu-viele-nachrichten')

    // Der Raum ist unbeschaedigt: der andere Teilnehmer zeichnet unbeeindruckt weiter.
    ruhig.send(change(board.id, [element('vom-anderen', 1, 5)]))
    await warteAufVersion(pool, board.id, 1)

    // Und nach dem Nachfuellen des Eimers nimmt dieselbe Verbindung wieder an.
    await ruhe(1_200)
    schnell.send(change(board.id, [element('danach', 1, 6)]))
    await ruhig.next('scene-change', (message) => ids(message.elements).includes('danach'))
  })

  it('trennt eine Dauerflut benannt und laesst den Raum stehen', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const flut = await connect(app, ada)
    const ruhig = await connect(app, bob)
    await flut.join(board.id)
    await ruhig.join(board.id)

    for (let schritt = 0; schritt < 40; schritt += 1) {
      flut.send({ type: 'presence', boardId: board.id, pointer: { x: schritt, y: 0 }, selectedElementIds: [] })
    }

    expect(await flut.closeCode).toBe(TOO_MANY_CLOSE_CODE)
    expect(fehlerCodes(flut)).toContain('zu-viele-nachrichten')
    ruhig.send(change(board.id, [element('bleibt', 1, 5)]))
    expect((await ruhig.next('saved')).version).toBe(1)
    expect(app.rooms.roomCount).toBe(1)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Elemente je Nachricht                                                                                 */
/* ---------------------------------------------------------------------------------------------------- */

describe('Elemente je Nachricht', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await starteApp()
  })

  it('weist zu viele Elemente benannt ab, ohne etwas davon zu uebernehmen', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const sender = await connect(app, ada)
    const empfaenger = await connect(app, bob)
    await sender.join(board.id)
    await empfaenger.join(board.id)

    const zuviele = Array.from({ length: MAX_CHANGE_ELEMENTS + 1 }, (_, index) =>
      element(`e${String(index)}`, 1, index + 1),
    )
    sender.send(change(board.id, zuviele))

    expect((await sender.next('error')).code).toBe('zu-viele-elemente')
    await ruhe()
    // Nichts davon ist angekommen - eine halb uebernommene Liste waere stiller Datenverlust.
    expect(empfaenger.log.filter((message) => message.type === 'scene-change')).toEqual([])
    sender.send({ type: 'resync', boardId: board.id })
    expect((await sender.next('snapshot')).scene.elements).toEqual([])

    // Aufgeteilt geht derselbe Stand durch; genau so teilt der Browserclient ihn auf.
    sender.send(change(board.id, zuviele.slice(0, 200)))
    sender.send(change(board.id, zuviele.slice(200, 400)))
    await empfaenger.next('scene-change', (message) => ids(message.elements).includes('e399'))
    await warteAufElement(pool, board.id, 'e399')
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Obergrenze des akkumulierten Raumzustands                                                             */
/* ---------------------------------------------------------------------------------------------------- */

describe('Obergrenze des Raumzustands', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await starteApp({ rooms: { maxRoomBytes: 20_000 } })
  })

  it('lehnt weiteres Wachstum benannt ab und laesst den Raum voll benutzbar', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const sender = await connect(app, ada)
    const empfaenger = await connect(app, bob)
    await sender.join(board.id)
    await empfaenger.join(board.id)

    for (let schritt = 0; schritt < 40; schritt += 1) {
      sender.send(change(board.id, [grossesElement(`e${String(schritt)}`, 1, 1_000)]))
    }

    expect((await sender.next('error')).code).toBe('raum-zu-gross')
    expect(hatEreignis(app, 'realtime.room.too-large')).toBe(true)

    // Der Raum steht: der Empfaenger hat die angenommenen Elemente bekommen ...
    sender.send({ type: 'resync', boardId: board.id })
    const stand = await sender.next('snapshot')
    expect(stand.scene.elements.length).toBeGreaterThan(5)
    expect(stand.scene.elements.length).toBeLessThan(40)

    // ... eine verkleinernde Aenderung wird trotz erreichter Grenze noch angenommen, der Raum findet also
    // zurueck ...
    sender.send(change(board.id, [element('e0', 2, 9, { text: 'kurz' })]))
    await empfaenger.next('scene-change', (message) => ids(message.elements).includes('e0'))

    // ... und der andere Teilnehmer kann weiterhin selbst schreiben.
    empfaenger.send(change(board.id, [element('vom-anderen', 1, 3)]))
    const gespeichert = await warteAufElement(pool, board.id, 'vom-anderen')
    expect(gespeichert.elements.find((entry) => entry.id === 'e0')?.['text']).toBe('kurz')
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Teilnehmer je Raum                                                                                    */
/* ---------------------------------------------------------------------------------------------------- */

describe('Teilnehmer je Raum', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await starteApp({ rooms: { maxRoomParticipants: 2 } })
  })

  it('weist den ueberzaehligen Beitritt benannt ab, ohne die Anwesenden zu stoeren', async () => {
    const { ada, bob, workspace, board } = await teamMitBoard(app)
    const carl = await signedInAs(app, 'carl')
    await addMember(app, ada, workspace.id, carl)
    const erster = await connect(app, ada)
    const zweiter = await connect(app, bob)
    const dritter = await connect(app, carl)
    await erster.join(board.id)
    await zweiter.join(board.id)

    dritter.send({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId: board.id })

    expect((await dritter.next('error')).code).toBe('raum-voll')
    // Die beiden Anwesenden merken nichts davon.
    erster.send(change(board.id, [element('weiter', 1, 5)]))
    await zweiter.next('scene-change', (message) => ids(message.elements).includes('weiter'))

    // Sobald ein Platz frei wird, kommt der Abgewiesene hinein - der Raum bleibt beitretbar.
    zweiter.send({ type: 'leave', boardId: board.id })
    await zweiter.next('left')
    const beigetreten = await dritter.join(board.id)
    expect(ids(beigetreten.scene.elements)).toEqual(['weiter'])
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Verbindungen je Nutzer                                                                                */
/* ---------------------------------------------------------------------------------------------------- */

describe('Verbindungen je Nutzer', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await starteApp({ gateway: { maxConnectionsPerUser: 2 } })
  })

  it('lehnt die ueberzaehlige Verbindung benannt ab und laesst die bestehenden arbeiten', async () => {
    const { ada, board } = await teamMitBoard(app)
    const erste = await connect(app, ada)
    const zweite = await connect(app, ada)
    await erste.join(board.id)

    const dritte = await connect(app, ada)

    expect(await dritte.closeCode).toBe(TOO_MANY_CLOSE_CODE)
    expect(fehlerCodes(dritte)).toEqual(['zu-viele-verbindungen'])
    // Die bestehenden Verbindungen sind unberuehrt.
    erste.send(change(board.id, [element('weiter', 1, 5)]))
    await warteAufVersion(pool, board.id, 1)
    const beigetreten = await zweite.join(board.id)
    expect(ids(beigetreten.scene.elements)).toEqual(['weiter'])
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Herzschlag                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

describe('Herzschlag', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await starteApp({ gateway: { heartbeatIntervalMs: 60 } })
  })

  it('erkennt einen halb offenen Socket und raeumt Raumplatz und Presence auf', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const lebt = await connect(app, ada)
    const tot = await connect(app, bob)
    await lebt.join(board.id)
    await tot.join(board.id)
    await lebt.next('presence', (message) => message.peers.length === 2)

    // Halb offen: die Gegenseite liest nicht mehr, beantwortet also auch keinen Herzschlag. Auf TCP-Ebene
    // ist davon nichts zu sehen - genau das ist der Fall, den nur der Herzschlag findet.
    tot.pause()

    const nachher = await lebt.next('presence', (message) => message.peers.length === 1)
    expect(nachher.peers.map((peer) => peer.displayName)).toEqual(['ada'])
    expect(hatEreignis(app, 'realtime.heartbeat.dead')).toBe(true)
    // Der Raum lebt weiter und nimmt Zeichnungen an.
    lebt.send(change(board.id, [element('danach', 1, 5)]))
    expect((await lebt.next('saved')).version).toBe(1)
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Backpressure                                                                                          */
/* ---------------------------------------------------------------------------------------------------- */

describe('Backpressure', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await starteApp({
      // Kleine Schwellen, aber dieselbe Reihenfolge wie im Betrieb. Das Trennen bleibt hier ausgeschlossen,
      // damit der Test genau den mittleren Schritt zeigt: verwerfen und spaeter vollstaendig abgleichen.
      rooms: { presenceDropBytes: 4_096, changeDropBytes: 16_384, slowCloseBytes: 500 * 1024 * 1024 },
    })
  })

  it('haelt den Raum in Gang und gleicht den haengenden Client vollstaendig ab', async () => {
    const { ada, bob, workspace, board } = await teamMitBoard(app)
    const carl = await signedInAs(app, 'carl')
    await addMember(app, ada, workspace.id, carl)
    const sender = await connect(app, ada)
    const haengt = await connect(app, bob)
    const liest = await connect(app, carl)
    await sender.join(board.id)
    await haengt.join(board.id)
    await liest.join(board.id)

    haengt.pause()
    // Immer dasselbe Element in neuer Version: viel Fanout, aber ein kleiner Raumzustand. Der Rueckstau
    // entsteht am ausgehenden Puffer und nicht daran, dass der Test ein riesiges Board zusammenzeichnet.
    for (let version = 1; version <= RUECKSTAU_NACHRICHTEN; version += 1) {
      sender.send(change(board.id, [grossesElement('breit', version, 40_000)]))
    }

    // Der Raum steht nicht still: der mitlesende Dritte bekommt alles, und der Stand wird persistiert.
    await liest.next('scene-change', (message) => message.elements[0]?.['version'] === RUECKSTAU_NACHRICHTEN)
    const gespeichert = await warteAufElement(pool, board.id, 'breit')
    expect(gespeichert.elements).toHaveLength(1)
    expect(hatEreignis(app, 'realtime.backpressure.deferred')).toBe(true)

    // Kein stiller Verlust: sobald der Puffer abgeflossen ist, kommt der **vollstaendige** Stand nach.
    haengt.resume()
    const abgleich = await haengt.next(
      'snapshot',
      (message) => message.scene.elements[0]?.['version'] === RUECKSTAU_NACHRICHTEN,
    )
    expect(abgleich.scene.elements).toHaveLength(1)
  })
})

describe('Backpressure als letztes Mittel', () => {
  let app: TestApp

  beforeAll(async () => {
        // Dieselbe Leiter wie im Betrieb, nur enger: verwerfen ab 8 KiB, trennen ab 16 KiB. Ein einzelner
    // Rahmen dieses Tests ist groesser als die Trennschwelle, der Rueckstau springt also unmittelbar in die
    // letzte Stufe - genau der Fall "der Client liest gar nicht mehr".
    app = await starteApp({ rooms: { presenceDropBytes: 4_096, changeDropBytes: 8_192, slowCloseBytes: 16_384 } })
  })

  it('trennt einen Client, der gar nicht mehr liest, und laesst den Raum weiterlaufen', async () => {
    const { ada, bob, board } = await teamMitBoard(app)
    const sender = await connect(app, ada)
    const haengt = await connect(app, bob)
    await sender.join(board.id)
    await haengt.join(board.id)
    await sender.next('presence', (message) => message.peers.length === 2)

    haengt.pause()
    for (let version = 1; version <= RUECKSTAU_NACHRICHTEN; version += 1) {
      sender.send(change(board.id, [grossesElement('breit', version, 40_000)]))
    }

    // Der Raum verliert den haengenden Teilnehmer sofort - ohne auf den Abschluss des Schliessens zu warten.
    const nachher = await sender.next('presence', (message) => message.peers.length === 1)
    expect(nachher.peers.map((peer) => peer.displayName)).toEqual(['ada'])
    expect(hatEreignis(app, 'realtime.backpressure.closed')).toBe(true)
    const gespeichert = await warteAufElement(pool, board.id, 'breit')
    expect(gespeichert.elements).toHaveLength(1)

    // Der Schliessgrund ist benannt: der Browser weiss, dass ein neuer Aufbau sinnvoll ist.
    haengt.resume()
    expect(await haengt.closeCode).toBe(SLOW_CLIENT_CLOSE_CODE)
  })
})
