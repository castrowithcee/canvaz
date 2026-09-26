/**
 * Gemeinsame Contract-Testsuite des Storage-Ports.
 *
 * **Das Kernartefakt dieses Pakets.** Es gibt genau eine Suite - `assetStorageContract` -, und sie laeuft
 * unveraendert gegen beide Adapter: gegen das Dateisystem und gegen ein echtes SeaweedFS. Innerhalb der
 * Suite gibt es keine Fallunterscheidung, keine Bedingung und keinen Adapternamen; sie kennt ausschliesslich
 * `AssetStoragePort`. Genau das ist der Nachweis, dass die beiden Adapter denselben fachlichen Vertrag
 * erfuellen und ein Konfigurationswechsel nichts an der Bedeutung aendert.
 *
 * Der s3-Adapter wird nicht gegen eine Attrappe geprueft: eine selbst gebaute Signatur waere gegen eine
 * Attrappe wertlos. Er spricht mit dem SeaweedFS aus `compose.yml`, das echte AWS-Signaturen prueft (siehe
 * die Gegenprobe mit falschem Geheimnis unten).
 */

import { readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AssetStoragePort } from '../../src/domain/storage/asset-storage-port.js'
import { InvalidStorageKeyError } from '../../src/domain/storage/asset-storage-port.js'
import { createFilesystemAssetStorage } from '../../src/persistence/asset-storage-filesystem.js'
import { createS3AssetStorage, ensureS3Bucket } from '../../src/persistence/asset-storage-s3.js'
import { MISSING_TEST_S3_HINT, TEST_S3, createFilesystemRoot } from '../support/asset-storage-env.js'

/** Frischer Schluesselraum je Testfall, damit die Faelle einander nicht sehen. */
let laufendeNummer = 0
function frischerSchluessel(): string {
  laufendeNummer += 1
  return `boards/contract-${String(process.pid)}-${String(laufendeNummer)}/inhalt.bin`
}

/** Alle 256 Bytewerte: was hier verlustfrei zurueckkommt, ist wirklich ein Byte-Speicher. */
const ALLE_BYTES = new Uint8Array(Array.from({ length: 256 }, (_, index) => index))

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/* ---------------------------------------------------------------------------------------------------- */
/* Die eine Suite                                                                                        */
/* ---------------------------------------------------------------------------------------------------- */

function assetStorageContract(storage: () => AssetStoragePort): void {
  it('gibt abgelegte Bytes unveraendert zurueck', async () => {
    const key = frischerSchluessel()

    await storage().put(key, ALLE_BYTES)

    const gelesen = await storage().get(key)
    expect(gelesen).not.toBeNull()
    expect(Array.from(gelesen ?? [])).toEqual(Array.from(ALLE_BYTES))
  })

  it('meldet einen unbekannten Schluessel als nicht vorhanden, statt zu scheitern', async () => {
    expect(await storage().get(frischerSchluessel())).toBeNull()
  })

  it('ersetzt einen vorhandenen Inhalt vollstaendig', async () => {
    const key = frischerSchluessel()
    await storage().put(key, bytes('ein deutlich laengerer erster Inhalt'))

    await storage().put(key, bytes('kurz'))

    expect(new TextDecoder().decode(await storage().get(key) ?? new Uint8Array(0))).toBe('kurz')
  })

  it('haelt Schluessel mit gemeinsamem Praefix auseinander', async () => {
    const basis = frischerSchluessel()
    await storage().put(`${basis}.eins`, bytes('eins'))
    await storage().put(`${basis}.zwei`, bytes('zwei'))

    expect(new TextDecoder().decode(await storage().get(`${basis}.eins`) ?? new Uint8Array(0))).toBe('eins')
    expect(new TextDecoder().decode(await storage().get(`${basis}.zwei`) ?? new Uint8Array(0))).toBe('zwei')
  })

  it('entfernt einen Schluessel und vertraegt das Entfernen eines unbekannten', async () => {
    const key = frischerSchluessel()
    await storage().put(key, bytes('vergaenglich'))

    await storage().delete(key)

    expect(await storage().get(key)).toBeNull()
    await expect(storage().delete(key)).resolves.toBeUndefined()
    await expect(storage().delete(frischerSchluessel())).resolves.toBeUndefined()
  })

  it('traegt auch eine Datei in Uploadgroesse verlustfrei', async () => {
    const key = frischerSchluessel()
    const gross = new Uint8Array(2 * 1024 * 1024)
    for (let index = 0; index < gross.length; index += 1) {
      gross[index] = (index * 31) % 256
    }

    await storage().put(key, gross)

    const gelesen = await storage().get(key)
    expect(gelesen?.byteLength).toBe(gross.byteLength)
    expect(Buffer.from(gelesen ?? new Uint8Array(0)).equals(Buffer.from(gross))).toBe(true)
  })

  it('nimmt keinen Schluessel an, der aus seinem Namensraum ausbricht', async () => {
    for (const key of ['../ausbruch', 'boards/../../etc/passwd', '/absolut', '', 'boards//leer']) {
      await expect(storage().get(key), key).rejects.toBeInstanceOf(InvalidStorageKeyError)
      await expect(storage().put(key, bytes('x')), key).rejects.toBeInstanceOf(InvalidStorageKeyError)
      await expect(storage().delete(key), key).rejects.toBeInstanceOf(InvalidStorageKeyError)
    }
  })

  it('haelt einen abgelegten Inhalt ueber eine neue Adapterinstanz hinweg', async () => {
    const key = frischerSchluessel()
    await storage().put(key, bytes('bleibt'))

    // `storage()` liefert bei jedem Aufruf eine frisch gebaute Instanz: der Zustand liegt ausserhalb des
    // Prozesses, nicht in einem Feld des Adapters.
    expect(new TextDecoder().decode(await storage().get(key) ?? new Uint8Array(0))).toBe('bleibt')
  })
}

/* ---------------------------------------------------------------------------------------------------- */
/* Dieselbe Suite, zweimal ausgefuehrt                                                                   */
/* ---------------------------------------------------------------------------------------------------- */

let dateisystemWurzel = ''

beforeAll(async () => {
  dateisystemWurzel = await createFilesystemRoot()
  try {
    await ensureS3Bucket(TEST_S3)
  } catch (error) {
    throw new Error(MISSING_TEST_S3_HINT, { cause: error })
  }
})

afterAll(async () => {
  await rm(dateisystemWurzel, { recursive: true, force: true })
})

describe('Storage-Port, Adapter filesystem', () => {
  assetStorageContract(() => createFilesystemAssetStorage(dateisystemWurzel))
})

describe('Storage-Port, Adapter s3 (SeaweedFS)', () => {
  assetStorageContract(() => createS3AssetStorage(TEST_S3))
})

/* ---------------------------------------------------------------------------------------------------- */
/* Gegenprobe: SeaweedFS prueft die Signatur wirklich                                                    */
/* ---------------------------------------------------------------------------------------------------- */

describe('s3-Adapter, Gegenprobe auf die Signaturpruefung', () => {
  it('lehnt einen Zugriff mit falschem Geheimnis ab', async () => {
    const falscheZugangsdaten = createS3AssetStorage({ ...TEST_S3, secretAccessKey: 'ein-falsches-geheimnis' })

    await expect(falscheZugangsdaten.put(frischerSchluessel(), bytes('darf nicht ankommen'))).rejects.toThrow()
  })
})

/* ---------------------------------------------------------------------------------------------------- */
/* Was der Dateisystem-Adapter darueber hinaus zusagt - und was nicht                                     */
/* ---------------------------------------------------------------------------------------------------- */

describe('Dateisystem-Adapter, Grenze des Namensraums', () => {
  it('setzt die Grenze allein ueber den Schluessel durch und loest Symlinks nicht auf', async () => {
    const wurzel = await createFilesystemRoot()
    const daneben = await createFilesystemRoot()
    try {
      const storage = createFilesystemAssetStorage(wurzel)
      // Ein Verzeichnis-Symlink unterhalb der Wurzel. Nur wer bereits Schreibzugriff auf das Volume hat,
      // kann ihn anlegen - ueber die Anwendung entsteht er nie.
      await symlink(daneben, join(wurzel, 'boards'), 'dir')

      await storage.put('boards/inhalt.bin', bytes('folgt dem Symlink'))

      // Festgehaltenes Verhalten: der Adapter folgt ihm. Die Wurzel ist eine Konfigurationszusage, keine
      // Sandbox gegen den Betreiber des Volumes.
      expect(new TextDecoder().decode(await readFile(join(daneben, 'inhalt.bin')))).toBe('folgt dem Symlink')

      // Die wirksame Grenze ist der Schluessel: ein Ausbruch ist gar nicht erst formulierbar.
      await expect(storage.get('../daneben/inhalt.bin')).rejects.toBeInstanceOf(InvalidStorageKeyError)
      await expect(storage.put('/absolut', bytes('x'))).rejects.toBeInstanceOf(InvalidStorageKeyError)
    } finally {
      await rm(wurzel, { recursive: true, force: true })
      await rm(daneben, { recursive: true, force: true })
    }
  })
})
