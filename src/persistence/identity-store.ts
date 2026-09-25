/**
 * PostgreSQL-Umsetzung der Identity-Repository-Ports.
 *
 * Einzige Stelle des Identity-Moduls, die SQL kennt. Die Domain bleibt frei von Datenbanktypen; hier wird
 * ausschliesslich zwischen Zeilen und Domain-Objekten uebersetzt.
 */

import type { Pool, PoolClient } from 'pg'

import type { AppearanceView } from '../contracts/api.js'
import { parseAppearance } from '../contracts/api.js'

import type {
  InvitationPurpose,
  LocalCredential,
  UserInvitation,
  UserInvitationId,
} from '../domain/identity/local-auth.js'
import type {
  AuthenticatedSession,
  ExternalIdentity,
  ExternalIdentityId,
  ExternalIdentityKey,
  Session,
  SessionId,
  SignedInSession,
  User,
  UserId,
  UserStatus,
} from '../domain/identity/model.js'
import { authenticate, signedIn } from '../domain/identity/model.js'
import type { TotpFactor } from '../domain/identity/second-factor.js'
import type { RecoveryEmailToken, RecoveryEmailTokenPurpose, SelfRecovery } from '../domain/identity/self-recovery.js'
import type { UserProfileDraft } from '../domain/identity/provisioning.js'
import type {
  IdentityStore,
  LinkedIdentity,
  NewInvitation,
  NewRecoveryEmailToken,
  NewSession,
} from '../domain/identity/repositories.js'
import { IdentityConflictError } from '../domain/identity/repositories.js'

type Queryable = Pick<PoolClient, 'query'>

/** SQLSTATE einer verletzten Eindeutigkeit. */
const UNIQUE_VIOLATION = '23505'

/**
 * Frei gewaehlte, projektweit feste Kennung der Bootstrap-Sperre. Sie serialisiert ausschliesslich die Frage
 * "hat diese Instanz schon einen Systemadmin?" und liegt bewusst neben der Kennung des Migrationslocks.
 */
const BOOTSTRAP_LOCK_ID = 4_711_020_602

/** Uebersetzt eine verletzte Eindeutigkeit in den fachlichen Konflikt; jeder andere Fehler bleibt, wie er ist. */
async function conflictAware<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION) {
      throw new IdentityConflictError(error)
    }
    throw error
  }
}

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
  second_factor_verified_at: Date | null
}

type TotpFactorRow = {
  user_id: string
  secret_sealed: string | null
  confirmed_at: Date | null
  // `bigint` kommt aus `pg` als Zeichenkette.
  last_used_step: string | null
  pending_sealed: string | null
  pending_created_at: Date | null
}

type CredentialRow = {
  user_id: string
  password_hash: string
  must_change_password: boolean
  updated_at: Date
}

type InvitationRow = {
  id: string
  user_id: string
  purpose: string
  created_by_user_id: string | null
  created_at: Date
  expires_at: Date
  redeemed_at: Date | null
  revoked_at: Date | null
}

type SelfRecoveryRow = {
  user_id: string
  allowed: boolean
  email: string | null
  verified_at: Date | null
}

type RecoveryEmailTokenRow = {
  id: string
  user_id: string
  purpose: string
  email: string
  created_at: Date
  expires_at: Date
  redeemed_at: Date | null
  revoked_at: Date | null
}

const SELF_RECOVERY_COLUMNS = 'user_id, allowed, email, verified_at'
const RECOVERY_TOKEN_COLUMNS = 'id, user_id, purpose, email, created_at, expires_at, redeemed_at, revoked_at'

function toSelfRecovery(row: SelfRecoveryRow): SelfRecovery {
  return { userId: row.user_id, allowed: row.allowed, email: row.email, verifiedAt: row.verified_at }
}

function toRecoveryEmailToken(row: RecoveryEmailTokenRow): RecoveryEmailToken {
  return {
    id: row.id,
    userId: row.user_id,
    // Der Check-Constraint laesst nur diese beiden Werte zu.
    purpose: row.purpose as RecoveryEmailTokenPurpose,
    email: row.email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    revokedAt: row.revoked_at,
  }
}

const USER_COLUMNS = 'id, display_name, email, status, is_system_admin, created_at, updated_at'
const IDENTITY_COLUMNS = 'id, user_id, issuer, subject, created_at, last_seen_at'
const SESSION_COLUMNS = 'id, user_id, created_at, expires_at, revoked_at, second_factor_verified_at'
const TOTP_COLUMNS = 'user_id, secret_sealed, confirmed_at, last_used_step, pending_sealed, pending_created_at'

/** Sitzung samt Nutzer in einer Abfrage; beides entscheidet gemeinsam ueber die Gueltigkeit. */
const SESSION_WITH_USER = `select s.id, s.user_id, s.created_at, s.expires_at, s.revoked_at, s.second_factor_verified_at,
                  u.display_name, u.email, u.status, u.is_system_admin,
                  u.created_at as user_created_at, u.updated_at as user_updated_at
           from sessions s
           join users u on u.id = s.user_id`

type SessionWithUserRow = SessionRow & UserRow & { user_created_at: Date; user_updated_at: Date }

function userOfSessionRow(row: SessionWithUserRow): User {
  return toUser({
    id: row.user_id,
    display_name: row.display_name,
    email: row.email,
    status: row.status,
    is_system_admin: row.is_system_admin,
    created_at: row.user_created_at,
    updated_at: row.user_updated_at,
  })
}

function toTotpFactor(row: TotpFactorRow): TotpFactor {
  return {
    userId: row.user_id,
    secretSealed: row.secret_sealed,
    confirmedAt: row.confirmed_at,
    lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step),
    pendingSealed: row.pending_sealed,
    pendingCreatedAt: row.pending_created_at,
  }
}
const CREDENTIAL_COLUMNS = 'user_id, password_hash, must_change_password, updated_at'
const INVITATION_COLUMNS = 'id, user_id, purpose, created_by_user_id, created_at, expires_at, redeemed_at, revoked_at'

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

function toCredential(row: CredentialRow): LocalCredential {
  return {
    userId: row.user_id,
    passwordHash: row.password_hash,
    mustChangePassword: row.must_change_password,
    updatedAt: row.updated_at,
  }
}

function toInvitation(row: InvitationRow): UserInvitation {
  return {
    id: row.id,
    userId: row.user_id,
    // Der Check-Constraint laesst nur diese beiden Werte zu.
    purpose: row.purpose as InvitationPurpose,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    revokedAt: row.revoked_at,
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    secondFactorVerifiedAt: row.second_factor_verified_at,
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

      async findByEmail(email: string): Promise<User | null> {
        const result = await db.query<UserRow>(`select ${USER_COLUMNS} from users where email = $1`, [email])
        const row = result.rows[0]
        return row === undefined ? null : toUser(row)
      },

      async count(): Promise<number> {
        const result = await db.query<{ count: number }>('select count(*)::int as count from users')
        return requireRow(result.rows[0], 'count lieferte keine Zeile').count
      },

      async hasSystemAdmin(): Promise<boolean> {
        return (await store.users.listSystemAdmins()).length > 0
      },

      async listSystemAdmins(): Promise<readonly User[]> {
        if (!inTransaction) {
          // Ausserhalb einer Transaktion gaebe die Sperre die Serialisierung sofort wieder her und die
          // Antwort waere wertlos. Das ist ein Programmierfehler, kein Betriebszustand.
          throw new Error('Die Systemadminfrage ist nur innerhalb einer Transaktion gueltig')
        }
        // Die Sperre haelt bis zum Commit: ein gleichzeitiger Bootstrap wartet hier und sieht danach den
        // bereits angelegten Systemadmin. Ohne sie lesen unter READ COMMITTED beide eine leere Tabelle.
        // Dieselbe Sperre serialisiert die Wiederherstellung - gegen sich selbst und gegen den Bootstrap.
        await db.query('select pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_ID])
        const result = await db.query<UserRow>(
          `select ${USER_COLUMNS} from users where is_system_admin order by created_at, id`,
        )
        return result.rows.map(toUser)
      },

      async list(): Promise<readonly User[]> {
        const result = await db.query<UserRow>(`select ${USER_COLUMNS} from users order by created_at, id`)
        return result.rows.map(toUser)
      },

      async create(profile: UserProfileDraft, options: { readonly isSystemAdmin: boolean }): Promise<User> {
        const result = await conflictAware(() =>
          db.query<UserRow>(
            `insert into users (display_name, email, is_system_admin)
             values ($1, $2, $3)
             returning ${USER_COLUMNS}`,
            [profile.displayName, profile.email, options.isSystemAdmin],
          ),
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

      async existsForUser(userId: UserId): Promise<boolean> {
        const result = await db.query('select 1 from external_identities where user_id = $1 limit 1', [userId])
        return (result.rowCount ?? 0) > 0
      },

      async link(userId: UserId, key: ExternalIdentityKey): Promise<ExternalIdentity> {
        const result = await conflictAware(() =>
          db.query<ExternalIdentityRow>(
            `insert into external_identities (user_id, issuer, subject)
             values ($1, $2, $3)
             returning ${IDENTITY_COLUMNS}`,
            [userId, key.issuer, key.subject],
          ),
        )
        return toExternalIdentity(requireRow(result.rows[0], 'Identitaet konnte nicht verknuepft werden'))
      },

      async markSeen(id: ExternalIdentityId, seenAt: Date): Promise<void> {
        await db.query('update external_identities set last_seen_at = $2 where id = $1', [id, seenAt])
      },
    },

    localCredentials: {
      async findByUserId(userId: UserId): Promise<LocalCredential | null> {
        const result = await db.query<CredentialRow>(
          `select ${CREDENTIAL_COLUMNS} from local_credentials where user_id = $1`,
          [userId],
        )
        const row = result.rows[0]
        return row === undefined ? null : toCredential(row)
      },

      async set(
        userId: UserId,
        passwordHash: string,
        options: { readonly mustChangePassword: boolean },
      ): Promise<void> {
        await db.query(
          `insert into local_credentials (user_id, password_hash, must_change_password)
           values ($1, $2, $3)
           on conflict (user_id) do update
             set password_hash = excluded.password_hash,
                 must_change_password = excluded.must_change_password,
                 updated_at = now()`,
          [userId, passwordHash, options.mustChangePassword],
        )
      },

      async listUserIds(): Promise<readonly UserId[]> {
        const result = await db.query<{ user_id: string }>('select user_id from local_credentials')
        return result.rows.map((row) => row.user_id)
      },

      async requireChange(userId: UserId, passwordHash: string): Promise<void> {
        await db.query(
          `update local_credentials set must_change_password = true, updated_at = now()
           where user_id = $1 and password_hash = $2`,
          [userId, passwordHash],
        )
      },
    },

    loginThrottle: {
      async hit(keyHash: string, now: Date, windowStart: Date): Promise<number> {
        // Abgelaufene Fenster aller Konten zuerst, das eigene eingeschlossen: danach beginnt der Versuch
        // entweder ein neues Fenster oder zaehlt im laufenden weiter. Die Tabelle waechst so nie ueber die
        // Konten hinaus, die im laufenden Fenster versucht wurden.
        await db.query('delete from login_throttle where window_started_at < $1', [windowStart])
        const result = await db.query<{ attempts: number }>(
          `insert into login_throttle (key_hash, attempts, window_started_at)
           values ($1, 1, $2)
           on conflict (key_hash) do update set attempts = login_throttle.attempts + 1
           returning attempts`,
          [keyHash, now],
        )
        return requireRow(result.rows[0], 'Anmeldeversuch konnte nicht gezaehlt werden').attempts
      },

      async clear(keyHash: string): Promise<void> {
        await db.query('delete from login_throttle where key_hash = $1', [keyHash])
      },
    },

    appearances: {
      async findByUserId(userId: UserId): Promise<AppearanceView | null> {
        const result = await db.query<{ color_scheme: string; accent: string }>(
          'select color_scheme, accent from user_appearance where user_id = $1',
          [userId],
        )
        const row = result.rows[0]
        // Die Check-Constraints lassen nur die Werte des Vertrags zu; ein Wert, den diese Fassung nicht mehr
        // kennt, faellt still auf die Standardwahl zurueck statt die Anmeldung zu brechen.
        return row === undefined ? null : parseAppearance({ colorScheme: row.color_scheme, accent: row.accent })
      },

      async set(userId: UserId, appearance: AppearanceView): Promise<void> {
        await db.query(
          `insert into user_appearance (user_id, color_scheme, accent)
           values ($1, $2, $3)
           on conflict (user_id) do update
             set color_scheme = excluded.color_scheme,
                 accent = excluded.accent,
                 updated_at = now()`,
          [userId, appearance.colorScheme, appearance.accent],
        )
      },
    },

    invitations: {
      async create(invitation: NewInvitation): Promise<UserInvitation> {
        const result = await conflictAware(() =>
          db.query<InvitationRow>(
            `insert into user_invitations (user_id, token_hash, created_by_user_id, expires_at, purpose)
             values ($1, $2, $3, $4, $5)
             returning ${INVITATION_COLUMNS}`,
            [
              invitation.userId,
              invitation.tokenHash,
              invitation.createdByUserId,
              invitation.expiresAt,
              invitation.purpose ?? 'invitation',
            ],
          ),
        )
        return toInvitation(requireRow(result.rows[0], 'Einladung konnte nicht angelegt werden'))
      },

      async findByTokenHash(tokenHash: string): Promise<UserInvitation | null> {
        // `for update`: die Zeile bleibt bis zum Commit gesperrt. Zwei gleichzeitige Einloesungen desselben
        // Werts laufen damit nacheinander, und die zweite findet die bereits eingeloeste Zeile vor.
        const result = await db.query<InvitationRow>(
          `select ${INVITATION_COLUMNS} from user_invitations where token_hash = $1 for update`,
          [tokenHash],
        )
        const row = result.rows[0]
        return row === undefined ? null : toInvitation(row)
      },

      async markRedeemed(id: UserInvitationId, redeemedAt: Date): Promise<boolean> {
        const result = await db.query(
          `update user_invitations set redeemed_at = $2
           where id = $1 and redeemed_at is null and revoked_at is null`,
          [id, redeemedAt],
        )
        return (result.rowCount ?? 0) === 1
      },

      async revokeOpenForUser(userId: UserId, revokedAt: Date): Promise<number> {
        const result = await db.query(
          `update user_invitations set revoked_at = $2
           where user_id = $1 and redeemed_at is null and revoked_at is null`,
          [userId, revokedAt],
        )
        return result.rowCount ?? 0
      },

      async listOpen(now: Date): Promise<readonly UserInvitation[]> {
        const result = await db.query<InvitationRow>(
          `select ${INVITATION_COLUMNS} from user_invitations
           where redeemed_at is null and revoked_at is null and expires_at > $1
           order by created_at desc`,
          [now],
        )
        return result.rows.map(toInvitation)
      },
    },

    sessions: {
      async create(session: NewSession): Promise<Session> {
        const result = await db.query<SessionRow>(
          `insert into sessions (user_id, token_hash, expires_at, second_factor_verified_at)
           values ($1, $2, $3, $4)
           returning ${SESSION_COLUMNS}`,
          [session.userId, session.tokenHash, session.expiresAt, session.secondFactorVerifiedAt ?? null],
        )
        return toSession(requireRow(result.rows[0], 'Session konnte nicht angelegt werden'))
      },

      async findAuthenticatedByTokenHash(tokenHash: string, now: Date): Promise<AuthenticatedSession | null> {
        const result = await db.query<SessionWithUserRow>(`${SESSION_WITH_USER} where s.token_hash = $1`, [tokenHash])
        const row = result.rows[0]
        // Die Gueltigkeitsregel steht in der Domain, nicht in der Where-Klausel: eine Definition, ein Ort.
        return row === undefined ? null : authenticate(toSession(row), userOfSessionRow(row), now)
      },

      async findSignedInByTokenHash(tokenHash: string, now: Date): Promise<SignedInSession | null> {
        const result = await db.query<SessionWithUserRow>(`${SESSION_WITH_USER} where s.token_hash = $1`, [tokenHash])
        const row = result.rows[0]
        return row === undefined ? null : signedIn(toSession(row), userOfSessionRow(row), now)
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

      async findLiveIds(ids: readonly SessionId[], now: Date): Promise<ReadonlySet<SessionId>> {
        if (ids.length === 0) {
          return new Set()
        }
        const result = await db.query<SessionWithUserRow>(`${SESSION_WITH_USER} where s.id = any($1::uuid[])`, [ids])
        const live = new Set<SessionId>()
        for (const row of result.rows) {
          // Dieselbe Regel wie bei der Aufloesung eines Cookies: eine Definition, ein Ort.
          if (authenticate(toSession(row), userOfSessionRow(row), now) !== null) {
            live.add(row.id)
          }
        }
        return live
      },

      async deleteExpired(before: Date): Promise<number> {
        const result = await db.query('delete from sessions where expires_at < $1', [before])
        return result.rowCount ?? 0
      },
    },

    secondFactors: {
      async findTotp(userId: UserId): Promise<TotpFactor | null> {
        const result = await db.query<TotpFactorRow>(`select ${TOTP_COLUMNS} from user_totp_factors where user_id = $1`, [
          userId,
        ])
        const row = result.rows[0]
        return row === undefined ? null : toTotpFactor(row)
      },

      async beginTotp(userId: UserId, pendingSealed: string, now: Date): Promise<void> {
        await db.query(
          `insert into user_totp_factors (user_id, pending_sealed, pending_created_at)
           values ($1, $2, $3)
           on conflict (user_id) do update
             set pending_sealed = excluded.pending_sealed,
                 pending_created_at = excluded.pending_created_at,
                 updated_at = now()`,
          [userId, pendingSealed, now],
        )
      },

      async activateTotp(userId: UserId, pendingSealed: string, step: number, now: Date): Promise<boolean> {
        // Die Bedingung auf den offenen Wert macht die Aktivierung einmalig: ein gleichzeitiger zweiter
        // Vorgang oder eine inzwischen ersetzte Einrichtung findet keine Zeile mehr.
        const result = await db.query(
          `update user_totp_factors
             set secret_sealed = pending_sealed, confirmed_at = $4, last_used_step = $3,
                 pending_sealed = null, pending_created_at = null, updated_at = now()
           where user_id = $1 and pending_sealed = $2`,
          [userId, pendingSealed, step, now],
        )
        return (result.rowCount ?? 0) === 1
      },

      async useTotpStep(userId: UserId, step: number): Promise<boolean> {
        // Atomar: von zwei gleichzeitigen Anmeldungen mit demselben Code gewinnt genau eine.
        const result = await db.query(
          `update user_totp_factors set last_used_step = $2, updated_at = now()
           where user_id = $1 and secret_sealed is not null and (last_used_step is null or last_used_step < $2)`,
          [userId, step],
        )
        return (result.rowCount ?? 0) === 1
      },

      async replaceBackupCodes(userId: UserId, codeHashes: readonly string[]): Promise<void> {
        await db.query('delete from user_backup_codes where user_id = $1', [userId])
        await db.query(
          `insert into user_backup_codes (user_id, code_hash)
           select $1, unnest($2::text[])`,
          [userId, codeHashes],
        )
      },

      async useBackupCode(userId: UserId, codeHash: string, now: Date): Promise<boolean> {
        const result = await db.query(
          `update user_backup_codes set used_at = $3
           where user_id = $1 and code_hash = $2 and used_at is null`,
          [userId, codeHash, now],
        )
        return (result.rowCount ?? 0) === 1
      },

      async countUnusedBackupCodes(userId: UserId): Promise<number> {
        const result = await db.query<{ count: number }>(
          'select count(*)::int as count from user_backup_codes where user_id = $1 and used_at is null',
          [userId],
        )
        return requireRow(result.rows[0], 'count lieferte keine Zeile').count
      },

      async removeAll(userId: UserId): Promise<void> {
        await db.query('delete from user_backup_codes where user_id = $1', [userId])
        await db.query('delete from user_totp_factors where user_id = $1', [userId])
      },
    },

    selfRecovery: {
      async find(userId: UserId): Promise<SelfRecovery | null> {
        const result = await db.query<SelfRecoveryRow>(
          `select ${SELF_RECOVERY_COLUMNS} from user_self_recovery where user_id = $1`,
          [userId],
        )
        const row = result.rows[0]
        return row === undefined ? null : toSelfRecovery(row)
      },

      async findForUpdate(userId: UserId): Promise<SelfRecovery | null> {
        const result = await db.query<SelfRecoveryRow>(
          `select ${SELF_RECOVERY_COLUMNS} from user_self_recovery where user_id = $1 for update`,
          [userId],
        )
        const row = result.rows[0]
        return row === undefined ? null : toSelfRecovery(row)
      },

      async list(): Promise<readonly SelfRecovery[]> {
        const result = await db.query<SelfRecoveryRow>(`select ${SELF_RECOVERY_COLUMNS} from user_self_recovery`)
        return result.rows.map(toSelfRecovery)
      },

      async setAllowed(userId: UserId, allowed: boolean): Promise<void> {
        await db.query(
          `insert into user_self_recovery (user_id, allowed) values ($1, $2)
           on conflict (user_id) do update set allowed = excluded.allowed, updated_at = now()`,
          [userId, allowed],
        )
      },

      async setVerifiedEmail(userId: UserId, email: string, verifiedAt: Date): Promise<void> {
        await db.query(
          `update user_self_recovery set email = $2, verified_at = $3, updated_at = now() where user_id = $1`,
          [userId, email, verifiedAt],
        )
      },

      async createToken(token: NewRecoveryEmailToken): Promise<RecoveryEmailToken> {
        const result = await db.query<RecoveryEmailTokenRow>(
          `insert into recovery_email_tokens (user_id, purpose, email, token_hash, expires_at)
           values ($1, $2, $3, $4, $5)
           returning ${RECOVERY_TOKEN_COLUMNS}`,
          [token.userId, token.purpose, token.email, token.tokenHash, token.expiresAt],
        )
        return toRecoveryEmailToken(requireRow(result.rows[0], 'Link konnte nicht angelegt werden'))
      },

      async findTokenByHash(tokenHash: string): Promise<RecoveryEmailToken | null> {
        // `for update` wie bei der Einladung: gleichzeitige Einloesungen laufen nacheinander.
        const result = await db.query<RecoveryEmailTokenRow>(
          `select ${RECOVERY_TOKEN_COLUMNS} from recovery_email_tokens where token_hash = $1 for update`,
          [tokenHash],
        )
        const row = result.rows[0]
        return row === undefined ? null : toRecoveryEmailToken(row)
      },

      async markTokenRedeemed(id: string, redeemedAt: Date): Promise<boolean> {
        const result = await db.query(
          `update recovery_email_tokens set redeemed_at = $2
           where id = $1 and redeemed_at is null and revoked_at is null`,
          [id, redeemedAt],
        )
        return (result.rowCount ?? 0) === 1
      },

      async findOpenToken(
        userId: UserId,
        purpose: RecoveryEmailTokenPurpose,
        now: Date,
      ): Promise<RecoveryEmailToken | null> {
        const result = await db.query<RecoveryEmailTokenRow>(
          `select ${RECOVERY_TOKEN_COLUMNS} from recovery_email_tokens
           where user_id = $1 and purpose = $2 and redeemed_at is null and revoked_at is null and expires_at > $3
           order by created_at desc
           limit 1`,
          [userId, purpose, now],
        )
        const row = result.rows[0]
        return row === undefined ? null : toRecoveryEmailToken(row)
      },

      async revokeOpenTokens(userId: UserId, revokedAt: Date, purpose?: RecoveryEmailTokenPurpose): Promise<number> {
        const result = await db.query(
          `update recovery_email_tokens set revoked_at = $2
           where user_id = $1 and redeemed_at is null and revoked_at is null and ($3::text is null or purpose = $3)`,
          [userId, revokedAt, purpose ?? null],
        )
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
