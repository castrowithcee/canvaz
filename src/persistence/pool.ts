/**
 * PostgreSQL-Verbindungspool.
 *
 * Bewusst schlank: bei bis zu 30 Nutzern und 5 gleichzeitigen Editoren traegt ein einzelner Pool im
 * Anwendungsprozess. Externe Pooler oder Read-Replicas sind erst bei gemessenem Bedarf sinnvoll.
 */

import { Pool } from 'pg'

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
}
