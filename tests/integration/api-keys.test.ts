/** API keys against a real PostgreSQL instance: store level plus the admin endpoints. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  BOARDS_PATH,
  ME_API_KEY_CREATE_PATH,
  ME_API_KEY_REVOKE_PATH,
  ME_API_KEYS_PATH,
  WORKSPACES_PATH,
  ADMIN_API_KEY_REVOKE_PATH,
  ADMIN_API_KEYS_PATH,
  ADMIN_USER_API_ACCESS_PATH,
  ADMIN_USER_CREATE_PATH,
  ADMIN_USER_STATUS_PATH,
  ADMIN_USERS_PATH,
} from '../../src/contracts/api.js'
import type {
  AdminApiKeysResponse,
  AdminUsersResponse,
  BoardView,
  CreateApiKeyResponse,
  CreateUserResponse,
  OwnApiKeysResponse,
  WorkspaceView,
} from '../../src/contracts/api.js'
import { displayPrefixOf } from '../../src/domain/identity/api-key.js'
import type { ApiKeyAccess, ApiKeyTarget } from '../../src/domain/identity/api-key.js'
import type { IdentityStore } from '../../src/domain/identity/repositories.js'
import { createIdentityStore } from '../../src/persistence/identity-store.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { createApiKeyValue, hashApiKeyValue } from '../../src/server/api-key-secret.js'
import { createJar } from '../support/browser-client.js'
import { TEST_PASSWORD, changePassword, postWithCsrf, profileOf, signedInAsSystemAdmin } from '../support/local-accounts.js'
import type { Account } from '../support/local-accounts.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

const DAY = 24 * 60 * 60 * 1000

let pool: Pool
let store: IdentityStore
let app: TestApp

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  await migrate(pool)
  store = createIdentityStore(pool)
  app = await startTestApp({ pool, databaseUrl: DATABASE_URL })
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces, login_throttle, user_audit_events cascade')
  app.clearLogs()
})

async function workspaceTarget(): Promise<ApiKeyTarget> {
  const result = await pool.query<{ id: string }>(
    `insert into workspaces (name) values ('W') returning id`,
  )
  return { kind: 'workspace', workspaceId: result.rows[0]!.id }
}

async function anlegen(
  userId: string,
  target: ApiKeyTarget,
  options: { level?: 'read' | 'edit'; expiresAt?: Date } = {},
) {
  const value = createApiKeyValue()
  const key = await store.apiKeys.create({
    userId,
    name: 'CI',
    target,
    level: options.level ?? 'edit',
    expiresAt: options.expiresAt ?? new Date(Date.now() + 30 * DAY),
    prefix: displayPrefixOf(value),
    keyHash: hashApiKeyValue(value),
  })
  return { key, value }
}

async function fixture(access?: ApiKeyAccess) {
  const user = await store.users.create({ displayName: 'Ada', email: null }, { isSystemAdmin: false })
  const target = await workspaceTarget()
  if (access !== undefined) {
    await store.apiKeys.setAccess(user.id, access)
  }
  return { user, target }
}

describe('Freigabe', () => {
  it('steht fuer neue Nutzer standardmaessig auf aus', async () => {
    const { user } = await fixture()
    expect(await store.apiKeys.getAccess(user.id)).toBe('off')
  })

  it('setzt und ueberschreibt die Stufe', async () => {
    const { user } = await fixture('edit')
    expect(await store.apiKeys.getAccess(user.id)).toBe('edit')
    await store.apiKeys.setAccess(user.id, 'read')
    expect(await store.apiKeys.getAccess(user.id)).toBe('read')
  })
})

describe('Aufloesung', () => {
  it('loest einen Key mit wirksamer Stufe und Subjekt ohne Admin-Hochstufung auf', async () => {
    const admin = await store.users.create({ displayName: 'Root', email: null }, { isSystemAdmin: true })
    await store.apiKeys.setAccess(admin.id, 'edit')
    const { value } = await anlegen(admin.id, await workspaceTarget())

    const resolved = await store.apiKeys.resolveByHash(hashApiKeyValue(value), new Date())

    expect(resolved?.level).toBe('edit')
    expect(resolved?.subject.isSystemAdmin).toBe(false)
  })

  it('wirkt bei Herabstufung der Freigabe sofort, bei Freigabe aus ungueltig', async () => {
    const { user, target } = await fixture('edit')
    const { value } = await anlegen(user.id, target, { level: 'edit' })
    const hash = hashApiKeyValue(value)

    await store.apiKeys.setAccess(user.id, 'read')
    expect((await store.apiKeys.resolveByHash(hash, new Date()))?.level).toBe('read')

    await store.apiKeys.setAccess(user.id, 'off')
    expect(await store.apiKeys.resolveByHash(hash, new Date())).toBeNull()
  })

  it('lehnt unbekannte, abgelaufene und widerrufene Keys ab', async () => {
    const { user, target } = await fixture('edit')
    const gueltig = await anlegen(user.id, target)
    const abgelaufen = await anlegen(user.id, target, { expiresAt: new Date(Date.now() + 1000) })
    const widerrufen = await anlegen(user.id, target)
    await store.apiKeys.revoke(widerrufen.key.id, new Date())
    const spaeter = new Date(Date.now() + 60_000)

    expect(await store.apiKeys.resolveByHash(hashApiKeyValue(createApiKeyValue()), new Date())).toBeNull()
    expect(await store.apiKeys.resolveByHash(hashApiKeyValue(gueltig.value), spaeter)).not.toBeNull()
    expect(await store.apiKeys.resolveByHash(hashApiKeyValue(abgelaufen.value), spaeter)).toBeNull()
    expect(await store.apiKeys.resolveByHash(hashApiKeyValue(widerrufen.value), new Date())).toBeNull()
  })

  it('lehnt Keys eines deaktivierten Nutzers ab', async () => {
    const { user, target } = await fixture('edit')
    const { value } = await anlegen(user.id, target)
    await store.users.setStatus(user.id, 'deactivated')

    expect(await store.apiKeys.resolveByHash(hashApiKeyValue(value), new Date())).toBeNull()
  })
})

describe('Verwaltung', () => {
  it('zaehlt aktive Keys, widerruft einzeln und je Nutzer, setzt last_used_at', async () => {
    const { user, target } = await fixture('edit')
    const a = await anlegen(user.id, target)
    await anlegen(user.id, target)
    await anlegen(user.id, target, { expiresAt: new Date(Date.now() + 1000) })
    const spaeter = new Date(Date.now() + 60_000)

    expect(await store.apiKeys.countActive(user.id, spaeter)).toBe(2)
    expect(await store.apiKeys.revoke(a.key.id, new Date())).toBe(true)
    expect(await store.apiKeys.revoke(a.key.id, new Date())).toBe(false)
    expect(await store.apiKeys.countActive(user.id, spaeter)).toBe(1)

    await store.apiKeys.markUsed(a.key.id, spaeter)
    expect((await store.apiKeys.listForUser(user.id)).find((key) => key.id === a.key.id)?.lastUsedAt).toEqual(spaeter)

    expect(await store.transaction((tx) => tx.apiKeys.revokeAllForUser(user.id, new Date()))).toBe(2)
    expect(await store.apiKeys.countActive(user.id, spaeter)).toBe(0)
  })

  it('listet alle Keys mit Nutzerangaben', async () => {
    const { user, target } = await fixture('edit')
    await anlegen(user.id, target)

    const alle = await store.apiKeys.listAll()

    expect(alle).toHaveLength(1)
    expect(alle[0]?.user.displayName).toBe('Ada')
  })

  it('schreibt nutzerbezogene Auditereignisse ohne Workspace', async () => {
    const { user } = await fixture()
    await store.userAudit.record({
      actorId: user.id,
      action: 'api-key.access-changed',
      targetType: 'user',
      targetId: user.id,
      subjectUserId: user.id,
      details: { from: 'off', to: 'read' },
    })
    const count = await pool.query('select 1 from user_audit_events')
    expect(count.rowCount).toBe(1)
  })
})

describe('Datenbankregeln', () => {
  it('weist einen Klartextwert als Hash ab', async () => {
    const { user, target } = await fixture('edit')
    const value = createApiKeyValue()

    await expect(
      store.apiKeys.create({
        userId: user.id,
        name: 'CI',
        target,
        level: 'read',
        expiresAt: new Date(Date.now() + DAY),
        prefix: displayPrefixOf(value),
        keyHash: value,
      }),
    ).rejects.toThrow(/api_keys_key_hash_format/)
  })

  it('verlangt genau ein Ziel', async () => {
    const { user } = await fixture()
    await expect(
      pool.query(
        `insert into api_keys (user_id, name, level, expires_at, key_prefix, key_hash)
         values ($1, 'x', 'read', now() + interval '1 day', 'cvz_abcd', repeat('a', 64))`,
        [user.id],
      ),
    ).rejects.toThrow(/api_keys_exactly_one_target/)
  })
})

async function createMember(admin: Account, email: string): Promise<Account & { readonly id: string }> {
  const created = (await (
    await postWithCsrf(app, admin.jar, ADMIN_USER_CREATE_PATH, {
      displayName: 'Ada',
      email,
      initialPassword: TEST_PASSWORD,
    })
  ).json()) as CreateUserResponse
  const jar = createJar()
  const changed = await changePassword(app, jar, {
    email,
    currentPassword: TEST_PASSWORD,
    newPassword: 'eigenes-passwort-4711-lang',
  })
  expect(changed.status).toBe(200)
  return { jar, profile: await profileOf(app, jar), id: created.user.id }
}

describe('Administration', () => {
  let admin: Account

  beforeEach(async () => {
    admin = await signedInAsSystemAdmin(app)
  })

  function member(email: string): Promise<Account & { readonly id: string }> {
    return createMember(admin, email)
  }

  async function accessOf(userId: string): Promise<string | undefined> {
    const response = await admin.jar.fetch(`${app.baseUrl}${ADMIN_USERS_PATH}`)
    return ((await response.json()) as AdminUsersResponse).users.find((user) => user.id === userId)?.apiKeyAccess
  }

  async function keyFor(userId: string) {
    const value = createApiKeyValue()
    const key = await app.store.apiKeys.create({
      userId,
      name: 'CI',
      target: await workspaceTarget(),
      level: 'edit',
      expiresAt: new Date(Date.now() + 30 * DAY),
      prefix: displayPrefixOf(value),
      keyHash: hashApiKeyValue(value),
    })
    return { key, value, hash: hashApiKeyValue(value) }
  }

  async function auditActions(): Promise<{ action: string; details: unknown }[]> {
    const result = await pool.query<{ action: string; details: unknown }>(
      'select action, details from user_audit_events order by occurred_at',
    )
    return result.rows
  }

  it('zeigt die Freigabe standardmaessig als aus und setzt sie mit Nachweis', async () => {
    const ada = await member('ada@example.com')
    expect(await accessOf(ada.id)).toBe('off')

    const response = await postWithCsrf(app, admin.jar, ADMIN_USER_API_ACCESS_PATH, { userId: ada.id, access: 'edit' })

    expect(response.status).toBe(200)
    expect(await accessOf(ada.id)).toBe('edit')
    expect(await auditActions()).toEqual([{ action: 'api-key.access-changed', details: { from: 'off', to: 'edit' } }])
  })

  it('weist unbekannte Nutzer und Stufen ab', async () => {
    const ada = await member('ada@example.com')

    const unbekannt = await postWithCsrf(app, admin.jar, ADMIN_USER_API_ACCESS_PATH, {
      userId: '00000000-0000-0000-0000-000000000000',
      access: 'read',
    })
    const ungueltig = await postWithCsrf(app, admin.jar, ADMIN_USER_API_ACCESS_PATH, { userId: ada.id, access: 'owner' })

    expect(unbekannt.status).toBe(404)
    expect(ungueltig.status).toBe(400)
    expect(await auditActions()).toEqual([])
  })

  it('verweigert Nutzern ohne Systemadmin jede Key-Verwaltung', async () => {
    const ada = await member('ada@example.com')
    const { key } = await keyFor(ada.id)

    const responses = [
      await postWithCsrf(app, ada.jar, ADMIN_USER_API_ACCESS_PATH, { userId: ada.id, access: 'edit' }),
      await postWithCsrf(app, ada.jar, ADMIN_API_KEY_REVOKE_PATH, { keyId: key.id }),
      await ada.jar.fetch(`${app.baseUrl}${ADMIN_API_KEYS_PATH}`),
    ]

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403])
    expect(await accessOf(ada.id)).toBe('off')
    expect((await app.store.apiKeys.listForUser(ada.id))[0]?.revokedAt).toBeNull()
  })

  it('widerruft einen Key durch den Admin mit Nachweis und ohne Wert oder Hash in Antwort, Nachweis und Protokoll', async () => {
    const ada = await member('ada@example.com')
    await app.store.apiKeys.setAccess(ada.id, 'edit')
    const { key, value, hash } = await keyFor(ada.id)
    expect((await app.store.apiKeys.resolveByHash(hash, new Date()))?.level).toBe('edit')

    const listed = await (await admin.jar.fetch(`${app.baseUrl}${ADMIN_API_KEYS_PATH}`)).text()
    const revoked = await postWithCsrf(app, admin.jar, ADMIN_API_KEY_REVOKE_PATH, { keyId: key.id })
    const unbekannt = await postWithCsrf(app, admin.jar, ADMIN_API_KEY_REVOKE_PATH, {
      keyId: '00000000-0000-0000-0000-000000000000',
    })

    expect((JSON.parse(listed) as AdminApiKeysResponse).keys[0]).toMatchObject({ userDisplayName: 'Ada', state: 'active' })
    expect(revoked.status).toBe(200)
    expect(unbekannt.status).toBe(404)
    expect(await app.store.apiKeys.resolveByHash(hash, new Date())).toBeNull()
    const after = (await (await admin.jar.fetch(`${app.baseUrl}${ADMIN_API_KEYS_PATH}`)).json()) as AdminApiKeysResponse
    expect(after.keys[0]?.state).toBe('revoked')
    expect(await auditActions()).toEqual([{ action: 'api-key.revoked', details: { name: 'CI', by: 'admin' } }])
    const everything = JSON.stringify([listed, await auditActions(), app.logs])
    expect(everything).not.toContain(value)
    expect(everything).not.toContain(hash)
  })

  it('widerruft bei Deaktivierung alle Keys des Nutzers', async () => {
    const ada = await member('ada@example.com')
    await app.store.apiKeys.setAccess(ada.id, 'edit')
    const first = await keyFor(ada.id)
    const second = await keyFor(ada.id)

    const response = await postWithCsrf(app, admin.jar, ADMIN_USER_STATUS_PATH, { userId: ada.id, status: 'deactivated' })

    expect(response.status).toBe(200)
    expect((await app.store.apiKeys.listForUser(ada.id)).every((key) => key.revokedAt !== null)).toBe(true)
    expect(await app.store.apiKeys.resolveByHash(first.hash, new Date())).toBeNull()
    expect(await app.store.apiKeys.resolveByHash(second.hash, new Date())).toBeNull()
  })
})

describe('Eigene Keys', () => {
  const FREMD = '00000000-0000-0000-0000-000000000000'
  let admin: Account
  let ada: Account & { readonly id: string }
  let workspace: WorkspaceView
  let board: BoardView

  beforeEach(async () => {
    admin = await signedInAsSystemAdmin(app)
    ada = await createMember(admin, 'ada@example.com')
    await store.apiKeys.setAccess(ada.id, 'edit')
    workspace = (await (await postWithCsrf(app, ada.jar, WORKSPACES_PATH, { name: 'Team' })).json()) as WorkspaceView
    board = (await (
      await postWithCsrf(app, ada.jar, BOARDS_PATH, { workspaceId: workspace.id, title: 'Skizze' })
    ).json()) as BoardView
  })

  afterEach(() => {
    app.setNow(null)
  })

  function create(account: Account, body: Record<string, unknown> = {}): Promise<Response> {
    return postWithCsrf(app, account.jar, ME_API_KEY_CREATE_PATH, {
      name: 'CI',
      target: { kind: 'workspace', id: workspace.id },
      level: 'edit',
      ...body,
    })
  }

  async function auditText(): Promise<string> {
    return JSON.stringify((await pool.query('select * from user_audit_events')).rows)
  }

  it('zeigt den Wert genau einmal; die Liste nennt ihn nie', async () => {
    const response = await create(ada, { target: { kind: 'board', id: board.id }, level: 'read', lifetimeDays: 30 })
    const created = (await response.json()) as CreateApiKeyResponse
    const listed = await (await ada.jar.fetch(`${app.baseUrl}${ME_API_KEYS_PATH}`)).text()

    expect(response.status).toBe(201)
    expect(created.value).toMatch(/^cvz_/)
    expect(listed).not.toContain(created.value)
    expect((JSON.parse(listed) as OwnApiKeysResponse).keys[0]).toMatchObject({
      name: 'CI',
      level: 'read',
      state: 'active',
      target: { kind: 'board', id: board.id, name: 'Skizze' },
    })
    expect((await app.store.apiKeys.resolveByHash(hashApiKeyValue(created.value), new Date()))?.level).toBe('read')
  })

  it('haelt den Wert aus Datenbank, Nachweis und Protokoll heraus', async () => {
    const { value } = (await (await create(ada)).json()) as CreateApiKeyResponse

    const stored = JSON.stringify((await pool.query('select * from api_keys')).rows)
    expect(stored).not.toContain(value)
    expect(stored).toContain(hashApiKeyValue(value))
    expect(await auditText()).toContain('api-key.created')
    expect(JSON.stringify([await auditText(), app.logs])).not.toContain(value)
  })

  it('lehnt ohne Freigabe alle Endpunkte mit 403 ab', async () => {
    await store.apiKeys.setAccess(ada.id, 'off')

    const responses = [
      await create(ada),
      await postWithCsrf(app, ada.jar, ME_API_KEY_REVOKE_PATH, { keyId: FREMD }),
      await ada.jar.fetch(`${app.baseUrl}${ME_API_KEYS_PATH}`),
    ]

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403])
    expect((await ada.jar.fetch(`${app.baseUrl}/api/me`).then((response) => response.json())).apiKeyAccess).toBe('off')
  })

  it('weist eine Stufe ueber der Freigabe ab', async () => {
    await store.apiKeys.setAccess(ada.id, 'read')

    expect((await create(ada, { level: 'edit' })).status).toBe(403)
    expect((await create(ada, { level: 'read' })).status).toBe(201)
  })

  it('verlangt eine Sitzung von hoechstens zehn Minuten mit eigenem Fehlercode', async () => {
    app.setNow(new Date(Date.now() + 11 * 60_000))

    const response = await create(ada)

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'fresh-login-required' })
    expect(await store.apiKeys.listForUser(ada.id)).toEqual([])
  })

  it('behandelt ein unsichtbares Ziel wie eine erfundene Kennung, auch fuer den Systemadmin', async () => {
    await store.apiKeys.setAccess(admin.profile.user.id, 'edit')

    const erfunden = await create(ada, { target: { kind: 'workspace', id: FREMD } })
    const ohneUuid = await create(ada, { target: { kind: 'board', id: 'nein' } })
    const adminOhneMitgliedschaft = await create(admin)
    const adminBoard = await create(admin, { target: { kind: 'board', id: board.id } })

    expect(erfunden.status).toBe(404)
    for (const response of [ohneUuid, adminOhneMitgliedschaft, adminBoard]) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual(await erfunden.clone().json())
    }
  })

  it('begrenzt aktive Keys auf 25', async () => {
    for (let index = 0; index < 25; index += 1) {
      await anlegen(ada.id, { kind: 'workspace', workspaceId: workspace.id })
    }

    expect((await create(ada)).status).toBe(409)
    expect(await store.apiKeys.countActive(ada.id, new Date())).toBe(25)
  })

  it('widerruft nur eigene Keys sofort und mit Nachweis', async () => {
    const { key, value } = (await (await create(ada)).json()) as CreateApiKeyResponse
    const bob = await createMember(admin, 'bob@example.com')
    await store.apiKeys.setAccess(bob.id, 'edit')

    const fremd = await postWithCsrf(app, bob.jar, ME_API_KEY_REVOKE_PATH, { keyId: key.id })
    const eigen = await postWithCsrf(app, ada.jar, ME_API_KEY_REVOKE_PATH, { keyId: key.id })

    expect(fremd.status).toBe(404)
    expect(eigen.status).toBe(200)
    expect(await store.apiKeys.resolveByHash(hashApiKeyValue(value), new Date())).toBeNull()
    expect((await store.apiKeys.listForUser(ada.id))[0]?.revokedAt).not.toBeNull()
    expect(await auditText()).toContain('api-key.revoked')
  })
})
