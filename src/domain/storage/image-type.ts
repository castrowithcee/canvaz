/**
 * Erkennung des tatsaechlichen Bildtyps.
 *
 * **Der behauptete Typ des Clients entscheidet nichts.** Content-Type-Kopf und Dateiendung sind frei
 * waehlbar; geprueft wird der Inhalt. Erst wenn die ersten Bytes eines erlaubten Formats erkannt werden und
 * mit der Behauptung uebereinstimmen, wird die Datei angenommen.
 *
 * Reine Funktionen ohne IO, damit die Pruefung ohne Server und ohne Datenbank nachweisbar ist.
 *
 * SVG fehlt bewusst: es ist ein Dokument mit Skript- und Verweisfaehigkeit, kein Rasterbild. Es aus einer
 * Instanz auszuliefern, die auch Sitzungen fuehrt, waere eine eigene Entscheidung mit eigener Absicherung.
 */

export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

export function isAllowedImageType(value: unknown): value is AllowedImageType {
  return typeof value === 'string' && (ALLOWED_IMAGE_TYPES as readonly string[]).includes(value)
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) {
    return false
  }
  return signature.every((byte, index) => bytes[index] === byte)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) {
    return ''
  }
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const GIF_PREFIXES = ['GIF87a', 'GIF89a']

/**
 * Tatsaechlicher Typ der Bytes oder `null`, wenn es keines der erlaubten Formate ist.
 *
 * Bewusst kein Rateverfahren ueber den ganzen Inhalt: nur die eindeutigen Signaturen am Anfang. Was hier
 * nicht erkannt wird, wird abgelehnt - im Zweifel gegen die Annahme.
 */
export function sniffImageType(bytes: Uint8Array): AllowedImageType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return 'image/png'
  }
  if (startsWith(bytes, JPEG_SIGNATURE)) {
    return 'image/jpeg'
  }
  if (GIF_PREFIXES.includes(ascii(bytes, 0, 6))) {
    return 'image/gif'
  }
  // WebP ist ein RIFF-Container; erst das Formatfeld ab Byte 8 macht ihn eindeutig.
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp'
  }
  return null
}
