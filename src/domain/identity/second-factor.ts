/**
 * Zweiter Faktor des Systemadmins.
 *
 * Reiner Domain-Core: keine Datenbank, kein HTTP, keine Kryptografie. Hier stehen Zustand und Regeln;
 * Verschluesselung des Geheimnisses und Pruefung eines Codes liegen im Server (`src/server/second-factor.ts`).
 *
 * Ein Faktor hat zwei Haelften: das **aktive** Geheimnis, gegen das jede Anmeldung geprueft wird, und eine
 * **angefangene** Einrichtung, die erst mit einem gueltigen Code aktiv wird. Bis dahin gilt das bisherige
 * Geheimnis - oder keines. Beide liegen ausschliesslich verschluesselt vor; das Modell traegt deshalb nur
 * den versiegelten Wert und nie ein Geheimnis im Klartext.
 */

import type { UserId } from './model.js'

export type TotpFactor = {
  readonly userId: UserId
  /** Versiegeltes aktives Geheimnis; `null` heisst: kein aktiver Faktor. */
  readonly secretSealed: string | null
  readonly confirmedAt: Date | null
  /**
   * Zeitschritt des zuletzt angenommenen Codes. Ein Code aus demselben oder einem frueheren Schritt wird
   * abgelehnt - der Schutz gegen das Wiederholen eines mitgelesenen Codes.
   */
  readonly lastUsedStep: number | null
  /** Versiegeltes Geheimnis einer angefangenen Einrichtung; `null` heisst: keine offen. */
  readonly pendingSealed: string | null
  readonly pendingCreatedAt: Date | null
}

export function hasActiveTotp(factor: TotpFactor | null): factor is TotpFactor & { readonly secretSealed: string } {
  return factor?.secretSealed !== null && factor?.secretSealed !== undefined
}

/**
 * Frist einer angefangenen Einrichtung.
 *
 * Zehn Minuten reichen, um eine App zu oeffnen und den Schluessel einzutragen. Laenger soll ein
 * angefangener Wechsel nicht offen stehen: er beruht bei einem vorhandenen Faktor auf einer frischen
 * Bestaetigung, und die ist nach einer Kaffeepause nicht mehr frisch.
 */
export const ENROLLMENT_TTL_MINUTES = 10

export function isEnrollmentOpen(factor: TotpFactor | null, now: Date): factor is TotpFactor & { readonly pendingSealed: string } {
  return (
    factor !== null &&
    factor.pendingSealed !== null &&
    factor.pendingCreatedAt !== null &&
    now.getTime() - factor.pendingCreatedAt.getTime() < ENROLLMENT_TTL_MINUTES * 60_000
  )
}

/** Zahl der Ersatzcodes je Ausgabe. Jede neue Ausgabe ersetzt alle bisherigen. */
export const BACKUP_CODE_COUNT = 10
