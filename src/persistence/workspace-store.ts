/**
 * PostgreSQL-Umsetzung der Workspace-Repository-Ports.
 *
 * Einzige Stelle des Moduls, die SQL kennt. Jede Abfrage traegt den Workspacebezug in der Where-Klausel;
 * eine Mitgliedschaft ist ohne ihren Workspace nicht erreichbar, und ein Workspace wird nur zusammen mit
 * der Rolle des fragenden Nutzers geladen.
 */

import type { Pool, PoolClient } from 'pg'

import type { UserId, UserStatus } from '../domain/identity/model.js'
import type {
  Workspace,
  WorkspaceAccess,
  WorkspaceId,
  WorkspaceMembership,
  WorkspaceRole,
  WorkspaceStatus,
} from '../domain/workspace/model.js'
import type {
  AuditEvent,
  CandidateUser,
  MembershipTarget,
  NewAuditEvent,
  WorkspaceMember,
  WorkspaceStore,
  WorkspaceWithRole,
} from '../domain/workspace/repositories.js'
import { MembershipConflictError } from '../domain/workspace/repositories.js'

export type Queryable = Pick<PoolClient, 'query'>

const UNIQUE_VIOLATION = '23505'

type WorkspaceRow = {
  id: string
  name: string
  status: string
  created_at: Date
  updated_at: Date
}

type MembershipRow = {
  workspace_id: string
  user_id: string
  role: string
  created_at: Date
  updated_at: Date
}

type AuditRow = {
  id: string
  occurred_at: Date
  actor_user_id: string | null
  action: string
  target_type: string
  target_id: string
  workspace_id: string
  details: Record<string, string | number | boolean | null>
}

const WORKSPACE_COLUMNS = 'id, name, status, created_at, updated_at'
const MEMBERSHIP_COLUMNS = 'workspace_id, user_id, role, created_at, updated_at'

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    // Der Check-Constraint laesst nur diese Werte zu.
    status: row.status as WorkspaceStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMembership(row: MembershipRow): WorkspaceMembership {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role as WorkspaceRole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    // Der Akteur wird immer geschrieben; null entstuende erst, wenn der Nutzer spaeter geloescht wuerde.
    actorId: row.actor_user_id ?? '',
    action: row.action,
    targetType: row.target_type as NewAuditEvent['targetType'],
    targetId: row.target_id,
    workspaceId: row.workspace_id,
    details: row.details,
  }
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) {
    throw new Error(message)
  }
  return row
}

/**
 * Baut den Store ueber einer bereits gewaehlten Verbindung. Exportiert, damit der Board-Store dieselben
 * Workspace- und Auditabfragen in *seiner* Transaktion nutzen kann, statt sie ein zweites Mal zu schreiben.
 */
export function createWorkspaceStoreOn(pool: Pool, db: Queryable, inTransaction: boolean): WorkspaceStore {
  async function loadAccess(id: WorkspaceId, userId: UserId, lock: boolean): Promise<WorkspaceAccess | null> {
    // Zwei Schritte statt eines Joins, weil `for update` mit einem Left Join auf die Mitgliedschaft die
    // falsche Zeile sperren wuerde. Gesperrt wird ausschliesslich die Workspacezeile.
    const found = await db.query<WorkspaceRow>(
      `select ${WORKSPACE_COLUMNS} from workspaces where id = $1${lock ? ' for update' : ''}`,
      [id],
    )
    const row = found.rows[0]
    if (row === undefined) {
      return null
    }
    const membership = await db.query<{ role: string }>(
      'select role from workspace_memberships where workspace_id = $1 and user_id = $2',
      [id, userId],
    )
    return { workspace: toWorkspace(row), role: (membership.rows[0]?.role as WorkspaceRole | undefined) ?? null }
  }

  const store: WorkspaceStore = {
    workspaces: {
      async listForUser(userId: UserId): Promise<readonly WorkspaceWithRole[]> {
        const result = await db.query<WorkspaceRow & { role: string }>(
          `select w.id, w.name, w.status, w.created_at, w.updated_at, m.role
           from workspaces w
           join workspace_memberships m on m.workspace_id = w.id
           where m.user_id = $1
           order by w.name, w.id`,
          [userId],
        )
        return result.rows.map((row) => ({ workspace: toWorkspace(row), role: row.role as WorkspaceRole }))
      },

      async findForUser(id: WorkspaceId, userId: UserId): Promise<WorkspaceAccess | null> {
        return loadAccess(id, userId, false)
      },

      async findForUpdate(id: WorkspaceId, userId: UserId): Promise<WorkspaceAccess | null> {
        if (!inTransaction) {
          // Ausserhalb einer Transaktion faellt die Sperre sofort wieder weg und die Serialisierung waere
          // eine Illusion. Das ist ein Programmierfehler, kein Betriebszustand.
          throw new Error('findForUpdate ist nur innerhalb einer Transaktion gueltig')
        }
        return loadAccess(id, userId, true)
      },

      async create(name: string, ownerId: UserId): Promise<Workspace> {
        const created = await db.query<WorkspaceRow>(
          `insert into workspaces (name) values ($1) returning ${WORKSPACE_COLUMNS}`,
          [name],
        )
        const workspace = toWorkspace(requireRow(created.rows[0], 'Workspace konnte nicht angelegt werden'))
        // Der Ersteller ist Owner. Ohne diese Zeile entstuende ein Workspace ohne Owner.
        await db.query('insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, $3)', [
          workspace.id,
          ownerId,
          'owner',
        ])
        return workspace
      },

      async rename(id: WorkspaceId, name: string): Promise<Workspace> {
        const result = await db.query<WorkspaceRow>(
          `update workspaces set name = $2, updated_at = now() where id = $1 returning ${WORKSPACE_COLUMNS}`,
          [id, name],
        )
        return toWorkspace(requireRow(result.rows[0], `Unbekannter Workspace ${id}`))
      },

      async setStatus(id: WorkspaceId, status: WorkspaceStatus): Promise<Workspace> {
        const result = await db.query<WorkspaceRow>(
          `update workspaces set status = $2, updated_at = now() where id = $1 returning ${WORKSPACE_COLUMNS}`,
          [id, status],
        )
        return toWorkspace(requireRow(result.rows[0], `Unbekannter Workspace ${id}`))
      },

      async listMembers(workspaceId: WorkspaceId): Promise<readonly WorkspaceMember[]> {
        const result = await db.query<MembershipRow & { display_name: string; email: string | null }>(
          `select m.workspace_id, m.user_id, m.role, m.created_at, m.updated_at, u.display_name, u.email
           from workspace_memberships m
           join users u on u.id = m.user_id
           where m.workspace_id = $1
           order by u.display_name, m.user_id`,
          [workspaceId],
        )
        return result.rows.map((row) => ({
          ...toMembership(row),
          displayName: row.display_name,
          email: row.email,
        }))
      },

      async findMembership(workspaceId: WorkspaceId, userId: UserId): Promise<WorkspaceMembership | null> {
        const result = await db.query<MembershipRow>(
          `select ${MEMBERSHIP_COLUMNS} from workspace_memberships where workspace_id = $1 and user_id = $2`,
          [workspaceId, userId],
        )
        const row = result.rows[0]
        return row === undefined ? null : toMembership(row)
      },

      async countOwners(workspaceId: WorkspaceId): Promise<number> {
        const result = await db.query<{ count: number }>(
          `select count(*)::int as count from workspace_memberships where workspace_id = $1 and role = 'owner'`,
          [workspaceId],
        )
        return requireRow(result.rows[0], 'count lieferte keine Zeile').count
      },

      async searchCandidates(workspaceId: WorkspaceId, query: string, limit: number): Promise<readonly CandidateUser[]> {
        // Genaue Treffer, sonst nichts: die vollstaendige Adresse oder der vollstaendige Anzeigename, jeweils
        // ohne Ruecksicht auf Gross- und Kleinschreibung. Ein Praefix- oder Teilstringvergleich wuerde das
        // Verzeichnis wieder durchsuchbar machen; ein `like` wuerde ausserdem `%` und `_` der Eingabe deuten.
        const result = await db.query<{ id: string; display_name: string; email: string | null }>(
          `select u.id, u.display_name, u.email
           from users u
           where u.status = 'active'
             and (lower(u.email) = lower($2) or lower(btrim(u.display_name)) = lower(btrim($2)))
             and not exists (
               select 1 from workspace_memberships m where m.workspace_id = $1 and m.user_id = u.id
             )
           order by u.display_name, u.id
           limit $3`,
          [workspaceId, query, limit],
        )
        return result.rows.map((row) => ({ id: row.id, displayName: row.display_name, email: row.email }))
      },

      async findUserForMembership(userId: UserId): Promise<MembershipTarget | null> {
        if (!inTransaction) {
          throw new Error('findUserForMembership ist nur innerhalb einer Transaktion gueltig')
        }
        // `for share` haelt die Nutzerzeile bis zum Commit: eine gleichzeitige Deaktivierung wartet, statt
        // die Mitgliedschaft auf einem ueberholten Stand entstehen zu lassen. Gelesen wird nur, geschrieben
        // wird die Zeile hier nie.
        const result = await db.query<{ id: string; display_name: string; email: string | null; status: string }>(
          'select id, display_name, email, status from users where id = $1 for share',
          [userId],
        )
        const row = result.rows[0]
        return row === undefined
          ? null
          : {
              id: row.id,
              displayName: row.display_name,
              email: row.email,
              // Der Check-Constraint laesst nur diese Werte zu.
              status: row.status as UserStatus,
            }
      },

      async addMember(workspaceId: WorkspaceId, userId: UserId, role: WorkspaceRole): Promise<WorkspaceMembership> {
        try {
          const result = await db.query<MembershipRow>(
            `insert into workspace_memberships (workspace_id, user_id, role)
             values ($1, $2, $3)
             returning ${MEMBERSHIP_COLUMNS}`,
            [workspaceId, userId, role],
          )
          return toMembership(requireRow(result.rows[0], 'Mitgliedschaft konnte nicht angelegt werden'))
        } catch (error) {
          if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION) {
            throw new MembershipConflictError(error)
          }
          throw error
        }
      },

      async setRole(workspaceId: WorkspaceId, userId: UserId, role: WorkspaceRole): Promise<WorkspaceMembership> {
        const result = await db.query<MembershipRow>(
          `update workspace_memberships set role = $3, updated_at = now()
           where workspace_id = $1 and user_id = $2
           returning ${MEMBERSHIP_COLUMNS}`,
          [workspaceId, userId, role],
        )
        return toMembership(requireRow(result.rows[0], 'Unbekannte Mitgliedschaft'))
      },

      async removeMember(workspaceId: WorkspaceId, userId: UserId): Promise<void> {
        await db.query('delete from workspace_memberships where workspace_id = $1 and user_id = $2', [
          workspaceId,
          userId,
        ])
      },
    },

    audit: {
      async record(event: NewAuditEvent): Promise<AuditEvent> {
        const result = await db.query<AuditRow>(
          `insert into audit_events (actor_user_id, action, target_type, target_id, workspace_id, details)
           values ($1, $2, $3, $4, $5, $6)
           returning id, occurred_at, actor_user_id, action, target_type, target_id, workspace_id, details`,
          [event.actorId, event.action, event.targetType, event.targetId, event.workspaceId, event.details],
        )
        return toAuditEvent(requireRow(result.rows[0], 'Auditereignis konnte nicht geschrieben werden'))
      },

      async listForWorkspace(workspaceId: WorkspaceId): Promise<readonly AuditEvent[]> {
        const result = await db.query<AuditRow>(
          `select id, occurred_at, actor_user_id, action, target_type, target_id, workspace_id, details
           from audit_events
           where workspace_id = $1
           order by occurred_at, id`,
          [workspaceId],
        )
        return result.rows.map(toAuditEvent)
      },
    },

    async transaction<T>(run: (transactional: WorkspaceStore) => Promise<T>): Promise<T> {
      if (inTransaction) {
        return run(store)
      }
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await run(createWorkspaceStoreOn(pool, client, true))
        await client.query('commit')
        return result
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    },
  }
  return store
}

export function createWorkspaceStore(pool: Pool): WorkspaceStore {
  return createWorkspaceStoreOn(pool, pool, false)
}
