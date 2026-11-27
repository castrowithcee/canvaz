/**
 * Oeffentliche Gastfreigaben eines Boards.
 *
 * Reiner Domain-Core: keine Datenbank, kein HTTP. Ein **Freigabelink** oeffnet genau ein Board fuer
 * Externe, die kein Konto dieser Instanz haben. Er ist damit die einzige Stelle, an der Boardinhalt ohne
 * Workspace-Mitgliedschaft erreichbar wird - und deshalb bewusst eng geschnitten:
 *
 * - Ein Link gehoert zu **genau einem Board** und traegt genau eine Gastrolle.
 * - Das Token existiert nur im Klartext beim Erzeugen; gespeichert wird ausschliesslich sein Hash - genau
 *   wie beim Sitzungsgeheimnis. Ein Leseleck der Datenbank oeffnet damit kein Board.
 * - Ablauf und Widerruf sind zwei getrennte Zustaende und beide **wirksam bei jeder Aufloesung**: es gibt
 *   keinen zwischengespeicherten Gastzugriff, der sie ueberdauern koennte.
 *
 * Aus einem Link entsteht beim Beitritt eine **Gastsession**. Sie ist kurzlebig, serverseitig, widerrufbar
 * und ebenfalls nur als Hash gespeichert. Sie ist an genau das Board ihres Links gebunden; eine Gastsession
 * fuer ein anderes Board gibt es nicht und kann es strukturell nicht geben.
 */

import type { BoardId } from './model.js'

export type BoardShareLinkId = string
export type GuestSessionId = string

/**
 * Rolle eines Gastes auf genau einem Board.
 *
 * Bewusst eigene Werte statt `viewer`/`editor`: eine Gastrolle ist keine Boardrolle und darf mit ihr auch
 * nicht verwechselbar sein - weder in der Datenbank noch in einer Antwort. `guest-viewer` liest,
 * `guest-editor` liest und speichert die Szene. Mehr gibt es nicht: Umbenennen, Archivieren,
 * Freigabeverwaltung und Ownerschaft bleiben einem Gast in jedem Fall verwehrt.
 */
export type GuestRole = 'guest-viewer' | 'guest-editor'

export const GUEST_ROLES: readonly GuestRole[] = ['guest-viewer', 'guest-editor']

/**
 * `guest-viewer` ist der Standard: eine Freigabe nach aussen gibt so wenig wie moeglich, und
 * Schreibrecht ist eine bewusste, ausdrueckliche Entscheidung des Owners.
 */
export const DEFAULT_GUEST_ROLE: GuestRole = 'guest-viewer'

export function parseGuestRole(raw: unknown): GuestRole | null {
  return GUEST_ROLES.find((candidate) => candidate === raw) ?? null
}

/** Ein Gast darf lesen; schreiben darf nur der ausdruecklich gewaehlte `guest-editor`. */
export function guestMayWrite(role: GuestRole): boolean {
  return role === 'guest-editor'
}

/**
 * Ein Freigabelink.
 *
 * `tokenHash` steht bewusst **nicht** in diesem Modell: der Hash ist eine Sache der Persistenz und des
 * Aufloesens, und was nicht im Modell steht, kann auch nicht versehentlich in eine Antwort geraten.
 */
export type BoardShareLink = {
  readonly id: BoardShareLinkId
  readonly boardId: BoardId
  readonly role: GuestRole
  /** Anzeigename des Erzeugers zum Zeitpunkt der Anlage; `null`, wenn der Nutzer entfernt wurde. */
  readonly createdByUserId: string | null
  readonly createdAt: Date
  /** `null` heisst: laeuft nicht von selbst ab. Er endet dann ausschliesslich durch Widerruf. */
  readonly expiresAt: Date | null
  readonly revokedAt: Date | null
}

/** Kurzlebige Sitzung eines Gastes, gueltig fuer genau ein Board. */
export type GuestSession = {
  readonly id: GuestSessionId
  readonly shareLinkId: BoardShareLinkId
  readonly boardId: BoardId
  /** Selbst gewaehlt beim Beitritt. Rein beschreibend und ohne jede Berechtigungswirkung. */
  readonly displayName: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly revokedAt: Date | null
}

/**
 * Aufgeloeste Gastsession samt der Rolle ihres Links.
 *
 * Beides gehoert zusammen: die Rolle steht am Link und wird bei **jeder** Aufloesung frisch gelesen, damit
 * ein Widerruf und ein Ablauf sofort wirken und nicht erst beim naechsten Beitritt.
 */
export type AuthenticatedGuest = {
  readonly session: GuestSession
  readonly role: GuestRole
}

/**
 * Invariante des Pakets: ein Link traegt nur dann Zugriff, wenn er weder widerrufen noch abgelaufen ist.
 *
 * Wie `isSessionLive` fuer die interne Sitzung eine reine Funktion - damit es genau eine Definition von
 * "gueltiger Link" gibt und die Datenbankabfrage sie nicht ein zweites Mal formulieren muss.
 */
export function isShareLinkLive(link: Pick<BoardShareLink, 'expiresAt' | 'revokedAt'>, now: Date): boolean {
  return link.revokedAt === null && (link.expiresAt === null || link.expiresAt.getTime() > now.getTime())
}

/** Dieselbe Regel fuer die Gastsession; sie hat immer einen Ablaufzeitpunkt. */
export function isGuestSessionLive(session: Pick<GuestSession, 'expiresAt' | 'revokedAt'>, now: Date): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime()
}

export const MAX_GUEST_DISPLAY_NAME_LENGTH = 60

/**
 * Anzeigename eines Gastes. `null` bedeutet: leer oder zu lang.
 *
 * Er kommt von aussen und von einem Unbekannten. Steuerzeichen fliegen raus, Leerraum wird
 * zusammengezogen - der Name landet im Teilnehmerfeld anderer Bearbeiter und darf dort nichts anrichten.
 */
export function normalizeGuestDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  let cleaned = ''
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0
    if (code > 0x1f && code !== 0x7f) {
      cleaned += character
    }
  }
  const name = cleaned.trim().replace(/\s+/g, ' ')
  return name.length === 0 || name.length > MAX_GUEST_DISPLAY_NAME_LENGTH ? null : name
}

/**
 * Bounds of a share link expiry relative to the server time: 15 minutes to 365 days.
 *
 * Without an upper bound "expires" would be a promise that never comes true. The owner can still create a
 * link without expiry explicitly - then revocation is its only end, and the list says so.
 */
export const MIN_SHARE_LINK_LIFETIME_MS = 15 * 60_000
export const MAX_SHARE_LINK_LIFETIME_MS = 365 * 86_400_000

// Requires an explicit offset: a bare local time would be read in the server's zone.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** `undefined` means: no expiry wanted. `null` means: the value is unusable or outside the bounds. */
export function parseShareLinkExpiry(raw: unknown, now: Date): Date | null | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }
  if (typeof raw !== 'string' || !ISO_WITH_OFFSET.test(raw)) {
    return null
  }
  const expiresAt = new Date(raw)
  const lifetime = expiresAt.getTime() - now.getTime()
  if (Number.isNaN(lifetime) || lifetime < MIN_SHARE_LINK_LIFETIME_MS || lifetime > MAX_SHARE_LINK_LIFETIME_MS) {
    return null
  }
  return expiresAt
}

/**
 * Lebensdauer einer Gastsession: vier Stunden.
 *
 * Bewusst kuerzer als die interne Sitzung und bewusst keine Betriebsschraube. Ein Gast arbeitet an einer
 * Besprechung oder einem Entwurf mit; danach soll sein Zugang von selbst enden, ohne dass jemand daran
 * denken muss. Wer laenger braucht, oeffnet den Link erneut - solange er gilt.
 */
export const GUEST_SESSION_TTL_SECONDS = 4 * 3600

/**
 * Ablauf einer neuen Gastsession.
 *
 * **Eine Gastsession ueberlebt ihren Link nie.** Laeuft der Link frueher ab, endet auch sie frueher; ohne
 * das waere der Ablauf des Links durch einen Beitritt kurz davor zu verlaengern.
 */
export function guestSessionExpiry(now: Date, link: Pick<BoardShareLink, 'expiresAt'>): Date {
  const own = new Date(now.getTime() + GUEST_SESSION_TTL_SECONDS * 1000)
  if (link.expiresAt !== null && link.expiresAt.getTime() < own.getTime()) {
    return link.expiresAt
  }
  return own
}
