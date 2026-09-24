/**
 * Persoenliche Bibliothek im Boardeditor.
 *
 * Laedt die eigene Bibliothek, reicht sie der Zeichenflaeche als Ausgangsstand und speichert jede Aenderung,
 * die der Editor meldet - gleich ob sie aus einem Dateiimport, dem oeffentlichen Katalog, "Zur Bibliothek
 * hinzufuegen" oder dem Entfernen eines Eintrags stammt. Excalidraw kennt diese Datei nicht; sie spricht nur
 * mit dem Editor-Port und dem Bibliotheksvertrag.
 *
 * - **Erst bestaetigt ist gespeichert.** Der Zustand zeigt "wird gespeichert", bis der Server antwortet, und
 *   benennt einen Fehlschlag mit Wiederholung und Export.
 * - **Kein stilles Ueberschreiben.** Jede Speicherung nennt die Revision, auf der sie aufsetzt. Meldet der
 *   Server einen Konflikt, wird der neue Stand geladen, eintragsweise zusammengefuehrt, sichtbar benannt und
 *   dann gespeichert.
 * - **Nichts wird geloescht, was der Editor noch gar nicht zeigt.** Gespeichert wird erst, wenn die
 *   Zeichenflaeche den geladenen Ausgangsstand vollstaendig uebernommen hat.
 * - **Bilder werden nicht mitgenommen.** Ein Eintrag mit Bild waere ohne dessen Bytes beschaedigt; er wird aus
 *   der Bibliothek genommen und benannt.
 *
 * Ein Gast hat keine Bibliothek. Seine Zeichenflaeche haelt eine fuer die laufende Sitzung, und die Ansicht
 * sagt ihm, dass sie nicht gespeichert wird.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { LibraryView } from '../../contracts/api.js'
import type { LibraryItem } from '../../contracts/library.js'
import { hasUnsupportedMedia, mergeLibraries, sameLibrary, serializeLibraryFile } from '../../contracts/library.js'
import { ApiError, fetchLibrary, saveLibrary } from '../api.js'
import type { BoardEditorPort, EditorLibrary } from './board-editor-port.js'

/** Ruhezeit nach der letzten Bibliotheksaenderung. Kurz: Bibliotheksaenderungen kommen einzeln. */
const LIBRARY_SAVE_DELAY_MS = 400

/** So lange bleibt die Bestaetigung einer Speicherung stehen. */
const SAVED_VISIBLE_MS = 3_000

export type LibraryStatus =
  | { readonly kind: 'ruhig' }
  | { readonly kind: 'speichert' }
  | { readonly kind: 'gespeichert' }
  | { readonly kind: 'fehler'; readonly message: string }
  | { readonly kind: 'ladefehler'; readonly message: string }

export type PersonalLibrary = {
  readonly editorLibrary: EditorLibrary
  readonly status: LibraryStatus
  /** Hinweis ohne Fehler: zusammengefuehrt, Bilder nicht uebernommen, Gast ohne Speicherung. */
  readonly note: string | null
  /** Ob Aenderungen der Bibliothek nur im Browser liegen. */
  readonly unsaved: boolean
  readonly retry: () => void
  readonly exportFile: () => void
  readonly dismissNote: () => void
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

function idsOf(items: readonly LibraryItem[]): ReadonlySet<string> {
  return new Set(items.map((item) => item.id))
}

export function usePersonalLibrary({
  csrfToken,
  persistent,
  adapter,
}: {
  readonly csrfToken: string
  /** `false` fuer einen Gast: dann wird nichts geladen und nichts gespeichert. */
  readonly persistent: boolean
  readonly adapter: BoardEditorPort | null
}): PersonalLibrary {
  const [status, setStatus] = useState<LibraryStatus>({ kind: 'ruhig' })
  const [note, setNote] = useState<string | null>(null)

  // Refs statt State: die Rueckrufe des Editors lesen den jeweils aktuellen Stand, ohne neu gebaut zu werden.
  const adapterRef = useRef(adapter)
  adapterRef.current = adapter
  /** Zuletzt vom Server bestaetigter Stand. `null` heisst: noch nicht geladen. */
  const baseRef = useRef<LibraryView | null>(null)
  /** Was der Editor zuletzt gemeldet hat. */
  const localRef = useRef<readonly LibraryItem[] | null>(null)
  /** Kennungen, die die Zeichenflaeche als Ausgangsstand bekommen hat. Erst wenn sie alle zeigt, wird gespeichert. */
  const expectedRef = useRef<ReadonlySet<string> | null>(null)
  const readyRef = useRef(false)
  const savingRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const guestNotedRef = useRef(false)

  const schedule = useRef<() => void>(() => undefined)

  const flush = useCallback(() => {
    const base = baseRef.current
    const local = localRef.current
    if (savingRef.current || !readyRef.current || base === null || local === null) {
      return
    }
    if (sameLibrary(local, base.items)) {
      setStatus((current) => (current.kind === 'speichert' ? { kind: 'gespeichert' } : current))
      return
    }
    savingRef.current = true
    setStatus({ kind: 'speichert' })
    saveLibrary(csrfToken, { revision: base.revision, items: local })
      .then((response) => {
        baseRef.current = { revision: response.revision, items: local }
        savingRef.current = false
        // Was waehrend der Speicherung dazukam, geht gleich hinterher.
        if (localRef.current !== null && !sameLibrary(localRef.current, local)) {
          schedule.current()
          return
        }
        setStatus({ kind: 'gespeichert' })
      })
      .catch(async (cause: unknown) => {
        if (!(cause instanceof ApiError && cause.status === 409)) {
          savingRef.current = false
          setStatus({ kind: 'fehler', message: messageOf(cause, 'Der Server war nicht erreichbar.') })
          return
        }
        // Ein anderes Fenster war schneller. Nichts wurde ueberschrieben; beide Staende werden zusammengefuehrt.
        try {
          const remote = await fetchLibrary()
          const merged = mergeLibraries(base.items, localRef.current ?? local, remote.items)
          baseRef.current = remote
          savingRef.current = false
          setNote('Deine Bibliothek wurde inzwischen in einem anderen Fenster geaendert. Beide Staende wurden zusammengefuehrt.')
          if (sameLibrary(merged, localRef.current ?? local)) {
            schedule.current()
          } else {
            // Der Editor zeigt danach den zusammengefuehrten Stand und meldet ihn; das speichert ihn.
            adapterRef.current?.replaceLibrary(merged)
          }
        } catch (reloadCause) {
          savingRef.current = false
          setStatus({ kind: 'fehler', message: messageOf(reloadCause, 'Der Server war nicht erreichbar.') })
        }
      })
  }, [csrfToken])

  schedule.current = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      flush()
    }, LIBRARY_SAVE_DELAY_MS)
  }

  const reload = useCallback(async (): Promise<readonly LibraryItem[]> => {
    try {
      const view = await fetchLibrary()
      baseRef.current = view
      return view.items
    } catch (cause) {
      setStatus({
        kind: 'ladefehler',
        message: messageOf(cause, 'Deine Bibliothek konnte nicht geladen werden.'),
      })
      throw cause
    }
  }, [])

  const editorLibrary = useMemo<EditorLibrary>(
    () => ({
      acceptsCatalog: persistent,
      load: async () => {
        readyRef.current = false
        expectedRef.current = null
        if (!persistent) {
          return []
        }
        // Eine neue Zeichenflaeche desselben Boards bekommt den zuletzt bekannten Stand, nicht den ersten.
        const known = baseRef.current === null ? await reload() : (localRef.current ?? baseRef.current.items)
        expectedRef.current = idsOf(known)
        return known
      },
      onChange: (items) => {
        localRef.current = items
        if (!persistent) {
          if (items.length > 0 && !guestNotedRef.current) {
            guestNotedRef.current = true
            setNote('Als Gast wird deine Bibliothek nicht gespeichert. Sie gilt nur, bis du diese Seite schliesst.')
          }
          return
        }
        const unsupported = items.filter(hasUnsupportedMedia)
        if (unsupported.length > 0) {
          setNote(
            `${String(unsupported.length)} Bibliothekselement(e) mit Bildern wurden nicht uebernommen. Bilder werden in der Bibliothek nicht gespeichert.`,
          )
          adapterRef.current?.replaceLibrary(items.filter((item) => !hasUnsupportedMedia(item)))
          return
        }
        // Derselbe Eintrag zweimal - etwa dieselbe Datei erneut importiert - bleibt einmal stehen. Der Editor
        // stellt neue Eintraege vorn an; behalten wird damit der zuletzt uebernommene.
        const seen = new Set<string>()
        const unique = items.filter((item) => {
          if (seen.has(item.id)) {
            return false
          }
          seen.add(item.id)
          return true
        })
        if (unique.length !== items.length) {
          adapterRef.current?.replaceLibrary(unique)
          return
        }
        if (!readyRef.current) {
          const expected = expectedRef.current
          const shown = idsOf(items)
          if (expected === null || ![...expected].every((id) => shown.has(id))) {
            return
          }
          readyRef.current = true
        }
        schedule.current()
      },
    }),
    [persistent, reload],
  )

  // Eine Bestaetigung ist ein Beleg, keine Dauermeldung.
  useEffect(() => {
    if (status.kind !== 'gespeichert') {
      return
    }
    const timer = window.setTimeout(() => {
      setStatus((current) => (current.kind === 'gespeichert' ? { kind: 'ruhig' } : current))
    }, SAVED_VISIBLE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [status])

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
    },
    [],
  )

  const retry = useCallback(() => {
    if (baseRef.current !== null) {
      schedule.current()
      return
    }
    // Der Ausgangsstand fehlte: jetzt laden und mit dem zusammenfuehren, was im Editor inzwischen dazukam.
    setStatus({ kind: 'ruhig' })
    reload()
      .then((items) => {
        const merged = mergeLibraries([], localRef.current ?? [], items)
        expectedRef.current = idsOf(merged)
        adapterRef.current?.replaceLibrary(merged)
      })
      .catch(() => {
        // Der Zustand benennt den Fehlschlag bereits.
      })
  }, [reload])

  const exportFile = useCallback(() => {
    const items = localRef.current ?? baseRef.current?.items ?? []
    const url = URL.createObjectURL(
      new Blob([serializeLibraryFile(items, window.location.origin)], { type: 'application/json' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'bibliothek.excalidrawlib'
    link.click()
    URL.revokeObjectURL(url)
  }, [])

  const dismissNote = useCallback(() => {
    setNote(null)
  }, [])

  const unsaved = persistent && (status.kind === 'speichert' || status.kind === 'fehler')

  // Wie beim Board: ungesicherte Bibliotheksaenderungen verschwinden nicht ohne Rueckfrage des Browsers.
  useEffect(() => {
    if (!unsaved) {
      return
    }
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
    }
  }, [unsaved])

  return { editorLibrary, status, note, unsaved, retry, exportFile, dismissNote }
}
