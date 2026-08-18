/**
 * PostgreSQL-Umsetzung der Board-Repository-Ports.
 *
 * Einzige Stelle des Moduls, die SQL kennt. Jede Abfrage traegt den Board- und Workspacebezug in der
 * Where-Klausel; ein Board wird nur zusammen mit seinem Workspace und der Rolle des fragenden Nutzers
 * geladen. Workspace- und Auditabfragen kommen aus dem Workspace-Store und laufen ueber dieselbe Verbindung,
 * damit Aenderung und Nachweis in einer Transaktion entstehen.
 */

import type { Pool } from 'pg'

import type { SceneSnapshot } from '../contracts/scene.js'
import { parseSceneSnapshot } from '../contracts/scene.js'
import type { UserId } from '../domain/identity/model.js'
import type { Board, BoardId, BoardStatus } from '../domain/board/model.js'
import type {
  BoardAccess,
  BoardFilter,
  BoardListEntry,
  BoardStore,
  SceneVersion,
} from '../domain/board/repositories.js'
import { CorruptSceneError, SceneConflictError } from '../domain/board/repositories.js'
import type { WorkspaceId, WorkspaceRole, WorkspaceStatus } from '../domain/workspace/model.js'
import type { Queryable } from './workspace-store.js'
import { createWorkspaceStoreOn } from './workspace-store.js'

const UNIQUE_VIOLATION = '23505'

type BoardRow = {
  id: string
  workspace_id: string
  title: string
  owner_user_id: string
  status: string
  current_scene_version: number
  created_at: Date
  updated_at: Date
}

const BOARD_COLUMNS =
  'id, workspace_id, title, owner_user_id, status, current_scene_version, created_at, updated_at'

function toBoard(row: BoardRow): Board {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    ownerId: row.owner_user_id,
    // Der Check-Constraint laesst nur diese Werte zu.
    status: row.status as BoardStatus,
    sceneVersion: row.current_scene_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) {
    throw new Error(message)
  }
  return row
}

export function createBoardStoreOn(pool: Pool, db: Queryable, inTransaction: boolean): BoardStore {
  const base = createWorkspaceStoreOn(pool, db, inTransaction)

  async function loadAccess(id: BoardId, userId: UserId, lock: boolean): Promise<BoardAccess | null> {
    // Zwei Schritte statt eines Joins ueber die Mitgliedschaft: `for update` wuerde sonst die falsche Zeile
    // sperren. Gesperrt wird ausschliesslich die Boardzeile - sie serialisiert die Speicherungen.
    const found = await db.query<
      BoardRow & {
        owner_display_name: string
        workspace_name: string
        workspace_status: string
        workspace_created_at: Date
        workspace_updated_at: Date
      }
    >(
      `select b.id, b.workspace_id, b.title, b.owner_user_id, b.status, b.current_scene_version,
              b.created_at, b.updated_at, u.display_name as owner_display_name,
              w.name as workspace_name, w.status as workspace_status,
              w.created_at as workspace_created_at, w.updated_at as workspace_updated_at
         from boards b
         join workspaces w on w.id = b.workspace_id
         join users u on u.id = b.owner_user_id
        where b.id = $1${lock ? ' for no key update of b' : ''}`,
      [id],
    )
    const row = found.rows[0]
    if (row === undefined) {
      return null
    }
    const membership = await db.query<{ role: string }>(
      'select role from workspace_memberships where workspace_id = $1 and user_id = $2',
      [row.workspace_id, userId],
    )
    return {
      board: toBoard(row),
      workspace: {
        id: row.workspace_id,
        name: row.workspace_name,
        status: row.workspace_status as WorkspaceStatus,
        createdAt: row.workspace_created_at,
        updatedAt: row.workspace_updated_at,
      },
      role: (membership.rows[0]?.role as WorkspaceRole | undefined) ?? null,
      ownerDisplayName: row.owner_display_name,
    }
  }

  const store: BoardStore = {
    workspaces: base.workspaces,
    audit: base.audit,

    boards: {
      async listForWorkspace(workspaceId: WorkspaceId, filter: BoardFilter): Promise<readonly BoardListEntry[]> {
        // `position(... in ...)` statt `like`: der Suchbegriff darf keine Platzhalter enthalten koennen.
        const result = await db.query<BoardRow & { owner_display_name: string }>(
          `select b.id, b.workspace_id, b.title, b.owner_user_id, b.status, b.current_scene_version,
                  b.created_at, b.updated_at, u.display_name as owner_display_name
             from boards b
             join users u on u.id = b.owner_user_id
            where b.workspace_id = $1
              and b.status = $2
              and ($3 = '' or position(lower($3) in lower(b.title)) > 0)
            order by lower(b.title), b.id`,
          [workspaceId, filter.status, filter.title],
        )
        return result.rows.map((row) => ({ board: toBoard(row), ownerDisplayName: row.owner_display_name }))
      },

      async findForUser(id: BoardId, userId: UserId): Promise<BoardAccess | null> {
        return loadAccess(id, userId, false)
      },

      async findForUpdate(id: BoardId, userId: UserId): Promise<BoardAccess | null> {
        if (!inTransaction) {
          // Ausserhalb einer Transaktion faellt die Sperre sofort wieder weg und die Serialisierung waere
          // eine Illusion. Das ist ein Programmierfehler, kein Betriebszustand.
          throw new Error('findForUpdate ist nur innerhalb einer Transaktion gueltig')
        }
        return loadAccess(id, userId, true)
      },

      async create(workspaceId: WorkspaceId, title: string, ownerId: UserId): Promise<Board> {
        const created = await db.query<BoardRow>(
          `insert into boards (workspace_id, title, owner_user_id)
           values ($1, $2, $3)
           returning ${BOARD_COLUMNS}`,
          [workspaceId, title, ownerId],
        )
        return toBoard(requireRow(created.rows[0], 'Board konnte nicht angelegt werden'))
      },

      async rename(id: BoardId, title: string): Promise<Board> {
        const result = await db.query<BoardRow>(
          `update boards set title = $2, updated_at = now() where id = $1 returning ${BOARD_COLUMNS}`,
          [id, title],
        )
        return toBoard(requireRow(result.rows[0], `Unbekanntes Board ${id}`))
      },

      async setStatus(id: BoardId, status: BoardStatus): Promise<Board> {
        const result = await db.query<BoardRow>(
          `update boards set status = $2, updated_at = now() where id = $1 returning ${BOARD_COLUMNS}`,
          [id, status],
        )
        return toBoard(requireRow(result.rows[0], `Unbekanntes Board ${id}`))
      },

      async setSceneVersion(id: BoardId, version: number): Promise<Board> {
        const result = await db.query<BoardRow>(
          `update boards set current_scene_version = $2, updated_at = now()
            where id = $1
            returning ${BOARD_COLUMNS}`,
          [id, version],
        )
        return toBoard(requireRow(result.rows[0], `Unbekanntes Board ${id}`))
      },
    },

    scenes: {
      async findLatest(boardId: BoardId): Promise<SceneVersion | null> {
        const result = await db.query<{
          version: number
          scene: unknown
          author_user_id: string | null
          created_at: Date
        }>(
          `select version, scene, author_user_id, created_at
             from scene_versions
            where board_id = $1
            order by version desc
            limit 1`,
          [boardId],
        )
        const row = result.rows[0]
        if (row === undefined) {
          return null
        }
        const snapshot = parseSceneSnapshot(row.scene)
        if (snapshot === null) {
          // Kein stiller Ersatz durch eine leere Szene: ein beschaedigter Stand ist ein Fehler.
          throw new CorruptSceneError(boardId, row.version)
        }
        return {
          boardId,
          version: row.version,
          snapshot,
          authorId: row.author_user_id,
          createdAt: row.created_at,
        }
      },

      async append(
        boardId: BoardId,
        version: number,
        snapshot: SceneSnapshot,
        authorId: UserId,
      ): Promise<SceneVersion> {
        try {
          const result = await db.query<{ created_at: Date }>(
            `insert into scene_versions (board_id, version, scene, author_user_id)
             values ($1, $2, $3::jsonb, $4)
             returning created_at`,
            [boardId, version, JSON.stringify(snapshot), authorId],
          )
          const row = requireRow(result.rows[0], 'Szenenversion konnte nicht angelegt werden')
          return { boardId, version, snapshot, authorId, createdAt: row.created_at }
        } catch (error) {
          if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION) {
            // Letzte Absicherung hinter der Zeilensperre: dieselbe Version zweimal gibt es nicht.
            throw new SceneConflictError(error)
          }
          throw error
        }
      },

      async prune(boardId: BoardId, keepNewest: number): Promise<void> {
        await db.query(
          `delete from scene_versions
            where board_id = $1
              and version <= (select max(version) from scene_versions where board_id = $1) - $2`,
          [boardId, keepNewest],
        )
      },
    },

    async transaction<T>(run: (transactional: BoardStore) => Promise<T>): Promise<T> {
      if (inTransaction) {
        return run(store)
      }
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await run(createBoardStoreOn(pool, client, true))
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

export function createBoardStore(pool: Pool): BoardStore {
  return createBoardStoreOn(pool, pool, false)
}
