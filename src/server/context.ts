/**
 * Anwendungskontext.
 *
 * Getrennte Datei, damit Routen, Guards und der WebSocket-Einstieg denselben Kontexttyp nutzen koennen, ohne
 * dass die Module sich gegenseitig importieren muessen.
 */

import type { Pool } from 'pg'

import type { BoardStore } from '../domain/board/repositories.js'
import type { IdentityStore } from '../domain/identity/repositories.js'
import type { AssetStoragePort } from '../domain/storage/asset-storage-port.js'
import type { WorkspaceStore } from '../domain/workspace/repositories.js'
import type { BoardRooms } from './board-rooms.js'
import type { ClientAddressMonitor } from './client-address.js'
import type { AppConfig } from './config.js'
import type { Logger } from './log.js'
import type { Mailer } from './mailer.js'
import type { Metrics } from './metrics.js'
import type { OidcClient } from './oidc.js'
import type { RealtimeGateway } from './realtime.js'
import type { SenderDefenseGuard } from './sender-defense.js'

export type AppContext = {
  readonly config: AppConfig
  readonly pool: Pool
  readonly identity: IdentityStore
  readonly workspaces: WorkspaceStore
  readonly boards: BoardStore
  /** Bytes der Bildassets. Welcher Adapter dahintersteht, weiss nur die Composition Root. */
  readonly storage: AssetStoragePort
  /** `null` heisst: kein Identity Provider konfiguriert. Dann gibt es die OIDC-Routen gar nicht erst. */
  readonly oidc: OidcClient | null
  /**
   * `null` heisst: kein Postausgang konfiguriert. Dann verschickt die Instanz nichts; der Einladungslink
   * bleibt der Weg, den ein Administrator selbst zustellt.
   */
  readonly mailer: Mailer | null
  readonly realtime: RealtimeGateway
  /**
   * Die offenen Boardraeume.
   *
   * Nur eine Route braucht sie: eine Wiederherstellung oder ein Import ersetzt den persistierten Stand, und
   * ein Raum, der davon nichts erfaehrt, wuerde beim naechsten Checkpoint den alten Stand zurueckschreiben.
   */
  readonly rooms: BoardRooms
  readonly logger: Logger
  /** Zaehler des Betriebs. Der Metrikendpunkt liest sie, sonst schreibt nur der Request-Listener hinein. */
  readonly metrics: Metrics
  /**
   * Erkennt, ob die ermittelten Client-Adressen plausibel oeffentlich sind - ohne eine einzige Adresse zu
   * speichern. Der Request-Listener zaehlt jede API-Anfrage ein, die Systemadministration und #35 (IP-Sperre
   * nach gehaeuften Fehlanmeldungen) lesen die Aussage.
   */
  readonly addressMonitor: ClientAddressMonitor
  /**
   * Absenderabwehr gegen gehaeufte Fehlanmeldungen (#35, Meilenstein 1). Zaehlt Fehlschlaege je Absender und
   * sperrt vorlaeufig ab einer Schwelle; siehe `sender-defense.ts`.
   */
  readonly senderDefense: SenderDefenseGuard
  /** Injizierbare Uhr: Tests pruefen Ablauf und Widerruf ohne Wartezeit. */
  readonly now: () => Date
}
