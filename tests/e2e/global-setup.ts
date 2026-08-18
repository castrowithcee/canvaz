/**
 * Bringt die Testdatenbank vor den Browsertests auf den aktuellen Schemastand.
 */

import { migrate } from '../../src/persistence/migrate.js'
import { createPool } from '../../src/persistence/pool.js'
import { E2E_DATABASE_URL } from '../../playwright.config.js'

export default async function globalSetup(): Promise<void> {
  const pool = createPool(E2E_DATABASE_URL)
  try {
    await migrate(pool)
  } finally {
    await pool.end()
  }
}
