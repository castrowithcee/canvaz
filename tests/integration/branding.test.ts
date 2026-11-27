/**
 * Instanz-Branding gegen die echte Anwendung, eine echte Datenbank und den Dateisystem-Adapter.
 *
 * Jeder Test geht ueber die echten HTTP-Endpunkte: der Systemadmin meldet sich mit Passwort und zweitem
 * Faktor an, ein normaler Nutzer ueber den OIDC-Fluss.
 */

import { rm } from 'node:fs/promises'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import {
  ADMIN_BRANDING_LOGO_PATH,
  ADMIN_BRANDING_LOGO_REMOVE_PATH,
  ADMIN_BRANDING_PATH,
  BRANDING_LOGO_PATH,
  BRANDING_PATH,
  CSRF_HEADER,
  MAX_BRANDING_LOGO_BYTES,
  ME_PATH,
} from '../../src/contracts/api.js'
import type { AdminBrandingView, MeResponse, PublicBrandingResponse } from '../../src/contracts/api.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { createFilesystemRoot, filesystemEnv } from '../support/asset-storage-env.js'
import { createJar } from '../support/browser-client.js'
import { signedInAsSystemAdmin } from '../support/local-accounts.js'
import type { Account } from '../support/local-accounts.js'
import { login } from '../support/login-flow.js'
import { startTestProvider } from '../support/oidc-provider.js'
import type { TestProvider } from '../support/oidc-provider.js'
import { startTestApp } from '../support/test-app.js'
import type { TestApp } from '../support/test-app.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

let pool: Pool
let provider: TestProvider
let app: TestApp
let root = ''

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  try {
    await pool.query('select 1')
  } catch (error) {
    throw new Error(`Keine Testdatenbank unter ${DATABASE_URL}. Zuerst "npm run db:up" ausfuehren.`, { cause: error })
  }
  await migrate(pool)
  provider = await startTestProvider()
  root = await createFilesystemRoot()
  app = await startTestApp({ provider, pool, databaseUrl: DATABASE_URL, storage: filesystemEnv(root) })
})

afterAll(async () => {
  await app.close()
  await provider.close()
  await pool.end()
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
  await pool.query(
    "update instance_branding set instance_name = '', accent = '', logo_key = null, logo_type = null",
  )
  provider.resetBehaviour()
  app.clearLogs()
})

function png(content: string): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(content)])
}

function postJson(account: Account, path: string, body: unknown): Promise<Response> {
  return account.jar.fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: account.profile.csrfToken },
    body: JSON.stringify(body),
  })
}

function uploadLogo(account: Account, bytes: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
  return account.jar.fetch(`${app.baseUrl}${ADMIN_BRANDING_LOGO_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', [CSRF_HEADER]: account.profile.csrfToken, ...headers },
    body: new Uint8Array(bytes),
  })
}

async function publicBranding(): Promise<PublicBrandingResponse> {
  const response = await fetch(`${app.baseUrl}${BRANDING_PATH}`)
  expect(response.status).toBe(200)
  return (await response.json()) as PublicBrandingResponse
}

async function ordinaryUser(): Promise<Account> {
  const jar = createJar()
  expect((await login(app, jar, { subject: 'ada' })).error).toBeNull()
  const profile = (await (await jar.fetch(`${app.baseUrl}${ME_PATH}`)).json()) as MeResponse
  expect(profile.user.isSystemAdmin).toBe(false)
  return { jar, profile }
}

describe('Branding', () => {
  it('zeigt ohne Pflege den Standard und gibt ohne Anmeldung nur Name, Akzent und Logo preis', async () => {
    expect(await publicBranding()).toEqual({ instanceName: 'Canvaz', accent: null, logoVersion: null })
    expect((await fetch(`${app.baseUrl}${BRANDING_LOGO_PATH}`)).status).toBe(404)
  })

  it('speichert Name, Akzent und PNG und liefert sie ohne Anmeldung aus', async () => {
    const admin = await signedInAsSystemAdmin(app)

    const saved = await postJson(admin, ADMIN_BRANDING_PATH, { instanceName: ' Acme Board ', accent: 'petrol' })
    expect(saved.status).toBe(200)
    const uploaded = await uploadLogo(admin, png('logo-eins'))
    expect(uploaded.status).toBe(200)
    const view = (await uploaded.json()) as AdminBrandingView

    const anonymous = await publicBranding()
    expect(anonymous).toEqual({ instanceName: 'Acme Board', accent: 'petrol', logoVersion: view.logoVersion })
    expect(anonymous.logoVersion).not.toBeNull()

    const logo = await fetch(`${app.baseUrl}${BRANDING_LOGO_PATH}?v=${String(anonymous.logoVersion)}`)
    expect(logo.status).toBe(200)
    expect(logo.headers.get('content-type')).toBe('image/png')
    expect(logo.headers.get('x-content-type-options')).toBe('nosniff')
    expect(logo.headers.get('cache-control')).toContain('immutable')
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(png('logo-eins'))

    const log = app.logs.find((entry) => entry.event === 'branding.logo.changed')
    expect(log?.fields?.['actorId']).toBe(admin.profile.user.id)
    expect(JSON.stringify(app.logs)).not.toContain('logo-eins')
  })

  it('ersetzt und entfernt das Logo und loescht die alten Bytes', async () => {
    const admin = await signedInAsSystemAdmin(app)
    await uploadLogo(admin, png('alt'))
    const first = await publicBranding()
    await uploadLogo(admin, png('neu'))
    const second = await publicBranding()
    expect(second.logoVersion).not.toBe(first.logoVersion)

    const stale = await fetch(`${app.baseUrl}${BRANDING_LOGO_PATH}?v=${String(first.logoVersion)}`)
    expect(new Uint8Array(await stale.arrayBuffer())).toEqual(png('neu'))
    expect(stale.headers.get('cache-control')).toBe('no-cache')
    expect(await app.context.storage.get(`branding/logo-${String(first.logoVersion)}`)).toBeNull()

    expect((await postJson(admin, ADMIN_BRANDING_LOGO_REMOVE_PATH, {})).status).toBe(200)
    expect((await publicBranding()).logoVersion).toBeNull()
    expect(await app.context.storage.get(`branding/logo-${String(second.logoVersion)}`)).toBeNull()
  })

  it('weist eine als PNG benannte Textdatei, GIF und eine zu grosse Datei ab', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const text = new TextEncoder().encode('kein Bild, nur Text')
    expect((await uploadLogo(admin, text, { 'content-type': 'image/png' })).status).toBe(415)
    expect((await uploadLogo(admin, new TextEncoder().encode('GIF89a......'))).status).toBe(415)
    expect((await uploadLogo(admin, png('x'.repeat(MAX_BRANDING_LOGO_BYTES)))).status).toBe(413)
    expect((await publicBranding()).logoVersion).toBeNull()
  })

  it('weist unzulaessige Einstellungen ab', async () => {
    const admin = await signedInAsSystemAdmin(app)
    expect((await postJson(admin, ADMIN_BRANDING_PATH, { instanceName: 'x'.repeat(61), accent: null })).status).toBe(400)
    expect((await postJson(admin, ADMIN_BRANDING_PATH, { instanceName: 'Ok', accent: '#ff0000' })).status).toBe(400)
    expect((await postJson(admin, ADMIN_BRANDING_PATH, { instanceName: '', accent: null })).status).toBe(200)
    expect((await publicBranding()).instanceName).toBe('Canvaz')
  })

  it('verweigert Admin-Endpunkte ohne Anmeldung, ohne CSRF-Token und normalen Nutzern', async () => {
    const admin = await signedInAsSystemAdmin(app)
    const ada = await ordinaryUser()
    const anonymous: Account = { jar: createJar(), profile: { csrfToken: 'x' } as MeResponse }

    for (const account of [anonymous, ada]) {
      const expected = account === anonymous ? 401 : 403
      expect((await account.jar.fetch(`${app.baseUrl}${ADMIN_BRANDING_PATH}`)).status).toBe(expected)
      expect((await postJson(account, ADMIN_BRANDING_PATH, { instanceName: 'Boese', accent: null })).status).toBe(expected)
      expect((await uploadLogo(account, png('boese'))).status).toBe(expected)
      expect((await postJson(account, ADMIN_BRANDING_LOGO_REMOVE_PATH, {})).status).toBe(expected)
    }
    const noToken = await admin.jar.fetch(`${app.baseUrl}${ADMIN_BRANDING_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceName: 'Ohne Token', accent: null }),
    })
    expect(noToken.status).toBe(403)
    expect((await publicBranding()).instanceName).toBe('Canvaz')
  })
})
