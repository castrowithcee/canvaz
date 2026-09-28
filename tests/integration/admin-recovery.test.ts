/**
 * Wiederherstellung des Systemadminzugangs per Betreiberbefehl - gegen die echte Anwendung und eine echte
 * Datenbank.
 *
 * Der Befehl ist `recoverSystemAdmin`, genau die Funktion, die `admin-recover-cli.ts` auf dem Host aufruft.
 * Eingeloest wird ueber den echten Endpunkt mit echtem Cookie.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { CSRF_HEADER, ME_PATH, RECOVERY_APP_PATH, WORKSPACES_PATH } from '../../src/contracts/api.js'
import type { WorkspaceView, WorkspacesResponse } from '../../src/contracts/api.js'
import { RECOVERY_TTL_MINUTES } from '../../src/domain/identity/local-auth.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { recoverSystemAdmin } from '../../src/server/admin-recovery.js'
import { createInvitationToken, hashInvitationToken, recoveryUrl } from '../../src/server/invitations.js'
import { takeLoginAttempt } from '../../src/server/login-throttle.js'
import { createJar } from '../support/browser-client.js'
import type { Jar } from '../support/browser-client.js'
import {
  completeSecondFactorSetup,
  localLogin,
  profileOf,
  redeemInvitation,
  signedInAsSystemAdmin,
} from '../support/local-accounts.js'
import { openRealtime } from '../support/realtime-socket.js'
import { TEST_SESSION_SECRET, startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

const NEUES_PASSWORT = 'wiederhergestellt-4711'

let pool: Pool
let app: TestApp

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  await migrate(pool)
  app = await startTestApp({ pool, databaseUrl: DATABASE_URL })
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces, login_throttle cascade')
  app.clearLogs()
  app.setNow(null)
})

async function recover(): Promise<string> {
  const result = await recoverSystemAdmin(app.store, {
    now: app.context.now(),
    sessionSecret: app.context.config.sessionSecret,
  })
  expect(result.kind).toBe('issued')
  return result.kind === 'issued' ? result.token : ''
}

function me(jar: Jar): Promise<Response> {
  return jar.fetch(`${app.baseUrl}${ME_PATH}`)
}

/** Zeilen, an denen ein fehlerhafter Abbruch etwas geaendert haette. */
async function snapshot(): Promise<unknown> {
  const result = await pool.query(
    `select (select count(*)::int from user_invitations) as invitations,
            (select count(*)::int from user_invitations where revoked_at is not null) as revoked_invitations,
            (select count(*)::int from sessions where revoked_at is not null) as revoked_sessions`,
  )
  return result.rows[0]
}

describe('Betreiberbefehl ohne eindeutigen Systemadmin', () => {
  it('bricht ohne Systemadmin ohne jede Aenderung ab', async () => {
    const vorher = await snapshot()
    expect(await recoverSystemAdmin(app.store, { now: new Date(), sessionSecret: TEST_SESSION_SECRET })).toEqual({ kind: 'no-admin' })
    expect(await snapshot()).toEqual(vorher)
  })

  it('bricht bei mehreren Systemadmins ohne jede Aenderung ab', async () => {
    const admin = await signedInAsSystemAdmin(app)
    // Ueber die Anwendung entsteht kein zweiter Systemadmin; der Fall ist nur per Datenbank herstellbar.
    await app.store.users.create({ displayName: 'Zweiter', email: 'zweiter@example.com' }, { isSystemAdmin: true })
    const vorher = await snapshot()

    expect(await recoverSystemAdmin(app.store, { now: new Date(), sessionSecret: TEST_SESSION_SECRET })).toEqual({ kind: 'ambiguous', count: 2 })
    expect(await snapshot()).toEqual(vorher)
    expect((await me(admin.jar)).status).toBe(200)
  })
})

describe('Betreiberbefehl mit genau einem Systemadmin', () => {
  it('widerruft Sitzungen, Verbindungen und Einladungen und speichert nur den Hash', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const socket = await openRealtime(app.baseUrl, admin.jar.cookieHeader())
    const alteEinladung = createInvitationToken()
    await app.store.invitations.create({
      userId: admin.profile.user.id,
      tokenHash: hashInvitationToken(alteEinladung),
      createdByUserId: null,
      expiresAt: new Date(Date.now() + 3600_000),
    })

    const token = await recover()

    expect((await me(admin.jar)).status).toBe(401)
    // Der Widerruf kommt aus einem anderen Vorgang als der Verbindung; die Nachpruefung beendet sie trotzdem.
    expect(await socket.closeCode).toBeGreaterThan(0)
    expect((await redeemInvitation(app, createJar(), alteEinladung, NEUES_PASSWORT)).status).toBe(400)
    expect(recoveryUrl(app.baseUrl, token)).toBe(`${app.baseUrl}${RECOVERY_APP_PATH}#${token}`)

    const offen = await pool.query<{ token_hash: string; purpose: string; created_by_user_id: string | null }>(
      'select token_hash, purpose, created_by_user_id from user_invitations where revoked_at is null and redeemed_at is null',
    )
    expect(offen.rows).toEqual([{ token_hash: hashInvitationToken(token), purpose: 'recovery', created_by_user_id: null }])
    const klartext = await pool.query("select 1 from user_invitations u where u::text like '%' || $1 || '%'", [token])
    expect(klartext.rowCount).toBe(0)
  })

  it('loest genau einmal ein und laesst Rolle und Mitgliedschaften unveraendert', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const angelegt = await admin.jar.fetch(`${app.baseUrl}${WORKSPACES_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: admin.profile.csrfToken },
      body: JSON.stringify({ name: 'Betrieb' }),
    })
    expect(angelegt.status).toBe(201)
    const workspace = (await angelegt.json()) as WorkspaceView
    const token = await recover()

    const jar = createJar()
    expect((await redeemInvitation(app, jar, token, NEUES_PASSWORT)).status).toBe(200)
    expect((await redeemInvitation(app, createJar(), token, 'noch-ein-passwort-1')).status).toBe(400)

    const profil = await profileOf(app, jar)
    expect(profil.user).toEqual(admin.profile.user)
    // Die Einloesung hat den zweiten Faktor entfernt: erst die Neueinrichtung gibt die Sitzung frei.
    expect(profil.secondFactor).toEqual({ state: 'setup-required' })
    await completeSecondFactorSetup(app, jar)
    const liste = (await (await jar.fetch(`${app.baseUrl}${WORKSPACES_PATH}`)).json()) as WorkspacesResponse
    expect(liste.workspaces.map((entry) => [entry.id, entry.role])).toEqual([[workspace.id, 'owner']])
    expect((await localLogin(app, createJar(), 'root@example.com', NEUES_PASSWORT)).status).toBe(200)
    expect(app.logs).toContainEqual(
      expect.objectContaining({ event: 'auth.invitation.redeemed', fields: expect.objectContaining({ purpose: 'recovery' }) }),
    )
    expect(JSON.stringify(app.logs)).not.toContain(token)
  })

  it('hebt mit Befehl und Einloesung eine Drosselung des Kontos auf', async () => {
    await signedInAsSystemAdmin(app)
    const eng = { ...app.context.config, authAccountAttempts: 3 }
    const drosseln = async (): Promise<boolean> => {
      let erlaubt = true
      for (let versuch = 0; versuch < 4; versuch += 1) {
        erlaubt = await takeLoginAttempt(app.store, eng, 'root@example.com', new Date())
      }
      return erlaubt
    }

    expect(await drosseln()).toBe(false)
    const token = await recover()
    expect(await takeLoginAttempt(app.store, eng, 'root@example.com', new Date())).toBe(true)

    expect(await drosseln()).toBe(false)
    expect((await redeemInvitation(app, createJar(), token, NEUES_PASSWORT)).status).toBe(200)
    expect(await takeLoginAttempt(app.store, eng, 'root@example.com', new Date())).toBe(true)
  })

  it('wirkt abgelaufen nicht mehr', async () => {
    await signedInAsSystemAdmin(app)
    const token = await recover()
    app.setNow(new Date(Date.now() + (RECOVERY_TTL_MINUTES + 1) * 60_000))
    expect((await redeemInvitation(app, createJar(), token, NEUES_PASSWORT)).status).toBe(400)
  })

  it('ergibt auch bei gleichzeitigen Aufrufen genau einen gueltigen Wert', async () => {
    await signedInAsSystemAdmin(app)
    const [erster, zweiter] = await Promise.all([recover(), recover()])

    const ergebnisse = [
      (await redeemInvitation(app, createJar(), erster, NEUES_PASSWORT)).status,
      (await redeemInvitation(app, createJar(), zweiter, NEUES_PASSWORT)).status,
    ]
    expect(ergebnisse.sort()).toEqual([200, 400])
  })
})
