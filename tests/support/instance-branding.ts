import type { Pool } from 'pg'

/** Resets the singleton row; it must never be deleted, and logo_key and logo_type change together. */
export async function resetInstanceBranding(pool: Pool): Promise<void> {
  await pool.query(
    "update instance_branding set instance_name = '', accent = '', logo_key = null, logo_type = null",
  )
}
