/**
 * Startet die echte Anwendung fuer Integrationstests.
 *
 * Es gibt keinen verkuerzten Aufbau: Konfiguration, Routen, OIDC-Client und WebSocket-Einstieg entstehen
 * genau wie in `src/server/main.ts`. Nur Uhr und Logger sind austauschbar, damit Ablaufzeiten pruefbar sind
 * und die Protokollzeilen fuer den Token-Leck-Nachweis gesammelt werden koennen.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { Pool } from 'pg'

import type { IdentityStore } from '../../src/domain/identity/repositories.js'
import type { WorkspaceStore } from '../../src/domain/workspace/repositories.js'
import { createIdentityStore } from '../../src/persistence/identity-store.js'
import { createWorkspaceStore } from '../../src/persistence/workspace-store.js'
import { createRoutes } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
import type { AppContext } from '../../src/server/context.js'
import { createRequestListener } from '../../src/server/http.js'
import type { LogFields, LogLevel } from '../../src/server/log.js'
import { createOidcClient } from '../../src/server/oidc.js'
import { createRealtimeGateway } from '../../src/server/realtime.js'
import type { RealtimeGateway, RealtimeOptions } from '../../src/server/realtime.js'
import type { TestProvider } from './oidc-provider.js'

export type LogEntry = { readonly level: LogLevel; readonly event: string; readonly fields: LogFields }

export type TestApp = {
  readonly baseUrl: string
  readonly context: AppContext
  readonly store: IdentityStore
  readonly workspaces: WorkspaceStore
  readonly realtime: RealtimeGateway
  readonly logs: readonly LogEntry[]
  clearLogs(): void
  /** Verschiebt die Uhr der Anwendung; `null` stellt die echte Zeit wieder her. */
  setNow(value: Date | null): void
  close(): Promise<void>
}

export const TEST_SESSION_SECRET = 'test-session-secret-mit-mehr-als-32-zeichen'

export async function startTestApp(options: {
  readonly provider: TestProvider
  readonly pool: Pool
  readonly databaseUrl: string
  readonly sessionTtlHours?: number
  /** Haken der spaeteren Realtime-Strecke; der Test nutzt ihn, um den Andockpunkt zu pruefen. */
  readonly onConnection?: RealtimeOptions['onConnection']
}): Promise<TestApp> {
  const server: Server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${String(port)}`

  const config = loadConfig({
    CANVAZ_PORT: String(port),
    CANVAZ_BASE_URL: baseUrl,
    CANVAZ_WEB_ROOT: 'dist/web',
    DATABASE_URL: options.databaseUrl,
    CANVAZ_SESSION_SECRET: TEST_SESSION_SECRET,
    CANVAZ_SESSION_TTL_HOURS: String(options.sessionTtlHours ?? 12),
    CANVAZ_OIDC_ISSUER: options.provider.issuer,
    CANVAZ_OIDC_CLIENT_ID: options.provider.clientId,
    CANVAZ_OIDC_CLIENT_SECRET: options.provider.clientSecret,
    CANVAZ_OIDC_REDIRECT_URI: `${baseUrl}/api/auth/callback`,
  })

  const logs: LogEntry[] = []
  const logger = (level: LogLevel, event: string, fields: LogFields = {}) => {
    logs.push({ level, event, fields })
  }
  let frozenNow: Date | null = null
  const now = () => frozenNow ?? new Date()

  const store = createIdentityStore(options.pool)
  const workspaces = createWorkspaceStore(options.pool)
  // Kurzer Abstand der Ablaufpruefung: der Test soll auf das Schliessen nicht eine Minute warten.
  const realtime = createRealtimeGateway({
    config,
    identity: store,
    workspaces,
    logger,
    now,
    expiryCheckIntervalMs: 25,
    ...(options.onConnection === undefined ? {} : { onConnection: options.onConnection }),
  })
  const context: AppContext = {
    config,
    pool: options.pool,
    identity: store,
    workspaces,
    oidc: createOidcClient(config),
    realtime,
    logger,
    now,
  }
  server.on('request', createRequestListener(createRoutes(context), config.webRoot))
  realtime.attach(server)

  return {
    baseUrl,
    context,
    store,
    workspaces,
    realtime,
    logs,
    clearLogs(): void {
      logs.length = 0
    },
    setNow(value: Date | null): void {
      frozenNow = value
    },
    async close(): Promise<void> {
      await realtime.close()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
