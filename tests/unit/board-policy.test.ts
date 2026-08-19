/**
 * Boardberechtigung als Tabelle.
 *
 * Die Erwartungen stehen von Hand als Tabelle da und werden **nicht** aus derselben Regel abgeleitet, die
 * die Policy anwendet - sonst pruefte der Test nur, ob die Implementierung mit sich selbst uebereinstimmt.
 * Durchlaufen wird jede Kombination aus Workspace-Rolle, Boardrolle, Workspace- und Boardstatus sowie
 * Nutzerstatus.
 */

import { describe, expect, it } from 'vitest'

import type { BoardRole } from '../../src/domain/board/model.js'
import {
  normalizeBoardTitle,
  parseBaseVersion,
  parseBoardGrantRole,
  parseBoardStatus,
  resolveBoardRole,
} from '../../src/domain/board/model.js'
import type { BoardAction, BoardDenialReason, BoardSubject } from '../../src/domain/board/policy.js'
import { decideBoardAccess } from '../../src/domain/board/policy.js'
import type { WorkspaceRole } from '../../src/domain/workspace/model.js'

function subject(options: {
  role?: WorkspaceRole | null
  boardRole?: BoardRole | null
  systemAdmin?: boolean
  active?: boolean
}): BoardSubject {
  return {
    user: {
      id: 'user-1',
      status: options.active === false ? 'deactivated' : 'active',
      isSystemAdmin: options.systemAdmin ?? false,
    },
    workspaceRole: options.role ?? null,
    boardRole: options.boardRole ?? null,
    // Diese Datei prueft ausschliesslich den internen Weg; der Gastweg hat seine eigene Tabelle.
    guestGrant: null,
  }
}

const AKTIV = { status: 'active' } as const
const ARCHIVIERT = { status: 'archived' } as const

/** Das betroffene Board. Seine Kennung zaehlt erst fuer Gaeste, gehoert aber zum Zustand. */
const BOARD = { id: 'board-1', status: 'active' } as const
const BOARD_ARCHIVIERT = { id: 'board-1', status: 'archived' } as const

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

/** Alles ausser Lesen und Entarchivieren - also die Aktionen, die ein archiviertes Board ablehnt. */
const SCHREIBENDE_AKTIONEN: readonly BoardAction[] = ALLE_AKTIONEN.filter(
  (action) => action !== 'board:read' && action !== 'board:unarchive',
)

const WORKSPACE_ROLLEN: readonly (WorkspaceRole | null)[] = ['owner', 'admin', 'member', null]
const BOARD_ROLLEN: readonly (BoardRole | null)[] = ['owner', 'editor', 'viewer', null]

/** `-` heisst: keine Rolle. */
function schluessel(role: WorkspaceRole | null, boardRole: BoardRole | null): string {
  return `${role ?? '-'}/${boardRole ?? '-'}`
}

/**
 * Erwartete effektive Stufe je Paar aus Workspace- und Boardrolle, von Hand gesetzt.
 *
 * `kein-zugriff` heisst: das Board existiert fuer dieses Subjekt nicht. Ablesbar sind daran die beiden
 * Zusagen dieses Pakets: ohne Mitgliedschaft traegt **keine** Boardrolle etwas, und der Workspace-Owner
 * steht auf jedem Board seines Arbeitsbereichs auf Ownerstufe.
 */
const STUFE: Readonly<Record<string, BoardRole | 'kein-zugriff'>> = {
  'owner/owner': 'owner',
  'owner/editor': 'owner',
  'owner/viewer': 'owner',
  'owner/-': 'owner',
  'admin/owner': 'owner',
  'admin/editor': 'editor',
  'admin/viewer': 'viewer',
  'admin/-': 'editor',
  'member/owner': 'owner',
  'member/editor': 'editor',
  'member/viewer': 'viewer',
  'member/-': 'editor',
  '-/owner': 'kein-zugriff',
  '-/editor': 'kein-zugriff',
  '-/viewer': 'kein-zugriff',
  '-/-': 'kein-zugriff',
}

/** Erlaubte Aktionen je Stufe im aktiven Arbeitsbereich mit aktivem Board, von Hand gesetzt. */
const ERLAUBT: Readonly<Record<BoardRole, readonly BoardAction[]>> = {
  owner: ALLE_AKTIONEN,
  editor: ['board:read', 'board:create', 'board:rename', 'board:archive', 'board:unarchive', 'scene:write'],
  viewer: ['board:read'],
}

/**
 * `scene:restore` ist die einzige Aktion, die **nicht** allein aus der Boardstufe folgt: sie traegt
 * zusaetzlich der Workspace-`admin`, weil er fuer den Bestand des Arbeitsbereichs einsteht. Deshalb steht
 * sie hier als eigene, von Hand gesetzte Regel und nicht in `ERLAUBT`.
 */
function darfWiederherstellen(stufe: BoardRole, role: WorkspaceRole | null): boolean {
  return stufe === 'owner' || role === 'admin'
}

function erwartung(
  stufe: BoardRole | 'kein-zugriff',
  action: BoardAction,
  role: WorkspaceRole | null = null,
): { allowed: true } | { allowed: false; reason: BoardDenialReason } {
  if (stufe === 'kein-zugriff') {
    return { allowed: false, reason: 'not-visible' }
  }
  const erlaubt =
    action === 'scene:restore' ? darfWiederherstellen(stufe, role) : ERLAUBT[stufe].includes(action)
  return erlaubt ? { allowed: true } : { allowed: false, reason: 'insufficient-role' }
}

describe('Boardberechtigung, vollstaendige Rollenmatrix', () => {
  it('entscheidet jede Kombination aus Workspace- und Boardrolle wie in der Tabelle', () => {
    for (const role of WORKSPACE_ROLLEN) {
      for (const boardRole of BOARD_ROLLEN) {
        const stufe = STUFE[schluessel(role, boardRole)]
        expect(stufe, `keine Erwartung fuer ${schluessel(role, boardRole)}`).toBeDefined()
        for (const action of ALLE_AKTIONEN) {
          expect(
            decideBoardAccess(subject({ role, boardRole }), AKTIV, BOARD, action),
            `${schluessel(role, boardRole)} -> ${action}`,
          ).toEqual(erwartung(stufe as BoardRole | 'kein-zugriff', action, role))
        }
      }
    }
  })

  it('macht ein archiviertes Board fuer jede Rolle unveraenderlich und laesst es lesbar', () => {
    for (const role of WORKSPACE_ROLLEN) {
      for (const boardRole of BOARD_ROLLEN) {
        const stufe = STUFE[schluessel(role, boardRole)] as BoardRole | 'kein-zugriff'
        const nichtsichtbar = stufe === 'kein-zugriff'
        expect(decideBoardAccess(subject({ role, boardRole }), AKTIV, BOARD_ARCHIVIERT, 'board:read')).toEqual(
          nichtsichtbar ? { allowed: false, reason: 'not-visible' } : { allowed: true },
        )
        for (const action of SCHREIBENDE_AKTIONEN) {
          expect(
            decideBoardAccess(subject({ role, boardRole }), AKTIV, BOARD_ARCHIVIERT, action),
            `${schluessel(role, boardRole)} -> ${action}`,
          ).toEqual({ allowed: false, reason: nichtsichtbar ? 'not-visible' : 'board-archived' })
        }
        // Entarchivieren bleibt moeglich - fuer jeden, der das Board auch sonst aendern duerfte.
        expect(decideBoardAccess(subject({ role, boardRole }), AKTIV, BOARD_ARCHIVIERT, 'board:unarchive')).toEqual(
          erwartung(stufe, 'board:unarchive', role),
        )
      }
    }
  })

  it('macht mit dem Arbeitsbereich auch seine Boards fuer jede Rolle unveraenderlich', () => {
    for (const role of WORKSPACE_ROLLEN) {
      for (const boardRole of BOARD_ROLLEN) {
        const nichtsichtbar = STUFE[schluessel(role, boardRole)] === 'kein-zugriff'
        for (const status of [BOARD, BOARD_ARCHIVIERT]) {
          expect(decideBoardAccess(subject({ role, boardRole }), ARCHIVIERT, status, 'board:read')).toEqual(
            nichtsichtbar ? { allowed: false, reason: 'not-visible' } : { allowed: true },
          )
          for (const action of ALLE_AKTIONEN.filter((entry) => entry !== 'board:read')) {
            expect(
              decideBoardAccess(subject({ role, boardRole }), ARCHIVIERT, status, action),
              `${schluessel(role, boardRole)} -> ${action}`,
            ).toEqual({ allowed: false, reason: nichtsichtbar ? 'not-visible' : 'workspace-archived' })
          }
        }
      }
    }
  })

  it('entzieht einem deaktivierten Nutzer jeden Zugriff, gleich welche Rollen in der Datenbank stehen', () => {
    for (const role of WORKSPACE_ROLLEN) {
      for (const boardRole of BOARD_ROLLEN) {
        for (const systemAdmin of [false, true]) {
          for (const action of ALLE_AKTIONEN) {
            expect(
              decideBoardAccess(subject({ role, boardRole, systemAdmin, active: false }), AKTIV, BOARD, action),
              `${schluessel(role, boardRole)} -> ${action}`,
            ).toEqual({ allowed: false, reason: 'user-deactivated' })
          }
        }
      }
    }
  })

  it('gibt einem Systemadmin ohne Mitgliedschaft keinen Inhaltszugriff, auch nicht mit Boardrolle', () => {
    // Er verwaltet Arbeitsbereiche; der Inhalt haengt an der Mitgliedschaft, nicht an der Systemrolle.
    for (const boardRole of BOARD_ROLLEN) {
      expect(decideBoardAccess(subject({ systemAdmin: true, boardRole }), AKTIV, BOARD, 'board:read')).toEqual({
        allowed: false,
        reason: 'not-visible',
      })
    }
    expect(decideBoardAccess(subject({ systemAdmin: true, role: 'member' }), AKTIV, BOARD, 'board:read')).toEqual({
      allowed: true,
    })
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

describe('Bestaetigte Wirkung der Boardrollen', () => {
  const mitglied = { role: 'member' } as const

  it('laesst einen viewer lesen, aber die Szene nicht speichern', () => {
    const viewer = subject({ ...mitglied, boardRole: 'viewer' })
    expect(decideBoardAccess(viewer, AKTIV, BOARD, 'board:read')).toEqual({ allowed: true })
    expect(decideBoardAccess(viewer, AKTIV, BOARD, 'scene:write')).toEqual({
      allowed: false,
      reason: 'insufficient-role',
    })
  })

  it('laesst einen editor lesen und speichern, aber keine Freigabe verwalten', () => {
    const editor = subject({ ...mitglied, boardRole: 'editor' })
    expect(decideBoardAccess(editor, AKTIV, BOARD, 'board:read')).toEqual({ allowed: true })
    expect(decideBoardAccess(editor, AKTIV, BOARD, 'scene:write')).toEqual({ allowed: true })
    for (const action of ['grant:manage', 'board:transfer-ownership'] as const) {
      expect(decideBoardAccess(editor, AKTIV, BOARD, action)).toEqual({
        allowed: false,
        reason: 'insufficient-role',
      })
    }
  })

  it('laesst einen owner zusaetzlich Freigaben verwalten und die Ownerschaft uebertragen', () => {
    const owner = subject({ ...mitglied, boardRole: 'owner' })
    for (const action of ALLE_AKTIONEN) {
      expect(decideBoardAccess(owner, AKTIV, BOARD, action)).toEqual({ allowed: true })
    }
  })

  it('laesst eine Boardrolle die fehlende Mitgliedschaft nie ersetzen', () => {
    for (const boardRole of ['owner', 'editor', 'viewer'] as const) {
      for (const action of ALLE_AKTIONEN) {
        expect(decideBoardAccess(subject({ role: null, boardRole }), AKTIV, BOARD, action)).toEqual({
          allowed: false,
          reason: 'not-visible',
        })
      }
    }
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

  it('nimmt als Freigaberolle ausschliesslich editor und viewer an', () => {
    expect(parseBoardGrantRole('editor')).toBe('editor')
    expect(parseBoardGrantRole('viewer')).toBe('viewer')
    // Die Ownerschaft wird uebertragen, nicht vergeben.
    expect(parseBoardGrantRole('owner')).toBeNull()
    expect(parseBoardGrantRole(null)).toBeNull()
  })

  it('loest die Boardrolle aus Ownerspalte und Freigabe auf', () => {
    expect(resolveBoardRole('ada', 'ada', null)).toBe('owner')
    // Die Ownerspalte schlaegt jede Freigabezeile.
    expect(resolveBoardRole('ada', 'ada', 'viewer')).toBe('owner')
    expect(resolveBoardRole('ada', 'bob', 'viewer')).toBe('viewer')
    expect(resolveBoardRole('ada', 'bob', null)).toBeNull()
  })
})
