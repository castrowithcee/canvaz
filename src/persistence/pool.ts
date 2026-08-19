/**
 * PostgreSQL-Verbindungspool.
 *
 * Bewusst schlank: bei bis zu 30 Nutzern und 5 gleichzeitigen Editoren traegt ein einzelner Pool im
 * Anwendungsprozess. Externe Pooler oder Read-Replicas sind erst bei gemessenem Bedarf sinnvoll.
 */

import { Pool } from 'pg'

/**
 * Baut den Pool und faengt Fehler **leerlaufender** Verbindungen ab.
 *
 * Ohne diesen Zuhoerer beendet ein Datenbankneustart den Anwendungsprozess: `pg` meldet den Abbruch einer
 * gerade nicht benutzten Verbindung als `error`-Ereignis am Pool, und ein `error`-Ereignis ohne Zuhoerer
 * ist in Node eine unbehandelte Ausnahme. Genau das darf hier nicht passieren - ein Wartungsfenster der
 * Datenbank wuerde sonst offene Boardraeume mitreissen, bevor sie ihren Stand schreiben konnten. Die
 * laufende Anfrage scheitert ohnehin sichtbar, die Bereitschaftspruefung meldet den Ausfall, und der Pool
 * baut die Verbindung beim naechsten Bedarf neu auf.
 */
export function createPool(databaseUrl: string, onError?: (error: unknown) => void): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  pool.on('error', (error: unknown) => {
    if (onError !== undefined) {
      onError(error)
      return
    }
    // Nur Name und Meldung: ein Fehlerobjekt von `pg` traegt die ausgefuehrte Abfrage samt Parametern.
    const beschreibung = error instanceof Error ? `${error.name}: ${error.message}` : 'unbekannter Fehler'
    console.error(`Datenbankverbindung verloren: ${beschreibung}`)
  })
  return pool
}
