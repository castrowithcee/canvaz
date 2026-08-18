/**
 * Anwendungskontext.
 *
 * Getrennte Datei, damit Routen, Guards und der WebSocket-Einstieg denselben Kontexttyp nutzen koennen, ohne
 * dass die Module sich gegenseitig importieren muessen.
 */

import type { Pool } from 'pg'

import type { IdentityStore } from '../domain/identity/repositories.js'
import type { WorkspaceStore } from '../domain/workspace/repositories.js'
import type { AppConfig } from './config.js'
import type { Logger } from './log.js'
import type { OidcClient } from './oidc.js'
import type { RealtimeGateway } from './realtime.js'

export type AppContext = {
  readonly config: AppConfig
  readonly pool: Pool
  readonly identity: IdentityStore
  readonly workspaces: WorkspaceStore
  readonly oidc: OidcClient
  readonly realtime: RealtimeGateway
  readonly logger: Logger
  /** Injizierbare Uhr: Tests pruefen Ablauf und Widerruf ohne Wartezeit. */
  readonly now: () => Date
}
