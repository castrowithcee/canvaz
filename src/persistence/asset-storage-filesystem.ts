/**
 * Dateisystem-Adapter des Storage-Ports.
 *
 * Schreibt ausschliesslich unterhalb eines konfigurierten Wurzelverzeichnisses. Im Betrieb ist das ein
 * persistentes Volume - der Containerlayer waere keine Persistenz, deshalb gibt es fuer
 * `CANVAZ_STORAGE_FILESYSTEM_ROOT` bewusst keinen Standardwert.
 *
 * **Atomar geschrieben:** die Bytes gehen zuerst vollstaendig in eine temporaere Datei im selben
 * Verzeichnis und werden dann per `rename` an ihren Platz gezogen. Ein abgebrochener Schreibvorgang
 * hinterlaesst deshalb nie eine halbe Datei unter dem gueltigen Schluessel.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

import type { AssetStoragePort } from '../domain/storage/asset-storage-port.js'
import { InvalidStorageKeyError, assertStorageKey } from '../domain/storage/asset-storage-port.js'

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

export function createFilesystemAssetStorage(root: string): AssetStoragePort {
  const base = resolve(root)

  /**
   * Zweite, unabhaengige Absicherung neben `assertStorageKey`: der aufgeloeste Pfad muss unterhalb der
   * Wurzel liegen. Eine Zeichenkettenpruefung allein wuerde Symlinks und Plattformbesonderheiten glauben.
   */
  function pathOf(key: string): string {
    const target = resolve(base, assertStorageKey(key))
    if (!target.startsWith(base + sep)) {
      throw new InvalidStorageKeyError(key)
    }
    return target
  }

  return {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      const target = pathOf(key)
      const directory = dirname(target)
      await mkdir(directory, { recursive: true })
      // Im Zielverzeichnis, damit `rename` innerhalb desselben Dateisystems bleibt und wirklich atomar ist.
      const temporary = `${target}.${randomUUID()}.part`
      try {
        await writeFile(temporary, bytes, { flag: 'wx' })
        await rename(temporary, target)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    },

    async get(key: string): Promise<Uint8Array | null> {
      try {
        return await readFile(pathOf(key))
      } catch (error) {
        if (isMissing(error)) {
          return null
        }
        throw error
      }
    },

    async delete(key: string): Promise<void> {
      await rm(pathOf(key), { force: true })
    },
  }
}
