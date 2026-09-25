/**
 * Zweiter Faktor: TOTP, Versiegelung des Geheimnisses und Ersatzcodes.
 *
 * **Keine eigene OTP-Kryptografie.** Erzeugung und Pruefung eines Codes (RFC 6238) uebernimmt `otpauth`
 * (MIT, gepflegt, eine Abhaengigkeit: `@noble/hashes`). Dieses Modul legt nur die Parameter fest und
 * uebersetzt die Antwort in einen Zeitschritt, gegen den die Persistenz eine Wiederholung ablehnt.
 *
 * Parameter: SHA-1, sechs Stellen, 30 Sekunden - das, was jede verbreitete Authenticator-App ohne
 * Rueckfrage versteht. Angenommen wird der aktuelle Schritt und je einer davor und danach (uebliche
 * Uhrabweichung); mehr Toleranz hiesse mehr gueltige Codes je Rateversuch.
 *
 * Das Geheimnis liegt ausschliesslich mit AES-256-GCM versiegelt vor (`node:crypto`), gebunden an das Konto
 * als zusaetzliche Authentisierungsdaten: ein zwischen Konten vertauschtes Chiffrat laesst sich nicht
 * oeffnen. Ersatzcodes liegen ausschliesslich als HMAC-SHA-256 mit einem aus demselben Schluessel
 * abgeleiteten Schluessel vor - ohne ihn ist aus einer Zeile nicht einmal offline pruefbar, ob ein
 * geratener Code stimmt.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

import { Secret, TOTP } from 'otpauth'

import { BACKUP_CODE_COUNT } from '../domain/identity/second-factor.js'
import type { UserId } from '../domain/identity/model.js'

const ISSUER = 'Canvaz'
const ALGORITHM = 'SHA1'
const DIGITS = 6
const PERIOD_SECONDS = 30
/** Ein Schritt vor und zurueck. */
const WINDOW = 1
/** 160 Bit, die Laenge des HMAC-SHA-1 selbst (RFC 4226, 4). */
const SECRET_BYTES = 20

export function createTotpSecret(): string {
  return new Secret({ size: SECRET_BYTES }).base32
}

/** Adresse fuer die Authenticator-App. Sie traegt das Geheimnis und erscheint genau einmal, bei der Einrichtung. */
export function totpUri(secretBase32: string, accountLabel: string): string {
  return new TOTP({
    issuer: ISSUER,
    label: accountLabel,
    secret: Secret.fromBase32(secretBase32),
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD_SECONDS,
  }).toString()
}

/**
 * Prueft einen sechsstelligen Code und liefert den Zeitschritt, zu dem er gehoert. `null` heisst: passt zu
 * keinem Schritt im Fenster.
 */
export function matchTotpCode(secretBase32: string, code: string, now: Date): number | null {
  const timestamp = now.getTime()
  const delta = TOTP.validate({
    token: code,
    secret: Secret.fromBase32(secretBase32),
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD_SECONDS,
    timestamp,
    window: WINDOW,
  })
  return delta === null ? null : TOTP.counter({ period: PERIOD_SECONDS, timestamp }) + delta
}

const SEAL_VERSION = 'v1'
const IV_BYTES = 12

function associatedData(userId: UserId): Buffer {
  return Buffer.from(`canvaz:totp:${userId}`, 'utf8')
}

/** Versiegelt ein Geheimnis fuer genau dieses Konto: `v1.<iv>.<chiffrat>.<tag>`, jeweils base64url. */
export function sealSecret(key: Buffer, userId: UserId, secret: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(associatedData(userId))
  const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [SEAL_VERSION, iv, sealed, cipher.getAuthTag()]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.')
}

/**
 * Oeffnet ein versiegeltes Geheimnis. `null` heisst: nicht mit diesem Schluessel, nicht fuer dieses Konto
 * oder beschaedigt - fuer den Aufrufer ist das ein Betriebsproblem und kein falscher Code.
 */
export function openSecret(key: Buffer, userId: UserId, sealed: string): string | null {
  const [version, iv, data, tag] = sealed.split('.')
  if (version !== SEAL_VERSION || iv === undefined || data === undefined || tag === undefined) {
    return null
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    decipher.setAAD(associatedData(userId))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * Zeichen eines Ersatzcodes: 32 Zeichen ohne die verwechselbaren `0`, `1`, `I` und `O`. Zehn davon sind
 * 50 Bit - bei der gemeinsamen Drosselung mit TOTP ist das online nicht zu erraten, und offline fehlt der
 * Schluessel des HMAC.
 */
const BACKUP_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const BACKUP_CODE_LENGTH = 10

/** Neue Ersatzcodes in der Anzeigeform `XXXXX-XXXXX`. Sie erscheinen genau einmal, in dieser Antwort. */
export function createBackupCodes(): string[] {
  const codes = new Set<string>()
  while (codes.size < BACKUP_CODE_COUNT) {
    // 256 ist ein Vielfaches von 32: jedes Zeichen ist gleich wahrscheinlich.
    const chars = [...randomBytes(BACKUP_CODE_LENGTH)].map((byte) => BACKUP_ALPHABET[byte % 32] ?? '')
    codes.add(`${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`)
  }
  return [...codes]
}

function backupKey(key: Buffer): Buffer {
  return createHmac('sha256', key).update('canvaz:backup-codes').digest()
}

/** Hash eines normalisierten Ersatzcodes. Nur er wird gespeichert und verglichen. */
export function hashBackupCode(key: Buffer, normalized: string): string {
  return createHmac('sha256', backupKey(key)).update(normalized).digest('hex')
}

/** Hashes einer frischen Ausgabe; die Anzeigeform ist dieselbe Eingabe wie beim spaeteren Einloesen. */
export function hashIssuedBackupCodes(key: Buffer, codes: readonly string[]): string[] {
  return codes.map((code) => hashBackupCode(key, code.replace('-', '')))
}

/** Eine Eingabe im Feld des zweiten Faktors: sechs Ziffern sind TOTP, sonst vielleicht ein Ersatzcode. */
export type SecondFactorInput =
  | { readonly kind: 'totp'; readonly code: string }
  | { readonly kind: 'backup-code'; readonly normalized: string }

/**
 * Liest eine Eingabe grosszuegig: Leerraum und Bindestriche zaehlen nicht, Kleinschreibung auch nicht. `null`
 * heisst: weder ein TOTP-Code noch ein moeglicher Ersatzcode.
 */
export function parseSecondFactorInput(raw: unknown): SecondFactorInput | null {
  if (typeof raw !== 'string') {
    return null
  }
  const compact = raw.replace(/[\s-]/g, '').toUpperCase()
  if (/^\d{6}$/.test(compact)) {
    return { kind: 'totp', code: compact }
  }
  if (compact.length === BACKUP_CODE_LENGTH && [...compact].every((char) => BACKUP_ALPHABET.includes(char))) {
    return { kind: 'backup-code', normalized: compact }
  }
  return null
}
