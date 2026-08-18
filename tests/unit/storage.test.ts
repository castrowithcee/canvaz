/**
 * Schluesselnamensraum und Inhaltserkennung des Assetpakets.
 *
 * Beides sind reine Funktionen und beides sind Grenzen gegen Eingaben von aussen: der Schluessel darf nie
 * aus seinem Namensraum ausbrechen, und der behauptete Typ einer Datei darf nie ihr tatsaechlicher sein.
 */

import { describe, expect, it } from 'vitest'

import {
  InvalidStorageKeyError,
  assertStorageKey,
  buildAssetStorageKey,
} from '../../src/domain/storage/asset-storage-port.js'
import { ALLOWED_IMAGE_TYPES, isAllowedImageType, sniffImageType } from '../../src/domain/storage/image-type.js'

const BOARD_ID = '11111111-2222-4333-8444-555555555555'
const CHECKSUM = 'a'.repeat(64)

describe('Speicherschluessel', () => {
  it('nimmt genau die Form an, die der Server selbst bildet', () => {
    expect(buildAssetStorageKey(BOARD_ID, 'datei-1', CHECKSUM)).toBe(`boards/${BOARD_ID}/datei-1/${CHECKSUM}`)
    expect(assertStorageKey('a')).toBe('a')
    expect(assertStorageKey('boards/x-1/y_2.bin')).toBe('boards/x-1/y_2.bin')
  })

  it('trennt zwei Dateikennungen mit identischem Inhalt', () => {
    // `board_assets` fuehrt einen Datensatz je Dateikennung und verlangt den Schluessel eindeutig. Ohne die
    // Kennung im Schluessel wuerden beide Datensaetze dieselben Bytes meinen und einander loeschen koennen.
    expect(buildAssetStorageKey(BOARD_ID, 'erste', CHECKSUM)).not.toBe(
      buildAssetStorageKey(BOARD_ID, 'zweite', CHECKSUM),
    )
    // Dieselbe Datei im selben Board bleibt derselbe Schluessel: ein Wiederholungsversuch ueberschreibt sich.
    expect(buildAssetStorageKey(BOARD_ID, 'erste', CHECKSUM)).toBe(buildAssetStorageKey(BOARD_ID, 'erste', CHECKSUM))
  })

  it('weist jeden Ausbruch aus dem Namensraum zurueck', () => {
    for (const key of [
      '',
      '/absolut',
      'boards//leer',
      '../geheim',
      'boards/../../etc/passwd',
      'boards/./hier',
      'boards/.versteckt',
      'boards/mit leerzeichen',
      'boards/mit%2Fkodierung',
      'boards/mit\\rueckwaerts',
      'boards/ende/',
      'a'.repeat(513),
    ]) {
      expect(() => assertStorageKey(key), key).toThrow(InvalidStorageKeyError)
    }
  })
})

/** Nur die Signatur zaehlt; der Rest der Datei ist fuer die Erkennung ohne Bedeutung. */
function withSignature(signature: readonly number[] | string, tail = 'beliebiger inhalt'): Uint8Array {
  const head = typeof signature === 'string' ? [...signature].map((char) => char.charCodeAt(0)) : signature
  return new Uint8Array([...head, ...[...tail].map((char) => char.charCodeAt(0))])
}

describe('Bildtyp aus dem Inhalt', () => {
  it('erkennt genau die erlaubten Formate', () => {
    expect(sniffImageType(withSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffImageType(withSignature([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(withSignature('GIF87a'))).toBe('image/gif')
    expect(sniffImageType(withSignature('GIF89a'))).toBe('image/gif')
    expect(sniffImageType(withSignature('RIFF0000WEBPVP8 '))).toBe('image/webp')
  })

  it('erkennt nichts, was kein erlaubtes Bild ist', () => {
    // Ein Skript mit PNG-Endung bleibt ein Skript: die Signatur passt nicht.
    expect(sniffImageType(withSignature('<script>alert(1)</script>'))).toBeNull()
    expect(sniffImageType(withSignature('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
    expect(sniffImageType(withSignature('%PDF-1.7'))).toBeNull()
    // RIFF ohne WEBP-Formatfeld ist ein anderer Containerinhalt, etwa eine WAV-Datei.
    expect(sniffImageType(withSignature('RIFF0000WAVEfmt '))).toBeNull()
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull()
    expect(sniffImageType(new Uint8Array(0))).toBeNull()
  })

  it('kennt als erlaubt genau die vier Rasterformate und kein Dokumentformat', () => {
    expect([...ALLOWED_IMAGE_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    expect(isAllowedImageType('image/png')).toBe(true)
    // SVG ist ein Dokument mit Skriptfaehigkeit und bewusst nicht dabei.
    expect(isAllowedImageType('image/svg+xml')).toBe(false)
    expect(isAllowedImageType('application/octet-stream')).toBe(false)
    expect(isAllowedImageType(undefined)).toBe(false)
  })
})
