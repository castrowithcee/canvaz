/**
 * Vollstaendige Entscheidungsmatrix der Workspace-Policy.
 *
 * Die Tabelle ist die Spezifikation: jede Rolle gegen jede Aktion, positiv und negativ, in einem aktiven und
 * in einem archivierten Workspace. Die Erwartungen stehen ausgeschrieben und werden bewusst **nicht** aus
 * derselben Regel abgeleitet, die die Policy verwendet - sonst pruefte der Test sich selbst.
 */

import { describe, expect, it } from 'vitest'

import type { UserStatus } from '../../src/domain/identity/model.js'
import { leavesWorkspaceWithoutOwner, normalizeWorkspaceName, parseWorkspaceRole } from '../../src/domain/workspace/model.js'
import type { WorkspaceRole, WorkspaceStatus } from '../../src/domain/workspace/model.js'
import { decideWorkspaceAccess } from '../../src/domain/workspace/policy.js'
import type { PolicySubject, WorkspaceAction } from '../../src/domain/workspace/policy.js'

function subject(status: UserStatus, isSystemAdmin: boolean, workspaceRole: WorkspaceRole | null): PolicySubject {
  return { user: { id: 'u-1', status, isSystemAdmin }, workspaceRole }
}

/** Feste Spaltenreihenfolge der Matrix. */
const SUBJECTS = [
  ['owner', subject('active', false, 'owner')],
  ['admin', subject('active', false, 'admin')],
  ['mitglied', subject('active', false, 'member')],
  ['nichtmitglied', subject('active', false, null)],
  ['systemadmin ohne Mitgliedschaft', subject('active', true, null)],
  ['systemadmin mit Mitgliedsrolle', subject('active', true, 'member')],
  ['deaktivierter owner', subject('deactivated', false, 'owner')],
  ['deaktivierter systemadmin', subject('deactivated', true, null)],
] as const

/** J = erlaubt, D = deaktiviert, U = nicht sichtbar, R = Rolle traegt nicht, A = archiviert. */
type Erwartung = 'J' | 'D' | 'U' | 'R' | 'A'
type Zeile = readonly [Erwartung, Erwartung, Erwartung, Erwartung, Erwartung, Erwartung, Erwartung, Erwartung]

const REASONS: Readonly<Record<Exclude<Erwartung, 'J'>, string>> = {
  D: 'user-deactivated',
  U: 'not-visible',
  R: 'insufficient-role',
  A: 'workspace-archived',
}

//                                       owner admin mitgl nicht sysad sysad+ deakt deakt-sys
const LESEN: Zeile = /*              */ ['J', 'J', 'J', 'U', 'J', 'J', 'D', 'D']
const NUR_OWNER: Zeile = /*          */ ['J', 'R', 'R', 'U', 'J', 'J', 'D', 'D']
const OWNER_UND_ADMIN: Zeile = /*    */ ['J', 'J', 'R', 'U', 'J', 'J', 'D', 'D']
const ARCHIVIERT_GESPERRT: Zeile = /**/ ['A', 'A', 'A', 'U', 'A', 'A', 'D', 'D']

const MATRIX: readonly {
  readonly label: string
  readonly action: WorkspaceAction
  readonly active: Zeile
  readonly archived: Zeile
}[] = [
  { label: 'Workspace lesen', action: { kind: 'workspace:read' }, active: LESEN, archived: LESEN },
  {
    label: 'Workspace umbenennen',
    action: { kind: 'workspace:rename' },
    active: OWNER_UND_ADMIN,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'Workspace archivieren',
    action: { kind: 'workspace:archive' },
    active: NUR_OWNER,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    // Das Entarchivieren ist die einzige Aenderung, die ein archivierter Workspace zulaesst.
    label: 'Workspace entarchivieren',
    action: { kind: 'workspace:unarchive' },
    active: NUR_OWNER,
    archived: NUR_OWNER,
  },
  {
    label: 'Mitglied als owner aufnehmen',
    action: { kind: 'member:add', role: 'owner' },
    active: NUR_OWNER,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'Mitglied als admin aufnehmen',
    action: { kind: 'member:add', role: 'admin' },
    active: OWNER_UND_ADMIN,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'Mitglied als member aufnehmen',
    action: { kind: 'member:add', role: 'member' },
    active: OWNER_UND_ADMIN,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'owner zu admin herabstufen',
    action: { kind: 'member:change-role', currentRole: 'owner', nextRole: 'admin' },
    active: NUR_OWNER,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'owner zu member herabstufen',
    action: { kind: 'member:change-role', currentRole: 'owner', nextRole: 'member' },
    active: NUR_OWNER,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'admin zu owner hochstufen',
    action: { kind: 'member:change-role', currentRole: 'admin', nextRole: 'owner' },
    active: NUR_OWNER,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'admin zu member herabstufen',
    action: { kind: 'member:change-role', currentRole: 'admin', nextRole: 'member' },
    active: OWNER_UND_ADMIN,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'member zu admin hochstufen',
    action: { kind: 'member:change-role', currentRole: 'member', nextRole: 'admin' },
    active: OWNER_UND_ADMIN,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'member zu owner hochstufen',
    action: { kind: 'member:change-role', currentRole: 'member', nextRole: 'owner' },
    active: NUR_OWNER,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'owner entfernen',
    action: { kind: 'member:remove', currentRole: 'owner' },
    active: NUR_OWNER,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'admin entfernen',
    action: { kind: 'member:remove', currentRole: 'admin' },
    active: OWNER_UND_ADMIN,
    archived: ARCHIVIERT_GESPERRT,
  },
  {
    label: 'member entfernen',
    action: { kind: 'member:remove', currentRole: 'member' },
    active: OWNER_UND_ADMIN,
    archived: ARCHIVIERT_GESPERRT,
  },
]

describe('Entscheidungsmatrix der Workspace-Policy', () => {
  for (const row of MATRIX) {
    for (const status of ['active', 'archived'] as const satisfies readonly WorkspaceStatus[]) {
      const expectations = status === 'active' ? row.active : row.archived
      SUBJECTS.forEach(([name, policySubject], index) => {
        const expected = expectations[index] as Erwartung
        it(`${row.label} - ${name} - ${status} - ${expected === 'J' ? 'erlaubt' : REASONS[expected]}`, () => {
          const decision = decideWorkspaceAccess(policySubject, { status }, row.action)
          if (expected === 'J') {
            expect(decision).toEqual({ allowed: true })
            return
          }
          expect(decision).toEqual({ allowed: false, reason: REASONS[expected] })
        })
      })
    }
  }

  it('deckt jede Aktionsart der Policy ab', () => {
    const kinds = new Set(MATRIX.map((row) => row.action.kind))
    expect([...kinds].sort()).toEqual([
      'member:add',
      'member:change-role',
      'member:remove',
      'workspace:archive',
      'workspace:read',
      'workspace:rename',
      'workspace:unarchive',
    ])
  })

  it('prueft jede Rolle in jeder Aktion beidseitig', () => {
    // 16 Aktionen x 2 Zustaende x 8 Subjekte, davon mindestens eine Zusage und eine Ablehnung je Aktion.
    expect(MATRIX).toHaveLength(16)
    for (const row of MATRIX) {
      expect(row.active).toContain('J')
      expect(row.active.some((value) => value !== 'J')).toBe(true)
    }
  })
})

describe('Ownerinvariante', () => {
  it('haelt den letzten Owner fest', () => {
    expect(leavesWorkspaceWithoutOwner(1, 'owner', null)).toBe(true)
    expect(leavesWorkspaceWithoutOwner(1, 'owner', 'admin')).toBe(true)
    expect(leavesWorkspaceWithoutOwner(1, 'owner', 'member')).toBe(true)
  })

  it('laesst jede Aenderung zu, die den Workspace nicht ownerlos macht', () => {
    expect(leavesWorkspaceWithoutOwner(2, 'owner', 'member')).toBe(false)
    expect(leavesWorkspaceWithoutOwner(1, 'owner', 'owner')).toBe(false)
    expect(leavesWorkspaceWithoutOwner(1, 'admin', null)).toBe(false)
    expect(leavesWorkspaceWithoutOwner(1, 'member', 'admin')).toBe(false)
  })
})

describe('Eingaben des Workspace-Moduls', () => {
  it('normalisiert Namen und weist leere sowie zu lange zurueck', () => {
    expect(normalizeWorkspaceName('  Team   Nord ')).toBe('Team Nord')
    expect(normalizeWorkspaceName('   ')).toBeNull()
    expect(normalizeWorkspaceName('')).toBeNull()
    expect(normalizeWorkspaceName(42)).toBeNull()
    expect(normalizeWorkspaceName('x'.repeat(81))).toBeNull()
    expect(normalizeWorkspaceName('x'.repeat(80))).toHaveLength(80)
  })

  it('nimmt nur die bestaetigten Rollen an', () => {
    expect(parseWorkspaceRole('owner')).toBe('owner')
    expect(parseWorkspaceRole('admin')).toBe('admin')
    expect(parseWorkspaceRole('member')).toBe('member')
    // Boardrollen und Gastrollen gehoeren nicht auf die Workspaceebene.
    expect(parseWorkspaceRole('editor')).toBeNull()
    expect(parseWorkspaceRole('viewer')).toBeNull()
    expect(parseWorkspaceRole('guest')).toBeNull()
    expect(parseWorkspaceRole(null)).toBeNull()
  })
})
