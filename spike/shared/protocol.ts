/**
 * Nachrichtenvertrag zwischen Client und Kollaborationsserver.
 *
 * Alle eingehenden Nachrichten sind untrusted und werden serverseitig geparst, bevor sie Wirkung haben.
 */

import type { BinaryFileRef, PersistedAppState, SceneSnapshot, SyncElement } from './scene.js'
import { parseSyncElements } from './scene.js'

export type Role = 'editor' | 'viewer'

export type Peer = {
  readonly clientId: string
  readonly displayName: string
  readonly role: Role
  readonly pointer: Pointer | null
}

export type Pointer = {
  readonly x: number
  readonly y: number
}

export type ClientMessage =
  | { readonly type: 'scene-update'; readonly elements: readonly SyncElement[] }
  | { readonly type: 'app-state-update'; readonly appState: PersistedAppState }
  | { readonly type: 'file-ref-add'; readonly file: BinaryFileRef }
  | { readonly type: 'pointer'; readonly pointer: Pointer }

export type ServerMessage =
  | {
      readonly type: 'welcome'
      readonly clientId: string
      readonly role: Role
      readonly snapshot: SceneSnapshot
      readonly peers: readonly Peer[]
    }
  | { readonly type: 'scene-update'; readonly elements: readonly SyncElement[]; readonly origin: string }
  | { readonly type: 'app-state-update'; readonly appState: PersistedAppState; readonly origin: string }
  | { readonly type: 'file-ref-add'; readonly file: BinaryFileRef; readonly origin: string }
  | { readonly type: 'presence'; readonly peers: readonly Peer[] }
  | { readonly type: 'pointer'; readonly clientId: string; readonly pointer: Pointer }
  | { readonly type: 'mutation-rejected'; readonly code: MutationRejectionCode; readonly message: string }

export type MutationRejectionCode = 'read-only' | 'invalid-payload' | 'rate-limited'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePointer(value: unknown): Pointer | null {
  if (!isRecord(value)) {
    return null
  }
  const { x, y } = value
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
    return null
  }
  return { x, y }
}

function parseAppStatePayload(value: unknown): PersistedAppState | null {
  if (!isRecord(value)) {
    return null
  }
  const { viewBackgroundColor, gridSize, gridModeEnabled, name } = value
  if (
    typeof viewBackgroundColor !== 'string' ||
    !(gridSize === null || typeof gridSize === 'number') ||
    typeof gridModeEnabled !== 'boolean' ||
    typeof name !== 'string'
  ) {
    return null
  }
  return { viewBackgroundColor, gridSize, gridModeEnabled, name }
}

function parseFileRef(value: unknown): BinaryFileRef | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, mimeType, created, byteSize, storageKey } = value
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof mimeType !== 'string' ||
    typeof created !== 'number' ||
    typeof byteSize !== 'number' ||
    byteSize < 0 ||
    typeof storageKey !== 'string'
  ) {
    return null
  }
  return { id, mimeType, created, byteSize, storageKey }
}

/** Parst eine untrusted Clientnachricht. `null` bedeutet: verwerfen und ablehnen. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) {
    return null
  }
  switch (value['type']) {
    case 'scene-update': {
      const elements = parseSyncElements(value['elements'])
      return elements === null ? null : { type: 'scene-update', elements }
    }
    case 'app-state-update': {
      const appState = parseAppStatePayload(value['appState'])
      return appState === null ? null : { type: 'app-state-update', appState }
    }
    case 'file-ref-add': {
      const file = parseFileRef(value['file'])
      return file === null ? null : { type: 'file-ref-add', file }
    }
    case 'pointer': {
      const pointer = parsePointer(value['pointer'])
      return pointer === null ? null : { type: 'pointer', pointer }
    }
    default:
      return null
  }
}

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message)
}
