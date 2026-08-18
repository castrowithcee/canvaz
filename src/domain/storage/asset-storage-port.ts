/**
 * Port fuer Binaerassets (Board-Bilder).
 *
 * In diesem Paket bewusst nur das Interface: die Konfiguration waehlt bereits zwischen `filesystem` und
 * `s3`, eine Implementierung entsteht erst mit der Board-Strecke. So bleibt festgeschrieben, dass Assets
 * nie direkt ueber das Dateisystem oder ein SDK angefasst werden.
 */

export type AssetStorageAdapter = 'filesystem' | 's3'

export type StoredAsset = {
  readonly bytes: Uint8Array
  readonly contentType: string
}

export interface AssetStoragePort {
  put(key: string, asset: StoredAsset): Promise<void>
  get(key: string): Promise<StoredAsset | null>
  delete(key: string): Promise<void>
}
