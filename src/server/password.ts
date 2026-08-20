/**
 * Passworthashing.
 *
 * Verfahren ist **scrypt** aus `node:crypto`: ein fuer Passwoerter gebautes, speicherhartes Verfahren, das
 * die Standardbibliothek mitbringt. Eine native Abhaengigkeit (argon2, bcrypt) waere die einzige des
 * Projekts mit Kompilierschritt und braechte fuer diese Instanz keinen belegbaren Vorteil.
 *
 * Der gespeicherte Wert traegt seine Parameter selbst:
 *
 * ```
 * scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
 * ```
 *
 * Damit bleibt ein bereits gespeicherter Hash pruefbar, auch wenn die Parameter spaeter steigen - der
 * Vergleich liest sie aus der Zeile und nicht aus dem Code. Das Passwort selbst wird nirgends gespeichert,
 * nirgends protokolliert und steht in keiner Antwort.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Kostenparameter.
 *
 * `N = 2^15` mit `r = 8`, `p = 1` braucht 32 MiB Speicher und rund hundert Millisekunden je Pruefung. Das
 * ist die Groessenordnung, die eine Anmeldung vertraegt, ohne dass eine Instanz dieser Groesse (bis zu
 * dreissig Konten, ein Anwendungsprozess) an ihren eigenen Anmeldungen erstickt - und zugleich weit ueber
 * dem, was einen Wortlistenangriff auf einen erbeuteten Hash lohnend macht.
 */
const COST = 2 ** 15
const BLOCK_SIZE = 8
const PARALLELIZATION = 1
const KEY_LENGTH = 32
const SALT_BYTES = 16

/** scrypt verlangt ausdruecklich Speicher jenseits seines eigenen Bedarfs; sonst bricht es mit Fehler ab. */
const MAX_MEMORY = 256 * 1024 * 1024

const PREFIX = 'scrypt'

type ScryptParameters = {
  readonly cost: number
  readonly blockSize: number
  readonly parallelization: number
}

/**
 * Einzige Definition davon, wann zwei Eingaben **dasselbe** Passwort sind.
 *
 * Normalisiert wird, damit dieselbe Eingabe auch dann denselben Schluessel ergibt, wenn ein anderes System
 * dieselben Zeichen anders zusammensetzt (etwa Umlaute als Kombination). Genau deshalb muss jeder Vergleich
 * ueber dieselbe Form laufen: ein roher Zeichenvergleich haelt zwei Eingaben auseinander, die das Verfahren
 * danach auf denselben Hash abbildet - und ein "Wechsel" auf ein NFKC-gleiches Passwort waere gar keiner.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC')
}

/** Gleichheit im Sinne des Verfahrens, nicht im Sinne der Zeichenkette. */
export function isSamePassword(one: string, other: string): boolean {
  return normalizePassword(one) === normalizePassword(other)
}

async function derive(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      normalizePassword(password),
      salt,
      KEY_LENGTH,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelization,
        maxmem: MAX_MEMORY,
      },
      (error, key) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve(key)
      },
    )
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, {
    cost: COST,
    blockSize: BLOCK_SIZE,
    parallelization: PARALLELIZATION,
  })
  return [
    PREFIX,
    String(COST),
    String(BLOCK_SIZE),
    String(PARALLELIZATION),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$')
}

function parse(
  stored: string,
): { readonly parameters: ScryptParameters; readonly salt: Buffer; readonly key: Buffer } | null {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== PREFIX) {
    return null
  }
  const [, cost, blockSize, parallelization, salt, key] = parts as [string, string, string, string, string, string]
  const parameters = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelization: Number(parallelization),
  }
  if (!Object.values(parameters).every((value) => Number.isInteger(value) && value > 0)) {
    return null
  }
  return { parameters, salt: Buffer.from(salt, 'base64url'), key: Buffer.from(key, 'base64url') }
}

/**
 * Prueft ein Passwort gegen einen gespeicherten Hash.
 *
 * Ein unlesbarer Hash ist `false` und kein Fehler: er kann nur durch eine fremde Schreibung entstehen, und
 * eine Anmeldung darauf abzulehnen ist die einzige richtige Antwort.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored)
  if (parsed === null) {
    return false
  }
  const key = await derive(password, parsed.salt, parsed.parameters)
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key)
}
