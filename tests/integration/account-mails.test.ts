/**
 * Die zwei Nachrichten, die eine Instanz mit Postausgang verschickt.
 *
 * Geprueft wird an der echten Anwendung mit echter Datenbank: was die Adminroute anstoesst, landet als
 * Nachricht am Port - Empfaenger, Betreff und Inhalt. Welcher Server dahintersteht, ist hier ohne Belang;
 * der Test kennt keinen SMTP-Server und keinen Auffangdienst, sondern nur den Port der Anwendung.
 *
 * Zwei Zusagen tragen den Test:
 *
 * - Eine Einladung geht an die Adresse des Kontos und traegt genau den Link, der auch in der Antwort steht.
 * - Eine Ruecksetzung meldet sich, nennt das neue Passwort aber nicht.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  ADMIN_USER_CREATE_PATH,
  BOARD_SHARE_LINKS_PATH,
  BOARD_SHARE_LINK_CREATE_PATH,
  BOARD_SHARE_LINK_REPLACE_PATH,
  BOARD_ID_PARAM,
  ADMIN_USER_INVITATION_PATH,
  ADMIN_USER_PASSWORD_PATH,
  CSRF_HEADER,
} from '../../src/contracts/api.js'
import type {
  BoardShareLinksResponse,
  CreateBoardShareLinkResponse,
  CreateInvitationResponse,
  CreateUserResponse,
} from '../../src/contracts/api.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { createBoard, createWorkspace } from '../support/board-fixture.js'
import { signedInAsSystemAdmin } from '../support/local-accounts.js'
import type { Account } from '../support/local-accounts.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

const NEUES_PASSWORT = 'ruecksetzung-4711-lang-genug'

let pool: Pool
let app: TestApp
let admin: Account

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  try {
    await pool.query('select 1')
  } catch (error) {
    throw new Error(`Keine Testdatenbank unter ${DATABASE_URL}. Zuerst "npm run db:up" ausfuehren.`, { cause: error })
  }
  await migrate(pool)
  // Ein Postausgang gehoert zur Konfiguration dieser Instanz. Die Werte sind erfunden: der Test verschickt
  // nichts nach draussen, er sammelt am Port.
  app = await startTestApp({
    pool,
    databaseUrl: DATABASE_URL,
    env: { CANVAZ_SMTP_HOST: 'postausgang.invalid', CANVAZ_MAIL_FROM: 'canvaz@example.com' },
  })
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
  app.clearMails()
  admin = await signedInAsSystemAdmin(app)
  app.clearMails()
})

function adminPost(path: string, body: unknown): Promise<Response> {
  return admin.jar.fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: admin.profile.csrfToken },
    body: JSON.stringify(body),
  })
}

describe('Instanz mit Postausgang', () => {
  it('schickt die Einladung an das angelegte Konto und traegt denselben Link wie die Antwort', async () => {
    const response = await adminPost(ADMIN_USER_CREATE_PATH, {
      displayName: 'Neue Person',
      email: 'neu@example.com',
    })
    expect(response.status).toBe(201)
    const created = (await response.json()) as CreateUserResponse

    expect(app.mails).toHaveLength(1)
    const mail = app.mails[0]
    expect(mail?.to).toBe('neu@example.com')
    expect(mail?.text).toContain(created.invitationUrl)
  })

  it('schickt eine erneuerte Einladung mit dem neuen Link', async () => {
    const created = (await (
      await adminPost(ADMIN_USER_CREATE_PATH, { displayName: 'Zweite Person', email: 'zwei@example.com' })
    ).json()) as CreateUserResponse
    app.clearMails()

    const erneuert = (await (
      await adminPost(ADMIN_USER_INVITATION_PATH, { userId: created.user.id })
    ).json()) as CreateInvitationResponse

    expect(app.mails).toHaveLength(1)
    expect(app.mails[0]?.text).toContain(erneuert.invitationUrl)
    // Der alte Link ist mit der Erneuerung widerrufen und darf in keiner Nachricht mehr stehen.
    expect(app.mails[0]?.text).not.toContain(created.invitationUrl)
  })

  it('meldet eine Ruecksetzung, ohne das neue Passwort zu nennen', async () => {
    const created = (await (
      await adminPost(ADMIN_USER_CREATE_PATH, {
        displayName: 'Dritte Person',
        email: 'drei@example.com',
        initialPassword: 'erstes-passwort-1234',
      })
    ).json()) as CreateUserResponse
    app.clearMails()

    const response = await adminPost(ADMIN_USER_PASSWORD_PATH, {
      userId: created.user.id,
      password: NEUES_PASSWORT,
    })
    expect(response.status).toBe(200)

    expect(app.mails).toHaveLength(1)
    expect(app.mails[0]?.to).toBe('drei@example.com')
    expect(app.mails[0]?.text).not.toContain(NEUES_PASSWORT)
  })
})

describe('Gastlink per E-Mail', () => {
  it('sendet den Link an beide Empfaenger, ohne Adresse oder Link in Log und Audit, und begrenzt je Nutzer', async () => {
    const workspace = await createWorkspace(app, admin, 'Team Nord')
    const board = await createBoard(app, admin, workspace.id, 'Skizze')
    // Earlier account mails of this file log their own recipients; only this request matters here.
    app.clearLogs()

    const response = await adminPost(BOARD_SHARE_LINK_CREATE_PATH, {
      boardId: board.id,
      recipients: ['eins@example.com', 'zwei@example.com', 'EINS@example.com'],
    })
    expect(response.status).toBe(201)
    const created = (await response.json()) as CreateBoardShareLinkResponse
    expect(created.mails).toEqual({ sent: 2, failed: 0 })
    expect(app.mails.map((mail) => mail.to).sort()).toEqual(['eins@example.com', 'zwei@example.com'])
    expect(app.mails[0]?.text).toContain(created.url)
    expect(app.mails[0]?.text).toContain('Skizze')

    const token = new URL(created.url).hash.slice(1)
    const audit = JSON.stringify(await app.workspaces.audit.listForWorkspace(workspace.id))
    const logs = JSON.stringify(app.logs)
    for (const geheim of ['eins@example.com', 'zwei@example.com', token]) {
      expect(audit).not.toContain(geheim)
      expect(logs).not.toContain(geheim)
    }
    expect(audit).toContain('"recipientCount":2')

    const liste = await admin.jar.fetch(`${app.baseUrl}${BOARD_SHARE_LINKS_PATH}?${BOARD_ID_PARAM}=${board.id}`)
    expect(((await liste.json()) as BoardShareLinksResponse).mailAvailable).toBe(true)

    // 2 Mails sind verbraucht, 18 bleiben: neun weitere Anfragen mit zwei Empfaengern fuellen die Grenze.
    for (let i = 0; i < 9; i += 1) {
      const weiter = await adminPost(BOARD_SHARE_LINK_CREATE_PATH, {
        boardId: board.id,
        recipients: ['a@example.com', 'b@example.com'],
      })
      expect(weiter.status).toBe(201)
    }
    const links = async () => (await pool.query('select id from board_share_links where revoked_at is null')).rowCount
    const before = await links()

    const ueber = await adminPost(BOARD_SHARE_LINK_CREATE_PATH, { boardId: board.id, recipients: ['c@example.com'] })
    expect(ueber.status).toBe(429)
    const ersetzt = await adminPost(BOARD_SHARE_LINK_REPLACE_PATH, {
      boardId: board.id,
      shareLinkId: created.link.id,
      recipients: ['c@example.com'],
    })
    expect(ersetzt.status).toBe(429)
    // Weder ein neuer Link noch ein Widerruf, und keine 21. Mail.
    expect(await links()).toBe(before)
    expect(app.mails).toHaveLength(20)
  })
})
