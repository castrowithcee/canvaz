import { describe, expect, it } from 'vitest'

import type { ExternalIdentity, Session, User } from '../../src/domain/identity/model.js'
import { authenticate, isSessionLive } from '../../src/domain/identity/model.js'
import {
  decideProvisioning,
  deriveUserProfile,
  parseIdentityClaims,
} from '../../src/domain/identity/provisioning.js'

const now = new Date('2026-01-01T12:00:00Z')

const user: User = {
  id: 'user-1',
  displayName: 'Ada',
  email: 'ada@example.com',
  status: 'active',
  isSystemAdmin: false,
  createdAt: now,
  updatedAt: now,
}

const session: Session = {
  id: 'session-1',
  userId: 'user-1',
  createdAt: now,
  expiresAt: new Date('2026-01-01T18:00:00Z'),
  revokedAt: null,
}

const identity: ExternalIdentity = {
  id: 'identity-1',
  userId: 'user-1',
  issuer: 'https://idp.example.com',
  subject: 'sub-1',
  createdAt: now,
  lastSeenAt: now,
}

describe('Session-Invarianten', () => {
  it('akzeptiert eine lebende Session eines aktiven Nutzers', () => {
    expect(authenticate(session, user, now)).toEqual({ session, user })
  })

  it('verweigert die Session eines deaktivierten Nutzers', () => {
    expect(authenticate(session, { ...user, status: 'deactivated' }, now)).toBeNull()
  })

  it('verweigert widerrufene und abgelaufene Sessions', () => {
    expect(authenticate({ ...session, revokedAt: now }, user, now)).toBeNull()
    expect(authenticate(session, user, new Date('2026-01-02T00:00:00Z'))).toBeNull()
    expect(isSessionLive({ ...session, expiresAt: now }, now)).toBe(false)
  })

  it('verweigert eine Session, die zu einem anderen Nutzer gehoert', () => {
    expect(authenticate(session, { ...user, id: 'user-2' }, now)).toBeNull()
  })
})

describe('Just-in-time-Provisionierung', () => {
  it('braucht iss und sub und uebernimmt nur bestaetigte Adressen', () => {
    expect(parseIdentityClaims({ sub: 'sub-1' })).toBeNull()
    expect(parseIdentityClaims('nichts')).toBeNull()
    expect(
      parseIdentityClaims({ iss: 'https://idp.example.com', sub: 'sub-1', email: 'Ada@Example.com' })?.email,
    ).toBe('ada@example.com')
    expect(
      parseIdentityClaims({ iss: 'https://idp.example.com', sub: 'sub-1', email: 'a@b.c', email_verified: false })
        ?.email,
    ).toBeNull()
  })

  it('leitet den Anzeigenamen geordnet ab und bleibt nie leer', () => {
    const base = { issuer: 'https://idp.example.com', subject: 'sub-1', email: null, name: null, preferredUsername: null }

    expect(deriveUserProfile({ ...base, name: 'Ada Lovelace' }).displayName).toBe('Ada Lovelace')
    expect(deriveUserProfile({ ...base, preferredUsername: 'ada' }).displayName).toBe('ada')
    expect(deriveUserProfile({ ...base, email: 'ada@example.com' }).displayName).toBe('ada')
    expect(deriveUserProfile(base).displayName).toBe('sub-1')
  })

  it('legt bei unbekannter Identitaet an und macht den ersten Nutzer zum Systemadmin', () => {
    const claims = { issuer: 'https://idp.example.com', subject: 'sub-1', email: null, name: 'Ada', preferredUsername: null }

    expect(decideProvisioning(claims, null, { isFirstUser: true })).toEqual({
      kind: 'provision',
      key: { issuer: 'https://idp.example.com', subject: 'sub-1' },
      profile: { displayName: 'Ada', email: null },
      isSystemAdmin: true,
    })
    expect(decideProvisioning(claims, null, { isFirstUser: false })).toMatchObject({ isSystemAdmin: false })
  })

  it('frischt bekannte Nutzer auf und lehnt deaktivierte ab', () => {
    const claims = { issuer: 'https://idp.example.com', subject: 'sub-1', email: null, name: 'Ada B.', preferredUsername: null }

    expect(decideProvisioning(claims, { identity, user }, { isFirstUser: false })).toEqual({
      kind: 'refresh',
      userId: 'user-1',
      identity,
      profile: { displayName: 'Ada B.', email: null },
    })
    expect(
      decideProvisioning(claims, { identity, user: { ...user, status: 'deactivated' } }, { isFirstUser: false }),
    ).toEqual({ kind: 'deny', reason: 'user-deactivated' })
  })
})
