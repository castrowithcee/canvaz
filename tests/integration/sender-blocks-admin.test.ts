/**
 * System administration: blocked senders. Access is system admin only, lifting restarts the count, logs
 * never carry an address.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  ADMIN_SENDER_BLOCK_LIFT_PATH,
  ADMIN_SENDER_BLOCK_PROPOSAL_DECIDE_PATH,
  ADMIN_SENDER_BLOCKS_PATH,
  AUTH_LOCAL_LOGIN_PATH,
} from '../../src/contracts/api.js'
import type { SenderBlocksResponse } from '../../src/contracts/api.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { hashPassword } from '../../src/server/password.js'
import { createJar } from '../support/browser-client.js'
import { TEST_PASSWORD, localLogin, postWithCsrf, signedInAsSystemAdmin } from '../support/local-accounts.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

const THRESHOLD = 3
const SENDER = '198.51.100.40'

let pool: Pool
let app: TestApp

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  await migrate(pool)
  app = await startTestApp({
    pool,
    databaseUrl: DATABASE_URL,
    env: { CANVAZ_LOGIN_BLOCK_THRESHOLD: String(THRESHOLD), CANVAZ_TRUSTED_PROXY: 'true' },
  })
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query(
    'truncate users, workspaces, login_throttle, sender_failure_counter, sender_block, sender_block_proposal cascade',
  )
  app.clearLogs()
})

function failedLogin(): Promise<Response> {
  return fetch(`${app.baseUrl}${AUTH_LOCAL_LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': SENDER },
    body: JSON.stringify({ email: 'niemand@example.com', password: 'falsches-passwort-x' }),
  })
}

/** Blocks SENDER, with the instance seeing real client addresses. */
async function blockSender(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    app.context.addressMonitor.record({ address: '203.0.113.200', class: 'public' })
  }
  for (let i = 0; i < THRESHOLD; i += 1) {
    await failedLogin()
  }
  expect((await failedLogin()).status).toBe(429)
}

describe('Gesperrte Absender in der Systemadministration', () => {
  it('lehnt Anonyme und Nicht-Systemadmins auf allen Endpunkten ab', async () => {
    const user = await app.store.users.create(
      { displayName: 'Ada', email: 'ada@example.com' },
      { isSystemAdmin: false },
    )
    await app.store.localCredentials.set(user.id, await hashPassword(TEST_PASSWORD), { mustChangePassword: false })
    const jar = createJar()
    expect((await localLogin(app, jar, 'ada@example.com', TEST_PASSWORD)).status).toBe(200)

    expect((await fetch(`${app.baseUrl}${ADMIN_SENDER_BLOCKS_PATH}`)).status).toBe(401)
    expect((await jar.fetch(`${app.baseUrl}${ADMIN_SENDER_BLOCKS_PATH}`)).status).toBe(403)
    expect((await postWithCsrf(app, jar, ADMIN_SENDER_BLOCK_LIFT_PATH, { address: SENDER })).status).toBe(403)
    const body = { id: '00000000-0000-4000-8000-000000000000', status: 'rejected' }
    expect((await postWithCsrf(app, jar, ADMIN_SENDER_BLOCK_PROPOSAL_DECIDE_PATH, body)).status).toBe(403)
  })

  it('zeigt Sperre und Vorschlag, hebt auf, entscheidet und loggt ohne Adresse', async () => {
    // A frozen clock, stepped: a failure at the very instant of a lift still counts.
    const start = Date.now()
    app.setNow(new Date(start))
    await blockSender()
    const admin = await signedInAsSystemAdmin(app)
    // A second block within the proposal window creates the proposal.
    app.setNow(new Date(start + 1000))
    await app.context.identity.senderDefense.blocks.liftActive(SENDER, app.context.now())
    app.setNow(new Date(start + 2000))
    await blockSender()
    app.setNow(new Date(start + 3000))
    app.clearLogs()

    const listed = (await (await admin.jar.fetch(`${app.baseUrl}${ADMIN_SENDER_BLOCKS_PATH}`)).json()) as SenderBlocksResponse
    expect(listed.blocks.map((block) => block.address)).toEqual([SENDER])
    expect(listed.proposals).toHaveLength(1)

    const lifted = await postWithCsrf(app, admin.jar, ADMIN_SENDER_BLOCK_LIFT_PATH, { address: SENDER })
    expect(lifted.status).toBe(200)
    expect((await postWithCsrf(app, admin.jar, ADMIN_SENDER_BLOCK_LIFT_PATH, { address: SENDER })).status).toBe(404)
    // The count restarted: one more failure does not block again.
    app.setNow(new Date(start + 4000))
    expect((await failedLogin()).status).toBe(401)

    const proposalId = listed.proposals[0]!.id
    const decided = await postWithCsrf(app, admin.jar, ADMIN_SENDER_BLOCK_PROPOSAL_DECIDE_PATH, {
      id: proposalId,
      status: 'accepted',
    })
    expect(decided.status).toBe(200)
    expect((await postWithCsrf(app, admin.jar, ADMIN_SENDER_BLOCK_PROPOSAL_DECIDE_PATH, { id: proposalId, status: 'accepted' })).status).toBe(404)
    const after = (await (await admin.jar.fetch(`${app.baseUrl}${ADMIN_SENDER_BLOCKS_PATH}`)).json()) as SenderBlocksResponse
    expect(after.proposals).toHaveLength(0)

    const events = app.logs.filter((entry) => entry.event.startsWith('admin.sender-block'))
    expect(events.map((entry) => entry.event)).toEqual([
      'admin.sender-block.lifted',
      'admin.sender-block-proposal.decided',
    ])
    expect(JSON.stringify(app.logs)).not.toContain(SENDER)
  })
})
