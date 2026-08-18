/**
 * Massgeblicher Boardzustand des Servers mit Snapshot-Persistenz.
 *
 * Der Spike persistiert nach JSON-Dateien statt nach PostgreSQL. Der Store kapselt das hinter einer
 * schmalen Schnittstelle, damit Issue 4 den Adapter austauschen kann, ohne den Sync zu beruehren.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { reconcileElements } from '../shared/reconcile.js'
import type { BinaryFileRef, PersistedAppState, SceneSnapshot, SyncElement } from '../shared/scene.js'
import { createEmptySnapshot, deserializeSceneSnapshot, serializeSceneSnapshot } from '../shared/scene.js'

export type BoardStoreOptions = {
  readonly dataDir: string
  readonly now?: () => number
}

export class BoardStore {
  readonly #dataDir: string
  readonly #now: () => number
  readonly #boards = new Map<string, SceneSnapshot>()
  readonly #pendingWrites = new Map<string, Promise<void>>()

  constructor(options: BoardStoreOptions) {
    this.#dataDir = options.dataDir
    this.#now = options.now ?? (() => Date.now())
  }

  #path(boardId: string): string {
    // Board-IDs werden vor dem Store validiert; der Join bleibt trotzdem auf einen Dateinamen begrenzt.
    return join(this.#dataDir, `${boardId}.json`)
  }

  async load(boardId: string): Promise<SceneSnapshot> {
    const cached = this.#boards.get(boardId)
    if (cached !== undefined) {
      return cached
    }
    let snapshot: SceneSnapshot | null = null
    try {
      snapshot = deserializeSceneSnapshot(await readFile(this.#path(boardId), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    const resolved = snapshot ?? createEmptySnapshot(boardId, this.#now())
    this.#boards.set(boardId, resolved)
    return resolved
  }

  get(boardId: string): SceneSnapshot | undefined {
    return this.#boards.get(boardId)
  }

  /** Fuehrt eingehende Elemente in den massgeblichen Zustand und meldet die tatsaechlich uebernommenen. */
  applyElements(boardId: string, incoming: readonly SyncElement[]): readonly SyncElement[] {
    const current = this.#require(boardId)
    const { elements, appliedIds } = reconcileElements(current.elements, incoming)
    if (appliedIds.size === 0) {
      return []
    }
    const applied = incoming.filter((element) => appliedIds.has(element.id))
    this.#boards.set(boardId, { ...current, elements, updatedAt: this.#now() })
    this.#schedulePersist(boardId)
    return applied
  }

  applyAppState(boardId: string, appState: PersistedAppState): void {
    const current = this.#require(boardId)
    this.#boards.set(boardId, { ...current, appState, updatedAt: this.#now() })
    this.#schedulePersist(boardId)
  }

  addFileRef(boardId: string, file: BinaryFileRef): void {
    const current = this.#require(boardId)
    if (current.files[file.id] !== undefined) {
      return
    }
    this.#boards.set(boardId, {
      ...current,
      files: { ...current.files, [file.id]: file },
      updatedAt: this.#now(),
    })
    this.#schedulePersist(boardId)
  }

  #require(boardId: string): SceneSnapshot {
    const snapshot = this.#boards.get(boardId)
    if (snapshot === undefined) {
      throw new Error(`Board ${boardId} ist nicht geladen.`)
    }
    return snapshot
  }

  #schedulePersist(boardId: string): void {
    const previous = this.#pendingWrites.get(boardId) ?? Promise.resolve()
    const next = previous.then(() => this.#persist(boardId))
    this.#pendingWrites.set(boardId, next)
    next.catch(() => {
      // Fehler werden ueber flush() sichtbar; ein Persistenzfehler darf den Sync nicht abreissen.
    })
  }

  async #persist(boardId: string): Promise<void> {
    const snapshot = this.#boards.get(boardId)
    if (snapshot === undefined) {
      return
    }
    await mkdir(this.#dataDir, { recursive: true })
    const target = this.#path(boardId)
    const temporary = `${target}.tmp`
    await writeFile(temporary, serializeSceneSnapshot(snapshot), 'utf8')
    await rename(temporary, target)
  }

  /** Wartet auf alle offenen Schreibvorgaenge. Tests und ein sauberer Shutdown nutzen das. */
  async flush(): Promise<void> {
    await Promise.all([...this.#pendingWrites.values()])
  }

  /** Verwirft den Cache, damit ein Neustart aus der Persistenz nachweisbar wird. */
  evict(boardId: string): void {
    this.#boards.delete(boardId)
  }
}
