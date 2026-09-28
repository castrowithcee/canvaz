/**
 * Migrationsverfahren.
 *
 * Versionierte SQL-Dateien plus eine Tabelle mit den angewendeten Versionen. Bewusst kein ORM und kein
 * Migrationsframework: das Schema ist klein, SQL ist die Zielsprache, und jede Migration bleibt im Diff
 * lesbar. Jede Datei laeuft in einer eigenen Transaktion; ein Advisory Lock verhindert, dass zwei
 * gleichzeitig gestartete Prozesse dieselbe Migration anwenden.
 */

import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { Pool } from 'pg'

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url))
/** Frei gewaehlte, projektweit feste Kennung fuer den Advisory Lock. */
const MIGRATION_LOCK_ID = 4_711_020_601

async function readMigrationFiles(): Promise<readonly string[]> {
  const entries = await readdir(MIGRATIONS_DIR)
  return entries.filter((entry) => entry.endsWith('.sql')).sort()
}

/**
 * Wendet alle noch nicht angewendeten Migrationen an und liefert deren Versionen.
 */
export async function migrate(pool: Pool): Promise<readonly string[]> {
  const files = await readMigrationFiles()
  const client = await pool.connect()
  const applied: string[] = []
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `)
    const known = await client.query<{ version: string }>('select version from schema_migrations')
    const knownVersions = new Set(known.rows.map((row) => row.version))

    for (const file of files) {
      const version = file.replace(/\.sql$/, '')
      if (knownVersions.has(version)) {
        continue
      }
      const sql = await readFile(MIGRATIONS_DIR + file, 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into schema_migrations (version) values ($1)', [version])
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw new Error(`Migration ${version} fehlgeschlagen`, { cause: error })
      }
      applied.push(version)
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
    client.release()
  }
  return applied
}
