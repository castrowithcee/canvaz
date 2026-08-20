/**
 * Repository-Integrationstests gegen eine echte PostgreSQL-Instanz.
 *
 * Voraussetzung: `npm run db:up` (compose.yml, Hostport 55432). Die Tests laufen gegen die getrennte
 * Datenbank `canvaz_test` und wenden vorher die regulaeren Migrationen an - damit wird zugleich das
 * Migrationsverfahren selbst geprueft.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { authenticate } from '../../src/domain/identity/model.js'
import type { IdentityStore } from '../../src/domain/identity/repositories.js'
import { createIdentityStore } from '../../src/persistence/identity-store.js'
import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'

const DATABASE_URL =
  process.env['CANVAZ_TEST_DATABASE_URL'] ?? 'postgres://canvaz:canvaz@127.0.0.1:55432/canvaz_test'

const ISSUER = 'https://idp.example.com/realms/canvaz'

let pool: Pool
let store: IdentityStore

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  try {
    await pool.query('select 1')
  } catch (error) {
    throw new Error(
      `Keine Testdatenbank unter ${DATABASE_URL}. Zuerst "npm run db:up" ausfuehren oder CANVAZ_TEST_DATABASE_URL setzen.`,
      { cause: error },
    )
  }
  await migrate(pool)
  store = createIdentityStore(pool)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
})

async function createUser(displayName: string, email: string | null = null) {
  return store.users.create({ displayName, email }, { isSystemAdmin: false })
}

describe('UserRepository', () => {
  it('legt an, liest zurueck und zaehlt', async () => {
    expect(await store.users.count()).toBe(0)

    const created = await store.users.create({ displayName: 'Ada', email: 'ada@example.com' }, { isSystemAdmin: true })

    expect(created.status).toBe('active')
    expect(created.isSystemAdmin).toBe(true)
    expect(created.createdAt).toBeInstanceOf(Date)
    expect(await store.users.findById(created.id)).toEqual(created)
    expect(await store.users.count()).toBe(1)
  })

  it('aktualisiert Profil und Status', async () => {
    const user = await createUser('Ada')

    const renamed = await store.users.updateProfile(user.id, { displayName: 'Ada L.', email: 'ada.l@example.com' })
    expect(renamed.displayName).toBe('Ada L.')
    expect(renamed.email).toBe('ada.l@example.com')

    const deactivated = await store.users.setStatus(user.id, 'deactivated')
    expect(deactivated.status).toBe('deactivated')
  })

  it('verhindert doppelte Adressen und leere Anzeigenamen', async () => {
    await createUser('Ada', 'ada@example.com')

    await expect(createUser('Zweite', 'ada@example.com')).rejects.toThrow()
    await expect(createUser('   ')).rejects.toThrow()
    await expect(createUser('Gross', 'Ada@Example.com')).rejects.toThrow()
  })

  it('erlaubt mehrere Nutzer ohne Adresse', async () => {
    await createUser('Ohne A')
    await createUser('Ohne B')

    expect(await store.users.count()).toBe(2)
  })
})

describe('ExternalIdentityRepository', () => {
  it('verknuepft eine externe Anmeldung und liefert Identitaet samt Nutzer', async () => {
    const user = await createUser('Ada')
    const identity = await store.externalIdentities.link(user.id, { issuer: ISSUER, subject: 'sub-1' })

    const found = await store.externalIdentities.findByKey({ issuer: ISSUER, subject: 'sub-1' })

    expect(found?.identity).toEqual(identity)
    expect(found?.user).toEqual(user)
    expect(await store.externalIdentities.findByKey({ issuer: ISSUER, subject: 'unbekannt' })).toBeNull()
  })

  it('haelt Issuer und Subject eindeutig', async () => {
    const first = await createUser('Ada')
    const second = await createUser('Bob')
    await store.externalIdentities.link(first.id, { issuer: ISSUER, subject: 'sub-1' })

    await expect(store.externalIdentities.link(second.id, { issuer: ISSUER, subject: 'sub-1' })).rejects.toThrow()
  })

  it('trennt gleiche Subjects verschiedener Issuer', async () => {
    const user = await createUser('Ada')
    await store.externalIdentities.link(user.id, { issuer: ISSUER, subject: 'sub-1' })
    await store.externalIdentities.link(user.id, { issuer: 'https://anderer.example.com', subject: 'sub-1' })

    expect((await store.externalIdentities.findByKey({ issuer: ISSUER, subject: 'sub-1' }))?.identity.issuer).toBe(
      ISSUER,
    )
  })

  it('merkt sich den letzten Kontakt', async () => {
    const user = await createUser('Ada')
    const identity = await store.externalIdentities.link(user.id, { issuer: ISSUER, subject: 'sub-1' })
    const seenAt = new Date('2026-02-01T08:00:00Z')

    await store.externalIdentities.markSeen(identity.id, seenAt)

    const found = await store.externalIdentities.findByKey({ issuer: ISSUER, subject: 'sub-1' })
    expect(found?.identity.lastSeenAt.toISOString()).toBe(seenAt.toISOString())
  })

  it('entfernt Verknuepfungen mit dem Nutzer', async () => {
    const user = await createUser('Ada')
    await store.externalIdentities.link(user.id, { issuer: ISSUER, subject: 'sub-1' })

    await pool.query('delete from users where id = $1', [user.id])

    expect(await store.externalIdentities.findByKey({ issuer: ISSUER, subject: 'sub-1' })).toBeNull()
  })
})

describe('SessionRepository', () => {
  const inOneHour = () => new Date(Date.now() + 3_600_000)

  it('loest ein Session-Geheimnis zu Session und Nutzer auf', async () => {
    const user = await createUser('Ada')
    const session = await store.sessions.create({ userId: user.id, tokenHash: 'hash-1', expiresAt: inOneHour() })

    const found = await store.sessions.findAuthenticatedByTokenHash('hash-1', new Date())

    expect(found?.session.id).toBe(session.id)
    expect(found?.user).toEqual(user)
    expect(await store.sessions.findAuthenticatedByTokenHash('unbekannt', new Date())).toBeNull()
  })

  it('liefert keine Session fuer einen deaktivierten Nutzer', async () => {
    const user = await createUser('Ada')
    await store.sessions.create({ userId: user.id, tokenHash: 'hash-1', expiresAt: inOneHour() })

    await store.users.setStatus(user.id, 'deactivated')

    expect(await store.sessions.findAuthenticatedByTokenHash('hash-1', new Date())).toBeNull()
  })

  it('liefert weder widerrufene noch abgelaufene Sessions', async () => {
    const user = await createUser('Ada')
    const session = await store.sessions.create({ userId: user.id, tokenHash: 'hash-1', expiresAt: inOneHour() })

    await store.sessions.revoke(session.id, new Date())
    expect(await store.sessions.findAuthenticatedByTokenHash('hash-1', new Date())).toBeNull()

    await store.sessions.create({ userId: user.id, tokenHash: 'hash-2', expiresAt: inOneHour() })
    const spaeter = new Date(Date.now() + 7_200_000)
    expect(await store.sessions.findAuthenticatedByTokenHash('hash-2', spaeter)).toBeNull()
  })

  it('widerruft alle Sessions eines Nutzers und raeumt abgelaufene weg', async () => {
    const user = await createUser('Ada')
    await store.sessions.create({ userId: user.id, tokenHash: 'hash-1', expiresAt: inOneHour() })
    await store.sessions.create({ userId: user.id, tokenHash: 'hash-2', expiresAt: inOneHour() })

    await store.sessions.revokeAllForUser(user.id, new Date())

    expect(await store.sessions.findAuthenticatedByTokenHash('hash-1', new Date())).toBeNull()
    expect(await store.sessions.findAuthenticatedByTokenHash('hash-2', new Date())).toBeNull()
    expect(await store.sessions.deleteExpired(new Date(Date.now() + 7_200_000))).toBe(2)
  })

  it('haelt das Session-Geheimnis eindeutig', async () => {
    const user = await createUser('Ada')
    await store.sessions.create({ userId: user.id, tokenHash: 'hash-1', expiresAt: inOneHour() })

    await expect(
      store.sessions.create({ userId: user.id, tokenHash: 'hash-1', expiresAt: inOneHour() }),
    ).rejects.toThrow()
  })

  it('bleibt mit der Domain-Invariante konsistent', async () => {
    const user = await createUser('Ada')
    const session = await store.sessions.create({ userId: user.id, tokenHash: 'hash-1', expiresAt: inOneHour() })

    expect(authenticate(session, user, new Date())).not.toBeNull()
  })
})

describe('Transaktion', () => {
  it('macht eine fehlgeschlagene Provisionierung vollstaendig rueckgaengig', async () => {
    await expect(
      store.transaction(async (tx) => {
        const user = await tx.users.create({ displayName: 'Ada', email: null }, { isSystemAdmin: false })
        await tx.externalIdentities.link(user.id, { issuer: ISSUER, subject: 'sub-1' })
        throw new Error('Abbruch nach dem Anlegen')
      }),
    ).rejects.toThrow('Abbruch nach dem Anlegen')

    expect(await store.users.count()).toBe(0)
    expect(await store.externalIdentities.findByKey({ issuer: ISSUER, subject: 'sub-1' })).toBeNull()
  })

  it('schreibt eine erfolgreiche Provisionierung gemeinsam fest', async () => {
    const result = await store.transaction(async (tx) => {
      const user = await tx.users.create({ displayName: 'Ada', email: null }, { isSystemAdmin: true })
      const identity = await tx.externalIdentities.link(user.id, { issuer: ISSUER, subject: 'sub-1' })
      await tx.sessions.create({ userId: user.id, tokenHash: 'hash-1', expiresAt: new Date(Date.now() + 3_600_000) })
      return { user, identity }
    })

    expect(await store.users.count()).toBe(1)
    expect((await store.externalIdentities.findByKey({ issuer: ISSUER, subject: 'sub-1' }))?.identity.id).toBe(
      result.identity.id,
    )
    expect((await store.sessions.findAuthenticatedByTokenHash('hash-1', new Date()))?.user.id).toBe(result.user.id)
  })
})

describe('Bootstrap-Entscheidung', () => {
  it('meldet die unadministrierte Instanz und danach keine mehr', async () => {
    expect(await store.transaction((tx) => tx.users.hasSystemAdmin())).toBe(false)

    // Ein gewoehnlicher Nutzer aendert daran nichts - erst ein Systemadmin tut es.
    await createUser('Ada')
    expect(await store.transaction((tx) => tx.users.hasSystemAdmin())).toBe(false)

    await store.users.create({ displayName: 'Root', email: 'root@example.com' }, { isSystemAdmin: true })

    expect(await store.transaction((tx) => tx.users.hasSystemAdmin())).toBe(true)
  })

  it('gilt nur innerhalb einer Transaktion', async () => {
    await expect(store.users.hasSystemAdmin()).rejects.toThrow()
  })

  it('serialisiert gleichzeitige Bootstraps, sodass nur einer eine unadministrierte Instanz sieht', async () => {
    let angelegt!: () => void
    let freigeben!: () => void
    const hatAngelegt = new Promise<void>((resolve) => {
      angelegt = resolve
    })
    const darfCommitten = new Promise<void>((resolve) => {
      freigeben = resolve
    })

    const erste = store.transaction(async (tx) => {
      const vorhanden = await tx.users.hasSystemAdmin()
      await tx.users.create({ displayName: 'Ada', email: null }, { isSystemAdmin: !vorhanden })
      angelegt()
      await darfCommitten
      return vorhanden
    })
    await hatAngelegt

    // Die zweite Transaktion beginnt, waehrend die erste noch offen ist. Ohne Sperre liest sie unter READ
    // COMMITTED eine Tabelle ohne Systemadmin und wuerde einen zweiten anlegen.
    const zweite = store.transaction((tx) => tx.users.hasSystemAdmin())
    await new Promise((resolve) => setTimeout(resolve, 250))
    freigeben()

    expect(await erste).toBe(false)
    expect(await zweite).toBe(true)
  })
})

describe('Migrationen', () => {
  it('sind wiederholbar ohne Wirkung', async () => {
    expect(await migrate(pool)).toEqual([])
  })
})
