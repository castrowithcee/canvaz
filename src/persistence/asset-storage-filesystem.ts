/**
 * Dateisystem-Adapter des Storage-Ports.
 *
 * Schreibt unterhalb eines konfigurierten Wurzelverzeichnisses; dort gehalten wird der Pfad allein durch die
 * gepruefte Form des Schluessels (`assertStorageKey`). Im Betrieb ist die Wurzel ein persistentes Volume -
 * der Containerlayer waere keine Persistenz, deshalb gibt es fuer `CANVAZ_STORAGE_FILESYSTEM_ROOT` bewusst
 * keinen Standardwert.
 *
 * **Atomar geschrieben:** die Bytes gehen zuerst vollstaendig in eine temporaere Datei im selben
 * Verzeichnis und werden dann per `rename` an ihren Platz gezogen. Ein abgebrochener Schreibvorgang
 * hinterlaesst deshalb nie eine halbe Datei unter dem gueltigen Schluessel.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { AssetStoragePort } from '../domain/storage/asset-storage-port.js'
import { assertStorageKey } from '../domain/storage/asset-storage-port.js'

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

export function createFilesystemAssetStorage(root: string): AssetStoragePort {
  const base = resolve(root)

  /**
   * **Die Grenze ist `assertStorageKey`, und nur sie.** Der erlaubte Zeichenvorrat kennt weder `..` noch
   * einen fuehrenden `/`, deshalb kann ein geprueftes Schluesselsegment den Pfad gar nicht erst aus der
   * Wurzel herausfuehren.
   *
   * Eine zweite Praefixpruefung auf dem aufgeloesten Pfad stand hier einmal als vermeintlich unabhaengige
   * Absicherung. Sie war keine: `resolve` loest Symlinks nicht auf, ein Verzeichnis-Symlink unterhalb der
   * Wurzel haette sie unbemerkt passiert. Wirksam waere nur eine Aufloesung ueber `realpath` je Zugriff -
   * gegen einen Angreifer, der bereits im Volume schreiben kann und damit ohnehin an den Bytes ist. Eine
   * Pruefung, die nicht wirkt, ist schlechter als keine, weil sie Sicherheit behauptet.
   */
  function pathOf(key: string): string {
    return resolve(base, assertStorageKey(key))
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
