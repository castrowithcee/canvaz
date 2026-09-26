/**
 * `npm run db:migrate` - wendet ausstehende Migrationen an und beendet sich.
 *
 * Der Anwendungsserver migriert nicht selbst, damit ein Neustart nie unbeabsichtigt das Schema aendert.
 * Die Konfiguration wird vollstaendig geladen, damit es keinen zweiten, laxeren Konfigurationspfad gibt.
 */

import { loadConfig } from '../server/config.js'
import { migrate } from './migrate.js'
import { createPool } from './pool.js'

const pool = createPool(loadConfig().databaseUrl)
try {
  const applied = await migrate(pool)
  console.log(applied.length === 0 ? 'Keine ausstehenden Migrationen.' : `Angewendet: ${applied.join(', ')}`)
} finally {
  await pool.end()
}
