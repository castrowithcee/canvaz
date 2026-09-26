/**
 * Fachliche Identitaetsmodelle.
 *
 * Reiner Domain-Core: keine Datenbank, kein HTTP, kein OIDC. Die zentrale Trennung dieses Moduls ist, dass
 * die externe Anmeldung (`ExternalIdentity`) und das fachliche Benutzerprofil (`User`) zwei verschiedene
 * Dinge sind. Ein Nutzer behaelt Profil, Status und Rolle, auch wenn sich die externe Anmeldung aendert.
 */

export type UserId = string
export type SessionId = string
export type ExternalIdentityId = string

export type UserStatus = 'active' | 'deactivated'

export type User = {
  readonly id: UserId
  readonly displayName: string
  readonly email: string | null
  readonly status: UserStatus
  /** Einzige Rolle dieses Pakets. Weitere Rollen haengen an Workspaces und folgen spaeter. */
  readonly isSystemAdmin: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

export function isUserActive(user: User): boolean {
  return user.status === 'active'
}

/** Eindeutige Zuordnung einer externen Anmeldung. Issuer und Subject kommen aus dem verifizierten Token. */
export type ExternalIdentityKey = {
  readonly issuer: string
  readonly subject: string
}

export type ExternalIdentity = ExternalIdentityKey & {
  readonly id: ExternalIdentityId
  readonly userId: UserId
  readonly createdAt: Date
  readonly lastSeenAt: Date
}

/**
 * Serverseitige Session. Sie enthaelt bewusst kein Tokenmaterial des Identity Providers und auch nicht das
 * Session-Geheimnis selbst: gespeichert wird nur dessen Hash, damit ein Datenbankleck keine Sitzung uebernimmt.
 */
export type Session = {
  readonly id: SessionId
  readonly userId: UserId
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly revokedAt: Date | null
}

/** Session-Sicht ohne Nutzerbezug: nicht widerrufen und nicht abgelaufen. */
export function isSessionLive(session: Session, now: Date): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime()
}

export type AuthenticatedSession = {
  readonly session: Session
  readonly user: User
}

/**
 * Invariante des Pakets: eine gueltige Session setzt eine lebende Session UND einen aktiven Nutzer voraus.
 * Ein deaktivierter Nutzer kann keine gueltige Session haben, auch wenn die Zeile in der Datenbank noch
 * existiert. Jeder Guard entscheidet ueber diese Funktion, damit es nur eine Definition von "angemeldet" gibt.
 */
export function authenticate(session: Session, user: User, now: Date): AuthenticatedSession | null {
  if (session.userId !== user.id || !isSessionLive(session, now) || !isUserActive(user)) {
    return null
  }
  return { session, user }
}
