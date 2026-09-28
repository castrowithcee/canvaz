/**
 * Auswahl des Storage-Adapters.
 *
 * **Die einzige Stelle, an der die Wahl zwischen `filesystem` und `s3` faellt.** Alles darueber - Routen,
 * Domain, Datenbank - kennt nur `AssetStoragePort`. Ein Adapterwechsel ist deshalb ausschliesslich eine
 * Aenderung der Laufzeitkonfiguration und beruehrt keine Zeile Fachlogik.
 */

import type { AssetStorageAdapter, AssetStoragePort } from '../domain/storage/asset-storage-port.js'
import { createFilesystemAssetStorage } from './asset-storage-filesystem.js'
import type { S3StorageConfig } from './asset-storage-s3.js'
import { createS3AssetStorage } from './asset-storage-s3.js'

export type AssetStorageSettings = {
  readonly adapter: AssetStorageAdapter
  readonly filesystem: { readonly root: string } | null
  readonly s3: S3StorageConfig | null
}

export function createAssetStorage(settings: AssetStorageSettings): AssetStoragePort {
  if (settings.adapter === 's3') {
    if (settings.s3 === null) {
      // `loadConfig` laesst diesen Zustand nicht entstehen; hier steht er als letzte Absicherung.
      throw new Error('Storage-Adapter s3 ohne S3-Konfiguration')
    }
    return createS3AssetStorage(settings.s3)
  }
  if (settings.filesystem === null) {
    throw new Error('Storage-Adapter filesystem ohne Wurzelverzeichnis')
  }
  return createFilesystemAssetStorage(settings.filesystem.root)
}
