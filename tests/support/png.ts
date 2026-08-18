/**
 * Erzeugt ein echtes PNG fuer die Browsertests.
 *
 * Bewusst erzeugt statt als Binaerdatei versioniert: eine Bilddatei im Repository waere ein Artefakt ohne
 * lesbaren Diff. PNG ist einfach genug, um es aus `node:zlib` zusammenzusetzen - und nur ein echtes,
 * dekodierbares Bild beweist, dass der Browser es am Ende wirklich darstellt.
 */

import { crc32, deflateSync } from 'node:zlib'

function chunk(type: string, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, checksum])
}

/** Einfarbiges RGB-PNG ohne Alphakanal. */
export function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // Bittiefe
  header[9] = 2 // Farbtyp: Truecolor
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const zeile = y * (1 + width * 3)
    // Filterbyte 0: keine Vorhersage. Danach die Bildpunkte.
    for (let x = 0; x < width; x += 1) {
      raw[zeile + 1 + x * 3] = rgb[0]
      raw[zeile + 2 + x * 3] = rgb[1]
      raw[zeile + 3 + x * 3] = rgb[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
