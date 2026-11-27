import type { Pool } from 'pg'

import { parseAccentColor } from '../contracts/api.js'
import type { InstanceBranding } from '../domain/branding/model.js'
import type { BrandingStore } from '../domain/branding/repositories.js'

type BrandingRow = {
  instance_name: string
  accent: string
  logo_key: string | null
  logo_type: string | null
  updated_at: Date
}

function toBranding(row: BrandingRow): InstanceBranding {
  return {
    instanceName: row.instance_name,
    accent: parseAccentColor(row.accent),
    logo:
      row.logo_key === null || row.logo_type === null
        ? null
        : { key: row.logo_key, type: row.logo_type as 'image/png' | 'image/jpeg' | 'image/webp' },
    updatedAt: row.updated_at,
  }
}

const COLUMNS = 'instance_name, accent, logo_key, logo_type, updated_at'

export function createBrandingStore(pool: Pool): BrandingStore {
  return {
    async get() {
      const result = await pool.query<BrandingRow>(`select ${COLUMNS} from instance_branding`)
      const row = result.rows[0]
      if (row === undefined) {
        throw new Error('Instance branding row is missing')
      }
      return toBranding(row)
    },

    async saveSettings({ instanceName, accent, actorId, now }) {
      const result = await pool.query<BrandingRow>(
        `update instance_branding set instance_name = $1, accent = $2, updated_at = $3, updated_by = $4
         returning ${COLUMNS}`,
        [instanceName, accent ?? '', now, actorId],
      )
      return toBranding(result.rows[0] as BrandingRow)
    },

    async setLogo(logo, { actorId, now }) {
      // The lock makes concurrent replacements each see the key they actually replace.
      const result = await pool.query<BrandingRow & { previous_key: string | null }>(
        `update instance_branding b
            set logo_key = $1, logo_type = $2, updated_at = $3, updated_by = $4
           from (select logo_key from instance_branding for update) old
         returning b.instance_name, b.accent, b.logo_key, b.logo_type, b.updated_at, old.logo_key as previous_key`,
        [logo?.key ?? null, logo?.type ?? null, now, actorId],
      )
      const row = result.rows[0] as BrandingRow & { previous_key: string | null }
      return { branding: toBranding(row), previousKey: row.previous_key }
    },
  }
}
