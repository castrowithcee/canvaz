/**
 * Gastberechtigung als Tabelle.
 *
 * Wie bei den internen Boardrollen stehen die Erwartungen von Hand da und werden **nicht** aus derselben
 * Regel abgeleitet, die die Policy anwendet. Durchlaufen wird jede Kombination aus Gastrolle, Workspace- und
 * Boardstatus sowie Aktion - und zusaetzlich der Fall, der einen Gast ausmacht: ein **anderes** Board als
 * das seines Links.
 */

import { describe, expect, it } from 'vitest'

import type { GuestRole } from '../../src/domain/board/guest.js'
import {
  DEFAULT_GUEST_ROLE,
  GUEST_SESSION_TTL_SECONDS,
  MAX_SHARE_LINK_HOURS,
  guestMayWrite,
  guestSessionExpiry,
  isGuestSessionLive,
  isShareLinkLive,
  normalizeGuestDisplayName,
  parseGuestRole,
  parseShareLinkHours,
  shareLinkExpiry,
} from '../../src/domain/board/guest.js'
import type { BoardAction, BoardDenialReason } from '../../src/domain/board/policy.js'
import { decideBoardAccess, guestSubject } from '../../src/domain/board/policy.js'

const AKTIV = { status: 'active' } as const
const ARCHIVIERT = { status: 'archived' } as const

const BOARD = { id: 'board-1', status: 'active', deletedAt: null } as const
const BOARD_ARCHIVIERT = { id: 'board-1', status: 'archived', deletedAt: null } as const
const FREMDES_BOARD = { id: 'board-2', status: 'active', deletedAt: null } as const

const ALLE_AKTIONEN: readonly BoardAction[] = [
  'board:read',
  'board:create',
  'board:rename',
  'board:archive',
  'board:unarchive',
  'scene:write',
  'scene:restore',
  'grant:manage',
  'board:transfer-ownership',
]

const GASTROLLEN: readonly GuestRole[] = ['guest-viewer', 'guest-editor']

/** Ein Gast auf genau dem Board, fuer das sein Link gilt. */
function gast(role: GuestRole, boardId = 'board-1') {
  return guestSubject('guest-session-1', { boardId, role })
}

/** Erlaubte Aktionen je Gastrolle im aktiven Arbeitsbereich mit aktivem Board, von Hand gesetzt. */
const ERLAUBT: Readonly<Record<GuestRole, readonly BoardAction[]>> = {
  'guest-viewer': ['board:read'],
  'guest-editor': ['board:read', 'scene:write'],
}

function erwartung(
  role: GuestRole,
  action: BoardAction,
): { allowed: true } | { allowed: false; reason: BoardDenialReason } {
  return ERLAUBT[role].includes(action) ? { allowed: true } : { allowed: false, reason: 'insufficient-role' }
}

describe('Gastberechtigung, vollstaendige Tabelle', () => {
  it('entscheidet jede Gastrolle wie in der Tabelle', () => {
    for (const role of GASTROLLEN) {
      for (const action of ALLE_AKTIONEN) {
        expect(decideBoardAccess(gast(role), AKTIV, BOARD, action), `${role} -> ${action}`).toEqual(
          erwartung(role, action),
        )
      }
    }
  })

  it('laesst einen Gast ausschliesslich an das Board seines Links', () => {
    for (const role of GASTROLLEN) {
      for (const action of ALLE_AKTIONEN) {
        // Ein anderes Board sieht fuer ihn aus wie eine erfundene Kennung - auch eines, das es wirklich gibt.
        expect(decideBoardAccess(gast(role), AKTIV, FREMDES_BOARD, action), `${role} -> ${action}`).toEqual({
          allowed: false,
          reason: 'not-visible',
        })
        // Und ohne Board gibt es fuer ihn ueberhaupt nichts zu entscheiden: anlegen kann er nicht.
        expect(decideBoardAccess(gast(role), AKTIV, null, action)).toEqual({
          allowed: false,
          reason: 'not-visible',
        })
      }
    }
  })

  it('gibt einem Gast ohne gueltigen Link gar nichts', () => {
    for (const action of ALLE_AKTIONEN) {
      expect(decideBoardAccess(guestSubject('guest-session-1', null), AKTIV, BOARD, action)).toEqual({
        allowed: false,
        reason: 'not-visible',
      })
    }
  })

  it('macht ein archiviertes Board fuer jeden Gast unveraenderlich und laesst es lesbar', () => {
    for (const role of GASTROLLEN) {
      expect(decideBoardAccess(gast(role), AKTIV, BOARD_ARCHIVIERT, 'board:read')).toEqual({ allowed: true })
      for (const action of ALLE_AKTIONEN.filter((entry) => entry !== 'board:read')) {
        // Auch das Entarchivieren selbst: ein Gast raeumt den Lebenszyklus eines Boards nicht auf.
        expect(decideBoardAccess(gast(role), AKTIV, BOARD_ARCHIVIERT, action), `${role} -> ${action}`).toEqual({
          allowed: false,
          reason: 'board-archived',
        })
      }
    }
  })

  it('macht mit dem Arbeitsbereich auch seine Boards fuer jeden Gast unveraenderlich', () => {
    for (const role of GASTROLLEN) {
      for (const board of [BOARD, BOARD_ARCHIVIERT]) {
        expect(decideBoardAccess(gast(role), ARCHIVIERT, board, 'board:read')).toEqual({ allowed: true })
        for (const action of ALLE_AKTIONEN.filter((entry) => entry !== 'board:read')) {
          expect(decideBoardAccess(gast(role), ARCHIVIERT, board, action), `${role} -> ${action}`).toEqual({
            allowed: false,
            reason: 'workspace-archived',
          })
        }
      }
    }
  })

  it('laesst einen guest-viewer lesen, aber die Szene nicht speichern', () => {
    expect(decideBoardAccess(gast('guest-viewer'), AKTIV, BOARD, 'board:read')).toEqual({ allowed: true })
    expect(decideBoardAccess(gast('guest-viewer'), AKTIV, BOARD, 'scene:write')).toEqual({
      allowed: false,
      reason: 'insufficient-role',
    })
  })

  it('laesst einen guest-editor speichern, aber nie verwalten', () => {
    expect(decideBoardAccess(gast('guest-editor'), AKTIV, BOARD, 'scene:write')).toEqual({ allowed: true })
    for (const action of ['board:rename', 'board:archive', 'grant:manage', 'board:transfer-ownership'] as const) {
      expect(decideBoardAccess(gast('guest-editor'), AKTIV, BOARD, action), action).toEqual({
        allowed: false,
        reason: 'insufficient-role',
      })
    }
  })

  it('gibt einem Gast auch dann keine interne Stufe, wenn im Subjekt Rollen stuenden', () => {
    // `guestSubject` setzt beides nie; der Fall steht hier trotzdem, weil die Zusage an der Policy haengt
    // und nicht an ihrem Aufrufer: der Gastgrant schliesst den internen Weg vollstaendig aus.
    const mischung = {
      ...guestSubject('guest-session-1', { boardId: 'board-1', role: 'guest-viewer' as const }),
      workspaceRole: 'owner' as const,
      boardRole: 'owner' as const,
    }
    for (const action of ALLE_AKTIONEN.filter((entry) => entry !== 'board:read')) {
      expect(decideBoardAccess(mischung, AKTIV, BOARD, action), action).toEqual({
        allowed: false,
        reason: 'insufficient-role',
      })
    }
  })

  it('gibt einem Gast keinen Zugriff auf ein fremdes Board, auch nicht mit Rollen im Subjekt', () => {
    const mischung = {
      ...guestSubject('guest-session-1', { boardId: 'board-1', role: 'guest-editor' as const }),
      workspaceRole: 'owner' as const,
    }
    expect(decideBoardAccess(mischung, AKTIV, FREMDES_BOARD, 'board:read')).toEqual({
      allowed: false,
      reason: 'not-visible',
    })
  })
})

describe('Gasteingaben und Gueltigkeit', () => {
  const jetzt = new Date('2026-03-01T12:00:00.000Z')

  it('nimmt als Gastrolle ausschliesslich die beiden Gastwerte an', () => {
    expect(parseGuestRole('guest-viewer')).toBe('guest-viewer')
    expect(parseGuestRole('guest-editor')).toBe('guest-editor')
    // Boardrollen sind eine andere Ebene und duerfen hier nicht durchrutschen.
    expect(parseGuestRole('viewer')).toBeNull()
    expect(parseGuestRole('editor')).toBeNull()
    expect(parseGuestRole('owner')).toBeNull()
    expect(parseGuestRole(null)).toBeNull()
  })

  it('gibt ohne ausdrueckliche Wahl die lesende Rolle vor', () => {
    expect(DEFAULT_GUEST_ROLE).toBe('guest-viewer')
    expect(guestMayWrite('guest-viewer')).toBe(false)
    expect(guestMayWrite('guest-editor')).toBe(true)
  })

  it('normalisiert den Anzeigenamen und weist Leeres, Ueberlanges und Steuerzeichen ab', () => {
    expect(normalizeGuestDisplayName('  Gast   aus   Nord ')).toBe('Gast aus Nord')
    expect(normalizeGuestDisplayName('Zeile\u0000Ende\u007f')).toBe('ZeileEnde')
    expect(normalizeGuestDisplayName('   ')).toBeNull()
    expect(normalizeGuestDisplayName('')).toBeNull()
    expect(normalizeGuestDisplayName('x'.repeat(61))).toBeNull()
    expect(normalizeGuestDisplayName('x'.repeat(60))).toHaveLength(60)
    expect(normalizeGuestDisplayName(42)).toBeNull()
  })

  it('nimmt als Lebensdauer nur ganze Stunden innerhalb der Obergrenze an', () => {
    expect(parseShareLinkHours(undefined)).toBeUndefined()
    expect(parseShareLinkHours(null)).toBeUndefined()
    expect(parseShareLinkHours(24)).toBe(24)
    expect(parseShareLinkHours(MAX_SHARE_LINK_HOURS)).toBe(MAX_SHARE_LINK_HOURS)
    expect(parseShareLinkHours(MAX_SHARE_LINK_HOURS + 1)).toBeNull()
    expect(parseShareLinkHours(0)).toBeNull()
    expect(parseShareLinkHours(-1)).toBeNull()
    expect(parseShareLinkHours(1.5)).toBeNull()
    expect(parseShareLinkHours('24')).toBeNull()
  })

  it('rechnet die Lebensdauer in einen Ablaufzeitpunkt um', () => {
    expect(shareLinkExpiry(jetzt, undefined)).toBeNull()
    expect(shareLinkExpiry(jetzt, 2)?.toISOString()).toBe('2026-03-01T14:00:00.000Z')
  })

  it('haelt einen Link nur ohne Widerruf und vor dem Ablauf fuer gueltig', () => {
    expect(isShareLinkLive({ expiresAt: null, revokedAt: null }, jetzt)).toBe(true)
    expect(isShareLinkLive({ expiresAt: new Date(jetzt.getTime() + 1), revokedAt: null }, jetzt)).toBe(true)
    expect(isShareLinkLive({ expiresAt: jetzt, revokedAt: null }, jetzt)).toBe(false)
    expect(isShareLinkLive({ expiresAt: null, revokedAt: jetzt }, jetzt)).toBe(false)
  })

  it('haelt eine Gastsession nur ohne Widerruf und vor dem Ablauf fuer gueltig', () => {
    expect(isGuestSessionLive({ expiresAt: new Date(jetzt.getTime() + 1), revokedAt: null }, jetzt)).toBe(true)
    expect(isGuestSessionLive({ expiresAt: jetzt, revokedAt: null }, jetzt)).toBe(false)
    expect(isGuestSessionLive({ expiresAt: new Date(jetzt.getTime() + 1), revokedAt: jetzt }, jetzt)).toBe(false)
  })

  it('laesst eine Gastsession ihren Link nie ueberleben', () => {
    const eigen = new Date(jetzt.getTime() + GUEST_SESSION_TTL_SECONDS * 1000)
    // Link ohne Ablauf oder mit spaeterem Ablauf: die kurze eigene Lebensdauer gewinnt.
    expect(guestSessionExpiry(jetzt, { expiresAt: null })).toEqual(eigen)
    expect(guestSessionExpiry(jetzt, { expiresAt: new Date(eigen.getTime() + 1) })).toEqual(eigen)
    // Link laeuft frueher ab: dann endet auch die Gastsession frueher.
    const frueher = new Date(jetzt.getTime() + 60_000)
    expect(guestSessionExpiry(jetzt, { expiresAt: frueher })).toEqual(frueher)
  })
})

describe('Gast und Papierkorb', () => {
  it('fuehrt einen gueltigen Gastlink nicht mehr auf ein Board im Papierkorb', () => {
    const geloescht = { id: 'board-1', status: 'active', deletedAt: new Date('2026-01-01T00:00:00Z') } as const
    const gast = guestSubject('gast-1', { boardId: 'board-1', role: 'guest-editor' })

    for (const action of ['board:read', 'scene:write'] as const) {
      // Dieselbe Antwort wie fuer eine erfundene Kennung: dass es das Board gab, erfaehrt er nicht.
      expect(decideBoardAccess(gast, AKTIV, geloescht, action), action).toEqual({
        allowed: false,
        reason: 'not-visible',
      })
    }
  })
})
