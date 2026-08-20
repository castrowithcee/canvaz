/**
 * Pfadschema und Navigation der angemeldeten Anwendung.
 *
 * Eine eigene, schmale Loesung statt einer Routingbibliothek: gebraucht werden das Lesen der Adresse, das
 * Setzen einer neuen Adresse und die Benachrichtigung der Oberflaeche. Das leistet die History-API mit
 * `popstate`; eine Abhaengigkeit dafuer waere reiner Zuwachs.
 *
 * Die Adressen sind reine Darstellung und entscheiden keine Berechtigung: jede Ansicht laedt ihre Daten
 * ueber die API, und jede Ablehnung kommt weiterhin serverseitig. Eine Adresse traegt deshalb auch nie ein
 * Freigabetoken - Gastzugang und Einladung stehen unveraendert unter `GUEST_APP_PATH` und `INVITE_APP_PATH`
 * und werden vor jedem Sitzungszustand entschieden (siehe `app.tsx`); dieses Modul kennt sie nicht.
 */

import { useMemo, useSyncExternalStore } from 'react'
import type { MouseEvent, ReactNode } from 'react'

export type AppRoute =
  /** Einstieg nach der Anmeldung. */
  | { readonly kind: 'einstieg' }
  /** Arbeitsbereichsverwaltung: eigene Arbeitsbereiche und das Anlegen eines neuen. */
  | { readonly kind: 'arbeitsbereiche' }
  /** Boards eines Arbeitsbereichs. */
  | { readonly kind: 'arbeitsbereich'; readonly workspaceId: string }
  | { readonly kind: 'mitglieder'; readonly workspaceId: string }
  | { readonly kind: 'einstellungen'; readonly workspaceId: string }
  /** Boardeditor im Vollbild. `version` gesetzt heisst: Read-only-Vorschau genau dieser Version. */
  | {
      readonly kind: 'board'
      readonly workspaceId: string
      readonly boardId: string
      readonly version: number | null
    }
  /** Eigene Kontoeinstellungen. */
  | { readonly kind: 'konto' }
  /** Kontenverwaltung der Systemadministration. */
  | { readonly kind: 'konten' }
  /** Keine Ansicht dieser Anwendung. */
  | { readonly kind: 'unbekannt' }

const WORKSPACES_SEGMENT = 'arbeitsbereiche'
const BOARDS_SEGMENT = 'boards'
const MEMBERS_SEGMENT = 'mitglieder'
const SETTINGS_SEGMENT = 'einstellungen'
const ACCOUNT_SEGMENT = 'konto'
const ADMIN_SEGMENT = 'verwaltung'
const ADMIN_ACCOUNTS_SEGMENT = 'konten'
const VERSION_PARAM = 'version'

/** Nummer einer aufbewahrten Version; alles andere ist keine. */
function parseVersion(search: string): number | null {
  const raw = new URLSearchParams(search).get(VERSION_PARAM)
  if (raw === null) {
    return null
  }
  const version = Number(raw)
  return Number.isInteger(version) && version > 0 ? version : null
}

/**
 * Liest eine Adresse (`/pfad?abfrage`) als Ansicht. Unbekanntes wird zu `unbekannt` statt zu einem leeren
 * Bildschirm - die Huelle zeigt dafuer eine benannte Ansicht.
 */
export function parseRoute(href: string): AppRoute {
  const [pathname = '', search = ''] = href.split('?')
  const segments = pathname.split('/').filter((segment) => segment !== '')
  const [first, second, third, fourth] = segments.map((segment) => decodeURIComponent(segment))

  if (first === undefined) {
    return { kind: 'einstieg' }
  }
  if (first === ACCOUNT_SEGMENT && second === undefined) {
    return { kind: 'konto' }
  }
  if (first === ADMIN_SEGMENT && second === ADMIN_ACCOUNTS_SEGMENT && third === undefined) {
    return { kind: 'konten' }
  }
  if (first === WORKSPACES_SEGMENT) {
    if (second === undefined) {
      return { kind: 'arbeitsbereiche' }
    }
    if (third === undefined) {
      return { kind: 'arbeitsbereich', workspaceId: second }
    }
    if (third === MEMBERS_SEGMENT && fourth === undefined) {
      return { kind: 'mitglieder', workspaceId: second }
    }
    if (third === SETTINGS_SEGMENT && fourth === undefined) {
      return { kind: 'einstellungen', workspaceId: second }
    }
    if (third === BOARDS_SEGMENT && fourth !== undefined && segments.length === 4) {
      return { kind: 'board', workspaceId: second, boardId: fourth, version: parseVersion(search) }
    }
  }
  return { kind: 'unbekannt' }
}

/** Die Adresse einer Ansicht. Gegenstueck zu `parseRoute`. */
export function routeHref(route: AppRoute): string {
  const workspace = (id: string): string => `/${WORKSPACES_SEGMENT}/${encodeURIComponent(id)}`
  switch (route.kind) {
    case 'einstieg':
    case 'unbekannt':
      return '/'
    case 'arbeitsbereiche':
      return `/${WORKSPACES_SEGMENT}`
    case 'arbeitsbereich':
      return workspace(route.workspaceId)
    case 'mitglieder':
      return `${workspace(route.workspaceId)}/${MEMBERS_SEGMENT}`
    case 'einstellungen':
      return `${workspace(route.workspaceId)}/${SETTINGS_SEGMENT}`
    case 'board': {
      const path = `${workspace(route.workspaceId)}/${BOARDS_SEGMENT}/${encodeURIComponent(route.boardId)}`
      return route.version === null ? path : `${path}?${VERSION_PARAM}=${String(route.version)}`
    }
    case 'konto':
      return `/${ACCOUNT_SEGMENT}`
    case 'konten':
      return `/${ADMIN_SEGMENT}/${ADMIN_ACCOUNTS_SEGMENT}`
  }
}

const NAVIGATION_EVENT = 'canvaz:navigation'

/**
 * Tiefe der von dieser Anwendung erzeugten Historieneintraege.
 *
 * Sie steht im Zustand des Eintrags und nicht in einer Variablen: nach einem Neuladen oder einem Sprung
 * ueber Zurueck und Vorwaerts waere jede Variable falsch. `0` heisst: der Eintrag davor gehoert nicht mehr
 * dieser Sitzung, ein `history.back()` wuerde die Anwendung verlassen.
 */
function historyDepth(): number {
  const state: unknown = window.history.state
  if (typeof state === 'object' && state !== null && 'canvazTiefe' in state) {
    const depth = (state as { readonly canvazTiefe: unknown }).canvazTiefe
    return typeof depth === 'number' ? depth : 0
  }
  return 0
}

export function navigate(route: AppRoute, options?: { readonly replace?: boolean }): void {
  const href = routeHref(route)
  if (options?.replace === true) {
    window.history.replaceState({ canvazTiefe: historyDepth() }, '', href)
  } else {
    window.history.pushState({ canvazTiefe: historyDepth() + 1 }, '', href)
  }
  // `pushState` loest kein `popstate` aus; ohne dieses Ereignis erfuehre die Oberflaeche nichts davon.
  window.dispatchEvent(new Event(NAVIGATION_EVENT))
}

/**
 * Zurueck in die aufrufende Ansicht. Gibt es keine eigene davor - etwa nach einem geteilten Link direkt auf
 * ein Board -, tritt `fallback` an ihre Stelle, ohne einen weiteren Eintrag zu hinterlassen.
 */
export function navigateBack(fallback: AppRoute): void {
  if (historyDepth() > 0) {
    window.history.back()
    return
  }
  navigate(fallback, { replace: true })
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(NAVIGATION_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(NAVIGATION_EVENT, onChange)
  }
}

/** Die Adresse als Zeichenkette; sie ist der stabile Wert, aus dem die Ansicht abgeleitet wird. */
function currentHref(): string {
  return window.location.pathname + window.location.search
}

export function useRoute(): AppRoute {
  const href = useSyncExternalStore(subscribe, currentHref)
  return useMemo(() => parseRoute(href), [href])
}

/**
 * Ein echter Link, der die Ansicht ohne Neuladen wechselt.
 *
 * Bewusst ein `<a href>` und kein Button: die Adresse ist teilbar, mit der mittleren Maustaste in einem
 * neuen Tab zu oeffnen und fuer Hilfsmittel als Link erkennbar. Abgefangen wird nur der schlichte Klick.
 */
export function Link({
  route,
  children,
  className,
  current,
}: {
  readonly route: AppRoute
  readonly children: ReactNode
  readonly className?: string
  /** Wahr, wenn diese Adresse gerade gezeigt wird; sie bekommt dann `aria-current="page"`. */
  readonly current?: boolean
}) {
  return (
    <a
      href={routeHref(route)}
      className={className}
      aria-current={current === true ? 'page' : undefined}
      onClick={(event: MouseEvent) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return
        }
        event.preventDefault()
        navigate(route)
      }}
    >
      {children}
    </a>
  )
}
