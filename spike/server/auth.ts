/**
 * Autorisierung des Spikes.
 *
 * Bewusst minimal: der Spike belegt nur, dass die Schreibentscheidung serverseitig faellt. Das Produkt
 * ersetzt diese Tabelle spaeter durch die widerrufbare OIDC-Serversession aus Issue 2; der Aufrufvertrag
 * `resolveRole(request) -> Rolle` bleibt dabei gleich.
 */

import type { Role } from '../shared/protocol.js'

export type Principal = {
  readonly userId: string
  readonly displayName: string
  readonly role: Role
}

/**
 * Demo-Zugangsmarken fuer den lokalen Spike. Keine Zugangsdaten: sie autorisieren ausschliesslich gegen
 * einen lokal gestarteten In-Memory-Server und existieren im Produkt nicht.
 */
const DEFAULT_PRINCIPALS: Readonly<Record<string, Principal>> = {
  'spike-editor': { userId: 'user-editor', displayName: 'Editor', role: 'editor' },
  'spike-editor-2': { userId: 'user-editor-2', displayName: 'Zweiter Editor', role: 'editor' },
  'spike-viewer': { userId: 'user-viewer', displayName: 'Viewer', role: 'viewer' },
}

function loadPrincipals(): Readonly<Record<string, Principal>> {
  const raw = process.env['CANVAZ_SPIKE_PRINCIPALS']
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PRINCIPALS
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CANVAZ_SPIKE_PRINCIPALS muss ein Objekt aus Token zu Principal sein.')
  }
  const principals: Record<string, Principal> = {}
  for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`Ungueltiger Principal fuer Token ${token}.`)
    }
    const { userId, displayName, role } = value as Record<string, unknown>
    if (
      typeof userId !== 'string' ||
      typeof displayName !== 'string' ||
      (role !== 'editor' && role !== 'viewer')
    ) {
      throw new Error(`Ungueltiger Principal fuer Token ${token}.`)
    }
    principals[token] = { userId, displayName, role }
  }
  return principals
}

const PRINCIPALS = loadPrincipals()

export function resolvePrincipal(token: string | null): Principal | null {
  if (token === null || token === '') {
    return null
  }
  return PRINCIPALS[token] ?? null
}

export function canWrite(principal: Principal): boolean {
  return principal.role === 'editor'
}
