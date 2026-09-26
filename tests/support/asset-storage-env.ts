/**
 * Laufzeitumgebung beider Storage-Adapter fuer die Tests.
 *
 * Genau eine Stelle, an der die Testumgebung weiss, wie `filesystem` und `s3` konfiguriert werden. Der
 * Contract-Test und der Anwendungstest bekommen von hier dieselben Werte, sodass beide nachweislich
 * dieselben zwei Adapter meinen.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { S3StorageConfig } from '../../src/persistence/asset-storage-s3.js'

/** SeaweedFS aus `compose.yml`. Lokale Entwicklungswerte, keine Secrets. */
export const TEST_S3: S3StorageConfig = {
  endpoint: process.env['CANVAZ_TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:59000',
  region: 'us-east-1',
  bucket: process.env['CANVAZ_TEST_S3_BUCKET'] ?? 'canvaz-assets-test',
  accessKeyId: process.env['CANVAZ_TEST_S3_ACCESS_KEY_ID'] ?? 'canvaz',
  secretAccessKey: process.env['CANVAZ_TEST_S3_SECRET_ACCESS_KEY'] ?? 'canvaz-seaweedfs-dev',
  // SeaweedFS kennt keine Bucket-Subdomains.
  forcePathStyle: true,
}

export const MISSING_TEST_S3_HINT =
  `Kein SeaweedFS unter ${TEST_S3.endpoint}. Zuerst "npm run db:up" ausfuehren - der s3-Adapter wird gegen ` +
  'eine echte Instanz geprueft, nicht gegen eine Attrappe.'

export async function createFilesystemRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'canvaz-assets-'))
}

/** Umgebungsvariablen, mit denen eine Anwendungsinstanz den jeweiligen Adapter faehrt. */
export function filesystemEnv(root: string): Readonly<Record<string, string>> {
  return { CANVAZ_STORAGE_ADAPTER: 'filesystem', CANVAZ_STORAGE_FILESYSTEM_ROOT: root }
}

export function s3Env(): Readonly<Record<string, string>> {
  return {
    CANVAZ_STORAGE_ADAPTER: 's3',
    CANVAZ_S3_ENDPOINT: TEST_S3.endpoint,
    CANVAZ_S3_REGION: TEST_S3.region,
    CANVAZ_S3_BUCKET: TEST_S3.bucket,
    CANVAZ_S3_ACCESS_KEY_ID: TEST_S3.accessKeyId,
    CANVAZ_S3_SECRET_ACCESS_KEY: TEST_S3.secretAccessKey,
    CANVAZ_S3_FORCE_PATH_STYLE: String(TEST_S3.forcePathStyle),
  }
}
