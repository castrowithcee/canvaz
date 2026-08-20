/**
 * Bausteine der lokalen Anmeldung ohne IO: Passwortregel, Adressen, Einladungsfrist und das Hashverfahren.
 */

import { describe, expect, it } from 'vitest'

import {
  INVITATION_TTL_HOURS,
  invitationExpiry,
  isInvitationRedeemable,
  normalizeDisplayName,
  normalizeEmail,
  parsePassword,
} from '../../src/domain/identity/local-auth.js'
import { hashPassword, isSamePassword, verifyPassword } from '../../src/server/password.js'

const now = new Date('2026-01-01T12:00:00Z')

describe('Passwortregel', () => {
  it('nimmt ein ausreichend langes Passwort an und nennt sonst den Grund', () => {
    expect(parsePassword('zwoelf-zeichen-und-mehr')).toEqual({ ok: true, password: 'zwoelf-zeichen-und-mehr' })
    expect(parsePassword('zu-kurz')).toMatchObject({ ok: false })
    expect(parsePassword('x'.repeat(201))).toMatchObject({ ok: false })
    expect(parsePassword(12)).toMatchObject({ ok: false })
  })

  it('trimmt nicht: Leerraum gehoert zum Passwort', () => {
    expect(parsePassword('  mit leerraum  ')).toEqual({ ok: true, password: '  mit leerraum  ' })
  })
})

describe('Adresse und Anzeigename', () => {
  it('normalisiert die Adresse und weist unbrauchbare ab', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com')
    expect(normalizeEmail('ohne-at')).toBeNull()
    expect(normalizeEmail('zwei@@at')).toBeNull()
    expect(normalizeEmail(null)).toBeNull()
  })

  it('zieht Leerraum im Anzeigenamen zusammen und weist leere ab', () => {
    expect(normalizeDisplayName('  Ada   Lovelace ')).toBe('Ada Lovelace')
    expect(normalizeDisplayName('   ')).toBeNull()
    expect(normalizeDisplayName('x'.repeat(81))).toBeNull()
  })
})

describe('Einladung', () => {
  it('ist einloesbar, solange sie weder eingeloest noch widerrufen noch abgelaufen ist', () => {
    const expiresAt = invitationExpiry(now)
    const offen = { expiresAt, redeemedAt: null, revokedAt: null }

    expect(isInvitationRedeemable(offen, now)).toBe(true)
    expect(isInvitationRedeemable({ ...offen, redeemedAt: now }, now)).toBe(false)
    expect(isInvitationRedeemable({ ...offen, revokedAt: now }, now)).toBe(false)
    expect(isInvitationRedeemable(offen, new Date(now.getTime() + (INVITATION_TTL_HOURS + 1) * 3600 * 1000))).toBe(
      false,
    )
  })
})

describe('Passworthash', () => {
  it('erzeugt zu demselben Passwort jedes Mal einen anderen Hash und prueft beide', async () => {
    const erster = await hashPassword('zwoelf-zeichen-und-mehr')
    const zweiter = await hashPassword('zwoelf-zeichen-und-mehr')

    // Verschiedene Salze: zwei gleiche Passwoerter sind in der Datenbank nicht als gleich erkennbar.
    expect(erster).not.toBe(zweiter)
    expect(await verifyPassword('zwoelf-zeichen-und-mehr', erster)).toBe(true)
    expect(await verifyPassword('zwoelf-zeichen-und-mehr', zweiter)).toBe(true)
    expect(await verifyPassword('etwas-anderes-langes', erster)).toBe(false)
  })

  it('enthaelt das Passwort nicht und weist einen unlesbaren Hash ab', async () => {
    const hash = await hashPassword('zwoelf-zeichen-und-mehr')

    expect(hash).not.toContain('zwoelf-zeichen-und-mehr')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('zwoelf-zeichen-und-mehr', 'kein-hash')).toBe(false)
  })

  it('haelt NFKC-gleiche Eingaben fuer dasselbe Passwort - im Vergleich wie im Hash', async () => {
    // U+FF11 statt "1": zeichenweise verschieden, nach der Normalisierung dasselbe Passwort.
    const hash = await hashPassword('initialpasswort1')

    expect(await verifyPassword('initialpasswort\uff11', hash)).toBe(true)
    expect(isSamePassword('initialpasswort1', 'initialpasswort\uff11')).toBe(true)
    expect(isSamePassword('initialpasswort1', 'anderes-passwort-1')).toBe(false)
  })
})
