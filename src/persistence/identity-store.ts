/**
 * PostgreSQL-Umsetzung der Identity-Repository-Ports.
 *
 * Einzige Stelle des Identity-Moduls, die SQL kennt. Die Domain bleibt frei von Datenbanktypen; hier wird
 * ausschliesslich zwischen Zeilen und Domain-Objekten uebersetzt.
 */

import type { Pool, PoolClient } from 'pg'

import type {
  AuthenticatedSession,
  ExternalIdentity,
  ExternalIdentityId,
  ExternalIdentityKey,
  Session,
  SessionId,
  User,
  UserId,
  UserStatus,
} from '../domain/identity/model.js'
import { authenticate } from '../domain/identity/model.js'
import type { UserProfileDraft } from '../domain/identity/provisioning.js'
import type { IdentityStore, LinkedIdentity, NewSession } from '../domain/identity/repositories.js'

type Queryable = Pick<PoolClient, 'query'>

type UserRow = {
  id: string
  display_name: string
  email: string | null
  status: string
  is_system_admin: boolean
  created_at: Date
  updated_at: Date
}

type ExternalIdentityRow = {
  id: string
  user_id: string
  issuer: string
  subject: string
  created_at: Date
  last_seen_at: Date
}

type SessionRow = {
  id: string
  user_id: string
  created_at: Date
  expires_at: Date
  revoked_at: Date | null
}

const USER_COLUMNS = 'id, display_name, email, status, is_system_admin, created_at, updated_at'
const IDENTITY_COLUMNS = 'id, user_id, issuer, subject, created_at, last_seen_at'
const SESSION_COLUMNS = 'id, user_id, created_at, expires_at, revoked_at'

function toUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    // Der Check-Constraint laesst nur diese beiden Werte zu.
    status: row.status as UserStatus,
    isSystemAdmin: row.is_system_admin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toExternalIdentity(row: ExternalIdentityRow): ExternalIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    issuer: row.issuer,
    subject: row.subject,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) {
    throw new Error(message)
  }
  return row
}

function createStore(pool: Pool, db: Queryable, inTransaction: boolean): IdentityStore {
  const store: IdentityStore = {
    users: {
      async findById(id: UserId): Promise<User | null> {
        const result = await db.query<UserRow>(`select ${USER_COLUMNS} from users where id = $1`, [id])
        const row = result.rows[0]
        return row === undefined ? null : toUser(row)
      },

      async count(): Promise<number> {
        const result = await db.query<{ count: number }>('select count(*)::int as count from users')
        return requireRow(result.rows[0], 'count lieferte keine Zeile').count
      },

      async create(profile: UserProfileDraft, options: { readonly isSystemAdmin: boolean }): Promise<User> {
        const result = await db.query<UserRow>(
          `insert into users (display_name, email, is_system_admin)
           values ($1, $2, $3)
           returning ${USER_COLUMNS}`,
          [profile.displayName, profile.email, options.isSystemAdmin],
        )
        return toUser(requireRow(result.rows[0], 'Nutzer konnte nicht angelegt werden'))
      },

      async updateProfile(id: UserId, profile: UserProfileDraft): Promise<User> {
        const result = await db.query<UserRow>(
          `update users set display_name = $2, email = $3, updated_at = now()
           where id = $1
           returning ${USER_COLUMNS}`,
          [id, profile.displayName, profile.email],
        )
        return toUser(requireRow(result.rows[0], `Unbekannter Nutzer ${id}`))
      },

      async setStatus(id: UserId, status: UserStatus): Promise<User> {
        const result = await db.query<UserRow>(
          `update users set status = $2, updated_at = now()
           where id = $1
           returning ${USER_COLUMNS}`,
          [id, status],
        )
        return toUser(requireRow(result.rows[0], `Unbekannter Nutzer ${id}`))
      },
    },

    externalIdentities: {
      async findByKey(key: ExternalIdentityKey): Promise<LinkedIdentity | null> {
        const result = await db.query<ExternalIdentityRow & UserRow & { user_created_at: Date; user_updated_at: Date }>(
          `select i.id, i.user_id, i.issuer, i.subject, i.created_at, i.last_seen_at,
                  u.display_name, u.email, u.status, u.is_system_admin,
                  u.created_at as user_created_at, u.updated_at as user_updated_at
           from external_identities i
           join users u on u.id = i.user_id
           where i.issuer = $1 and i.subject = $2`,
          [key.issuer, key.subject],
        )
        const row = result.rows[0]
        if (row === undefined) {
          return null
        }
        return {
          identity: toExternalIdentity(row),
          user: toUser({
            id: row.user_id,
            display_name: row.display_name,
            email: row.email,
            status: row.status,
            is_system_admin: row.is_system_admin,
            created_at: row.user_created_at,
            updated_at: row.user_updated_at,
          }),
        }
      },

      async link(userId: UserId, key: ExternalIdentityKey): Promise<ExternalIdentity> {
        const result = await db.query<ExternalIdentityRow>(
          `insert into external_identities (user_id, issuer, subject)
           values ($1, $2, $3)
           returning ${IDENTITY_COLUMNS}`,
          [userId, key.issuer, key.subject],
        )
        return toExternalIdentity(requireRow(result.rows[0], 'Identitaet konnte nicht verknuepft werden'))
      },

      async markSeen(id: ExternalIdentityId, seenAt: Date): Promise<void> {
        await db.query('update external_identities set last_seen_at = $2 where id = $1', [id, seenAt])
      },
    },

    sessions: {
      async create(session: NewSession): Promise<Session> {
        const result = await db.query<SessionRow>(
          `insert into sessions (user_id, token_hash, expires_at)
           values ($1, $2, $3)
           returning ${SESSION_COLUMNS}`,
          [session.userId, session.tokenHash, session.expiresAt],
        )
        return toSession(requireRow(result.rows[0], 'Session konnte nicht angelegt werden'))
      },

      async findAuthenticatedByTokenHash(tokenHash: string, now: Date): Promise<AuthenticatedSession | null> {
        const result = await db.query<SessionRow & UserRow & { user_created_at: Date; user_updated_at: Date }>(
          `select s.id, s.user_id, s.created_at, s.expires_at, s.revoked_at,
                  u.display_name, u.email, u.status, u.is_system_admin,
                  u.created_at as user_created_at, u.updated_at as user_updated_at
           from sessions s
           join users u on u.id = s.user_id
           where s.token_hash = $1`,
          [tokenHash],
        )
        const row = result.rows[0]
        if (row === undefined) {
          return null
        }
        const user = toUser({
          id: row.user_id,
          display_name: row.display_name,
          email: row.email,
          status: row.status,
          is_system_admin: row.is_system_admin,
          created_at: row.user_created_at,
          updated_at: row.user_updated_at,
        })
        // Die Gueltigkeitsregel steht in der Domain, nicht in der Where-Klausel: eine Definition, ein Ort.
        return authenticate(toSession(row), user, now)
      },

      async revoke(id: SessionId, revokedAt: Date): Promise<void> {
        await db.query('update sessions set revoked_at = $2 where id = $1 and revoked_at is null', [id, revokedAt])
      },

      async revokeAllForUser(userId: UserId, revokedAt: Date): Promise<void> {
        await db.query('update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null', [
          userId,
          revokedAt,
        ])
      },

      async deleteExpired(before: Date): Promise<number> {
        const result = await db.query('delete from sessions where expires_at < $1', [before])
        return result.rowCount ?? 0
      },
    },

    async transaction<T>(run: (transactional: IdentityStore) => Promise<T>): Promise<T> {
      if (inTransaction) {
        // Verschachtelte Aufrufe teilen die aeussere Transaktion; Savepoints braucht bisher niemand.
        return run(store)
      }
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await run(createStore(pool, client, true))
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

export function createIdentityStore(pool: Pool): IdentityStore {
  return createStore(pool, pool, false)
}
