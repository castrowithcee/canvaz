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
import type {
  AuthenticatedGuest,
  BoardShareLink,
  BoardShareLinkId,
  GuestRole,
  GuestSession,
} from '../domain/board/guest.js'
import type { Board, BoardGrantRole, BoardId, BoardStatus } from '../domain/board/model.js'
import { resolveBoardRole } from '../domain/board/model.js'
import type {
  BoardAccess,
  BoardAsset,
  BoardFilter,
  BoardGrant,
  BoardGrantEntry,
  BoardListEntry,
  BoardShareLinkEntry,
  BoardStore,
  BoardViewer,
  NewBoardAsset,
  NewBoardShareLink,
  SceneVersion,
} from '../domain/board/repositories.js'
import { BoardGrantConflictError, CorruptSceneError, SceneConflictError } from '../domain/board/repositories.js'
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

type BoardAssetRow = {
  id: string
  board_id: string
  workspace_id: string
  file_id: string
  file_name: string | null
  mime_type: string
  byte_size: string
  checksum_sha256: string
  storage_key: string
  created_at: Date
}

const BOARD_ASSET_COLUMNS =
  'id, board_id, workspace_id, file_id, file_name, mime_type, byte_size, checksum_sha256, storage_key, created_at'

function toBoardAsset(row: BoardAssetRow): BoardAsset {
  return {
    id: row.id,
    boardId: row.board_id,
    workspaceId: row.workspace_id,
    fileId: row.file_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    // `bigint` kommt als Zeichenkette an; die Groesse ist durch die Uploadgrenze weit unterhalb von
    // `Number.MAX_SAFE_INTEGER` und damit verlustfrei.
    byteSize: Number(row.byte_size),
    checksumSha256: row.checksum_sha256,
    storageKey: row.storage_key,
    createdAt: row.created_at,
  }
}

type BoardGrantRow = {
  board_id: string
  workspace_id: string
  user_id: string
  role: string
  created_at: Date
  updated_at: Date
}

const BOARD_GRANT_COLUMNS = 'board_id, workspace_id, user_id, role, created_at, updated_at'

function toBoardGrant(row: BoardGrantRow): BoardGrant {
  return {
    boardId: row.board_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    // Der Check-Constraint laesst nur diese Werte zu; `owner` kann dort nicht stehen.
    role: row.role as BoardGrantRole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

type ShareLinkRow = {
  id: string
  board_id: string
  role: string
  created_by_user_id: string | null
  created_at: Date
  expires_at: Date | null
  revoked_at: Date | null
}

const SHARE_LINK_COLUMNS = 'id, board_id, role, created_by_user_id, created_at, expires_at, revoked_at'

function toShareLink(row: ShareLinkRow): BoardShareLink {
  return {
    id: row.id,
    boardId: row.board_id,
    // Der Check-Constraint laesst nur diese Werte zu.
    role: row.role as GuestRole,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }
}

type GuestSessionRow = {
  id: string
  share_link_id: string
  board_id: string
  display_name: string
  created_at: Date
  expires_at: Date
  revoked_at: Date | null
}

const GUEST_SESSION_COLUMNS = 'id, share_link_id, board_id, display_name, created_at, expires_at, revoked_at'

function toGuestSession(row: GuestSessionRow): GuestSession {
  return {
    id: row.id,
    shareLinkId: row.share_link_id,
    boardId: row.board_id,
    displayName: row.display_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }
}

/**
 * Bedingung eines noch gueltigen Gastzugangs, einmal formuliert.
 *
 * Sie steht bewusst in **einer** Zeichenkette: Gastsession und Link muessen beide leben, und eine zweite,
 * leicht abweichende Formulierung waere genau die Stelle, an der ein Widerruf einmal nicht wirkt. Die
 * Platzhalter sind `$s` fuer die Gastsession, `$l` fuer den Link und `$n` fuer den Zeitpunkt.
 */
function liveGuestCondition(session: string, link: string, now: string): string {
  return `${session}.revoked_at is null
      and ${session}.expires_at > ${now}
      and ${link}.revoked_at is null
      and (${link}.expires_at is null or ${link}.expires_at > ${now})`
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) {
    throw new Error(message)
  }
  return row
}

export function createBoardStoreOn(pool: Pool, db: Queryable, inTransaction: boolean): BoardStore {
  const base = createWorkspaceStoreOn(pool, db, inTransaction)

  /**
   * Rollen des Anfragenden auf genau diesem Board, in **einer** Abfrage.
   *
   * Beim internen Nutzer sind das Mitgliedschaft und Freigabe, beim Gast die Rolle seines noch gueltigen
   * Links. Zwei getrennte Abfragen waeren zwei Zeitpunkte; ausserhalb einer Transaktion faellt eine
   * Aenderung sonst genau in die Luecke.
   */
  async function loadRoles(
    board: BoardRow,
    viewer: BoardViewer,
    now: Date,
  ): Promise<Pick<BoardAccess, 'role' | 'boardRole' | 'guestRole'>> {
    if (viewer.kind === 'guest') {
      const found = await db.query<{ role: string }>(
        `select l.role
           from board_guest_sessions s
           join board_share_links l on l.id = s.share_link_id
          where s.id = $1
            and s.board_id = $2
            and ${liveGuestCondition('s', 'l', '$3')}`,
        [viewer.guestSessionId, board.id, now],
      )
      // Ein Gast hat nie eine Mitgliedschaft und nie eine Boardrolle. Beide Ebenen mischen sich nicht.
      return { role: null, boardRole: null, guestRole: (found.rows[0]?.role as GuestRole | undefined) ?? null }
    }
    const roles = await db.query<{ workspace_role: string | null; grant_role: string | null }>(
      `select (select role from workspace_memberships where workspace_id = $1 and user_id = $2) as workspace_role,
              (select role from board_grants where board_id = $3 and user_id = $2) as grant_role`,
      [board.workspace_id, viewer.userId, board.id],
    )
    const roleRow = roles.rows[0]
    return {
      role: (roleRow?.workspace_role as WorkspaceRole | null | undefined) ?? null,
      boardRole: resolveBoardRole(
        board.owner_user_id,
        viewer.userId,
        (roleRow?.grant_role as BoardGrantRole | null | undefined) ?? null,
      ),
      guestRole: null,
    }
  }

  async function loadAccess(
    id: BoardId,
    viewer: BoardViewer,
    now: Date,
    lock: boolean,
  ): Promise<BoardAccess | null> {
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
    return {
      board: toBoard(row),
      workspace: {
        id: row.workspace_id,
        name: row.workspace_name,
        status: row.workspace_status as WorkspaceStatus,
        createdAt: row.workspace_created_at,
        updatedAt: row.workspace_updated_at,
      },
      ...(await loadRoles(row, viewer, now)),
      ownerDisplayName: row.owner_display_name,
    }
  }

  const store: BoardStore = {
    workspaces: base.workspaces,
    audit: base.audit,

    boards: {
      async listForWorkspace(
        workspaceId: WorkspaceId,
        userId: UserId,
        filter: BoardFilter,
      ): Promise<readonly BoardListEntry[]> {
        // `position(... in ...)` statt `like`: der Suchbegriff darf keine Platzhalter enthalten koennen.
        // Die eigene Freigabezeile kommt als `left join` mit: sie gehoert zu genau dieser Zeile und zu
        // diesem Zeitpunkt, und eine zweite Abfrage je Board waere beides nicht.
        const result = await db.query<BoardRow & { owner_display_name: string; grant_role: string | null }>(
          `select b.id, b.workspace_id, b.title, b.owner_user_id, b.status, b.current_scene_version,
                  b.created_at, b.updated_at, u.display_name as owner_display_name, g.role as grant_role
             from boards b
             join users u on u.id = b.owner_user_id
             left join board_grants g on g.board_id = b.id and g.user_id = $4
            where b.workspace_id = $1
              and b.status = $2
              and ($3 = '' or position(lower($3) in lower(b.title)) > 0)
            order by lower(b.title), b.id`,
          [workspaceId, filter.status, filter.title, userId],
        )
        return result.rows.map((row) => ({
          board: toBoard(row),
          ownerDisplayName: row.owner_display_name,
          // Dieselbe Aufloesung wie beim einzelnen Board: der Owner schlaegt jede Freigabezeile.
          boardRole: resolveBoardRole(row.owner_user_id, userId, (row.grant_role as BoardGrantRole | null) ?? null),
        }))
      },

      async findForViewer(id: BoardId, viewer: BoardViewer, now: Date): Promise<BoardAccess | null> {
        return loadAccess(id, viewer, now, false)
      },

      async findForUpdate(id: BoardId, viewer: BoardViewer, now: Date): Promise<BoardAccess | null> {
        if (!inTransaction) {
          // Ausserhalb einer Transaktion faellt die Sperre sofort wieder weg und die Serialisierung waere
          // eine Illusion. Das ist ein Programmierfehler, kein Betriebszustand.
          throw new Error('findForUpdate ist nur innerhalb einer Transaktion gueltig')
        }
        return loadAccess(id, viewer, now, true)
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

      async setOwner(id: BoardId, ownerId: UserId): Promise<Board> {
        const result = await db.query<BoardRow>(
          `update boards set owner_user_id = $2, updated_at = now() where id = $1 returning ${BOARD_COLUMNS}`,
          [id, ownerId],
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

    grants: {
      async listForBoard(boardId: BoardId): Promise<readonly BoardGrantEntry[]> {
        const result = await db.query<BoardGrantRow & { display_name: string; email: string | null }>(
          `select g.board_id, g.workspace_id, g.user_id, g.role, g.created_at, g.updated_at,
                  u.display_name, u.email
             from board_grants g
             join users u on u.id = g.user_id
            where g.board_id = $1
            order by u.display_name, g.user_id`,
          [boardId],
        )
        return result.rows.map((row) => ({
          ...toBoardGrant(row),
          displayName: row.display_name,
          email: row.email,
        }))
      },

      async find(boardId: BoardId, userId: UserId): Promise<BoardGrant | null> {
        const result = await db.query<BoardGrantRow>(
          `select ${BOARD_GRANT_COLUMNS} from board_grants where board_id = $1 and user_id = $2`,
          [boardId, userId],
        )
        const row = result.rows[0]
        return row === undefined ? null : toBoardGrant(row)
      },

      async add(
        boardId: BoardId,
        workspaceId: WorkspaceId,
        userId: UserId,
        role: BoardGrantRole,
      ): Promise<BoardGrant> {
        try {
          const result = await db.query<BoardGrantRow>(
            `insert into board_grants (board_id, workspace_id, user_id, role)
             values ($1, $2, $3, $4)
             returning ${BOARD_GRANT_COLUMNS}`,
            [boardId, workspaceId, userId, role],
          )
          return toBoardGrant(requireRow(result.rows[0], 'Freigabe konnte nicht angelegt werden'))
        } catch (error) {
          if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION) {
            throw new BoardGrantConflictError(error)
          }
          throw error
        }
      },

      async setRole(boardId: BoardId, userId: UserId, role: BoardGrantRole): Promise<BoardGrant> {
        const result = await db.query<BoardGrantRow>(
          `update board_grants set role = $3, updated_at = now()
            where board_id = $1 and user_id = $2
            returning ${BOARD_GRANT_COLUMNS}`,
          [boardId, userId, role],
        )
        return toBoardGrant(requireRow(result.rows[0], 'Unbekannte Freigabe'))
      },

      async remove(boardId: BoardId, userId: UserId): Promise<void> {
        await db.query('delete from board_grants where board_id = $1 and user_id = $2', [boardId, userId])
      },
    },

    shareLinks: {
      async listForBoard(boardId: BoardId): Promise<readonly BoardShareLinkEntry[]> {
        // Der Zaehler kommt als Unterabfrage mit: eine zweite Abfrage je Zeile waere fuer eine Liste, die
        // ohnehin kurz ist, ein Vielfaches an Rundreisen.
        const result = await db.query<ShareLinkRow & { created_by_display_name: string | null; guest_count: string }>(
          `select l.id, l.board_id, l.role, l.created_by_user_id, l.created_at, l.expires_at, l.revoked_at,
                  u.display_name as created_by_display_name,
                  (select count(*) from board_guest_sessions s where s.share_link_id = l.id) as guest_count
             from board_share_links l
             left join users u on u.id = l.created_by_user_id
            where l.board_id = $1
            order by l.created_at desc, l.id`,
          [boardId],
        )
        return result.rows.map((row) => ({
          ...toShareLink(row),
          createdByDisplayName: row.created_by_display_name,
          guestCount: Number(row.guest_count),
        }))
      },

      async find(boardId: BoardId, id: BoardShareLinkId): Promise<BoardShareLink | null> {
        // Board und Link zusammen; es gibt keine Abfrage allein ueber die Linkkennung.
        const result = await db.query<ShareLinkRow>(
          `select ${SHARE_LINK_COLUMNS} from board_share_links where board_id = $1 and id = $2`,
          [boardId, id],
        )
        const row = result.rows[0]
        return row === undefined ? null : toShareLink(row)
      },

      async findLiveByTokenHash(tokenHash: string, now: Date): Promise<BoardShareLink | null> {
        const result = await db.query<ShareLinkRow>(
          `select ${SHARE_LINK_COLUMNS}
             from board_share_links
            where token_hash = $1
              and revoked_at is null
              and (expires_at is null or expires_at > $2)`,
          [tokenHash, now],
        )
        const row = result.rows[0]
        return row === undefined ? null : toShareLink(row)
      },

      async create(link: NewBoardShareLink): Promise<BoardShareLink> {
        const result = await db.query<ShareLinkRow>(
          `insert into board_share_links (board_id, workspace_id, token_hash, role, created_by_user_id, expires_at)
           values ($1, $2, $3, $4, $5, $6)
           returning ${SHARE_LINK_COLUMNS}`,
          [link.boardId, link.workspaceId, link.tokenHash, link.role, link.createdByUserId, link.expiresAt],
        )
        return toShareLink(requireRow(result.rows[0], 'Freigabelink konnte nicht angelegt werden'))
      },

      async revoke(boardId: BoardId, id: BoardShareLinkId, revokedAt: Date): Promise<BoardShareLink | null> {
        // `coalesce`: ein zweiter Widerruf laesst den ersten Zeitpunkt stehen. Der Nachweis soll sagen, wann
        // der Zugang endete, nicht wann zuletzt jemand darauf geklickt hat.
        const result = await db.query<ShareLinkRow>(
          `update board_share_links set revoked_at = coalesce(revoked_at, $3)
            where board_id = $1 and id = $2
            returning ${SHARE_LINK_COLUMNS}`,
          [boardId, id, revokedAt],
        )
        const row = result.rows[0]
        return row === undefined ? null : toShareLink(row)
      },
    },

    guests: {
      async findAuthenticatedByTokenHash(tokenHash: string, now: Date): Promise<AuthenticatedGuest | null> {
        const result = await db.query<GuestSessionRow & { link_role: string }>(
          `select ${GUEST_SESSION_COLUMNS.split(', ').map((column) => `s.${column}`).join(', ')},
                  l.role as link_role
             from board_guest_sessions s
             join board_share_links l on l.id = s.share_link_id
            where s.token_hash = $1
              and ${liveGuestCondition('s', 'l', '$2')}`,
          [tokenHash, now],
        )
        const row = result.rows[0]
        // Ablauf und Widerruf stehen in der Abfrage selbst: was hier nicht herauskommt, gilt nicht - und es
        // gibt keinen zweiten Weg, an dem die Pruefung vorbeifuehren koennte.
        return row === undefined ? null : { session: toGuestSession(row), role: row.link_role as GuestRole }
      },

      async create(session: {
        readonly shareLinkId: BoardShareLinkId
        readonly boardId: BoardId
        readonly tokenHash: string
        readonly displayName: string
        readonly expiresAt: Date
      }): Promise<GuestSession> {
        const result = await db.query<GuestSessionRow>(
          `insert into board_guest_sessions (share_link_id, board_id, token_hash, display_name, expires_at)
           values ($1, $2, $3, $4, $5)
           returning ${GUEST_SESSION_COLUMNS}`,
          [session.shareLinkId, session.boardId, session.tokenHash, session.displayName, session.expiresAt],
        )
        return toGuestSession(requireRow(result.rows[0], 'Gastsession konnte nicht angelegt werden'))
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
        authorId: UserId | null,
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

    assets: {
      async findByFileId(boardId: BoardId, fileId: string): Promise<BoardAsset | null> {
        // Board und Dateikennung zusammen; es gibt keine Abfrage allein ueber die Dateikennung.
        const result = await db.query<BoardAssetRow>(
          `select ${BOARD_ASSET_COLUMNS} from board_assets where board_id = $1 and file_id = $2`,
          [boardId, fileId],
        )
        const row = result.rows[0]
        return row === undefined ? null : toBoardAsset(row)
      },

      async record(asset: NewBoardAsset): Promise<BoardAsset> {
        const result = await db.query<BoardAssetRow>(
          `insert into board_assets
             (board_id, workspace_id, file_id, file_name, mime_type, byte_size, checksum_sha256, storage_key)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning ${BOARD_ASSET_COLUMNS}`,
          [
            asset.boardId,
            asset.workspaceId,
            asset.fileId,
            asset.fileName,
            asset.mimeType,
            asset.byteSize,
            asset.checksumSha256,
            asset.storageKey,
          ],
        )
        return toBoardAsset(requireRow(result.rows[0], 'Assetdatensatz konnte nicht angelegt werden'))
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
