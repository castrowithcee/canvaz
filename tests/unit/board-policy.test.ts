import { describe, expect, it } from 'vitest'

import type { BoardAction } from '../../src/domain/board/policy.js'
import { decideBoardAccess } from '../../src/domain/board/policy.js'
import { normalizeBoardTitle, parseBaseVersion, parseBoardStatus } from '../../src/domain/board/model.js'
import type { PolicySubject } from '../../src/domain/workspace/policy.js'
import type { WorkspaceRole } from '../../src/domain/workspace/model.js'

function subject(options: {
  role?: WorkspaceRole | null
  systemAdmin?: boolean
  active?: boolean
}): PolicySubject {
  return {
    user: {
      id: 'user-1',
      status: options.active === false ? 'deactivated' : 'active',
      isSystemAdmin: options.systemAdmin ?? false,
    },
    workspaceRole: options.role ?? null,
  }
}

const AKTIV = { status: 'active' } as const
const ARCHIVIERT = { status: 'archived' } as const

const SCHREIBENDE_AKTIONEN: readonly BoardAction[] = [
  'board:create',
  'board:rename',
  'board:archive',
  'scene:write',
]

describe('Boardberechtigung', () => {
  it('laesst jedes Mitglied im aktiven Arbeitsbereich lesen und schreiben', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      for (const action of [...SCHREIBENDE_AKTIONEN, 'board:read' as const]) {
        expect(decideBoardAccess(subject({ role }), AKTIV, AKTIV, action)).toEqual({ allowed: true })
      }
    }
  })

  it('verweigert einem Nichtmitglied jede Kenntnis vom Board', () => {
    for (const action of [...SCHREIBENDE_AKTIONEN, 'board:read' as const]) {
      expect(decideBoardAccess(subject({ role: null }), AKTIV, AKTIV, action)).toEqual({
        allowed: false,
        reason: 'not-visible',
      })
    }
  })

  it('gibt einem Systemadmin ohne Mitgliedschaft keinen Inhaltszugriff', () => {
    // Er verwaltet Arbeitsbereiche; der Inhalt haengt an der Mitgliedschaft, nicht an der Systemrolle.
    expect(decideBoardAccess(subject({ systemAdmin: true }), AKTIV, AKTIV, 'board:read')).toEqual({
      allowed: false,
      reason: 'not-visible',
    })
    expect(decideBoardAccess(subject({ systemAdmin: true, role: 'member' }), AKTIV, AKTIV, 'board:read')).toEqual({
      allowed: true,
    })
  })

  it('entzieht einem deaktivierten Nutzer jeden Zugriff, unabhaengig von Rolle und Systemrolle', () => {
    expect(decideBoardAccess(subject({ role: 'owner', active: false }), AKTIV, AKTIV, 'board:read')).toEqual({
      allowed: false,
      reason: 'user-deactivated',
    })
    expect(
      decideBoardAccess(subject({ systemAdmin: true, role: 'owner', active: false }), AKTIV, AKTIV, 'scene:write'),
    ).toEqual({ allowed: false, reason: 'user-deactivated' })
  })

  it('haelt ein archiviertes Board lesbar und nur noch entarchivierbar', () => {
    const mitglied = subject({ role: 'member' })

    expect(decideBoardAccess(mitglied, AKTIV, ARCHIVIERT, 'board:read')).toEqual({ allowed: true })
    expect(decideBoardAccess(mitglied, AKTIV, ARCHIVIERT, 'board:unarchive')).toEqual({ allowed: true })
    for (const action of SCHREIBENDE_AKTIONEN) {
      expect(decideBoardAccess(mitglied, AKTIV, ARCHIVIERT, action)).toEqual({
        allowed: false,
        reason: 'board-archived',
      })
    }
  })

  it('macht mit dem Arbeitsbereich auch seine Boards unveraenderlich', () => {
    const mitglied = subject({ role: 'owner' })

    expect(decideBoardAccess(mitglied, ARCHIVIERT, AKTIV, 'board:read')).toEqual({ allowed: true })
    for (const action of [...SCHREIBENDE_AKTIONEN, 'board:unarchive' as const]) {
      expect(decideBoardAccess(mitglied, ARCHIVIERT, AKTIV, action)).toEqual({
        allowed: false,
        reason: 'workspace-archived',
      })
    }
  })

  it('entscheidet ohne Board (Anlage) allein ueber die Mitgliedschaft', () => {
    expect(decideBoardAccess(subject({ role: 'member' }), AKTIV, null, 'board:create')).toEqual({ allowed: true })
    expect(decideBoardAccess(subject({ role: null }), AKTIV, null, 'board:create')).toEqual({
      allowed: false,
      reason: 'not-visible',
    })
    expect(decideBoardAccess(subject({ role: 'owner' }), ARCHIVIERT, null, 'board:create')).toEqual({
      allowed: false,
      reason: 'workspace-archived',
    })
  })
})

describe('Boardeingaben', () => {
  it('normalisiert Titel und weist Leeres und Ueberlanges zurueck', () => {
    expect(normalizeBoardTitle('  Team   Nord ')).toBe('Team Nord')
    expect(normalizeBoardTitle('   ')).toBeNull()
    expect(normalizeBoardTitle('x'.repeat(121))).toBeNull()
    expect(normalizeBoardTitle('x'.repeat(120))).toHaveLength(120)
    expect(normalizeBoardTitle(42)).toBeNull()
  })

  it('nimmt nur bekannte Statuswerte an', () => {
    expect(parseBoardStatus('active')).toBe('active')
    expect(parseBoardStatus('archived')).toBe('archived')
    expect(parseBoardStatus('geloescht')).toBeNull()
    expect(parseBoardStatus(null)).toBeNull()
  })

  it('nimmt als Ausgangsversion nur nicht negative ganze Zahlen an', () => {
    expect(parseBaseVersion(0)).toBe(0)
    expect(parseBaseVersion(7)).toBe(7)
    expect(parseBaseVersion(-1)).toBeNull()
    expect(parseBaseVersion(1.5)).toBeNull()
    expect(parseBaseVersion('1')).toBeNull()
    expect(parseBaseVersion(Number.NaN)).toBeNull()
  })
})
