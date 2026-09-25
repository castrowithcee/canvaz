/**
 * Erscheinungsbild der Produktschale im Browser.
 *
 * Die Wahl wirkt ueber zwei Attribute am Wurzelelement: `data-theme` legt das Farbschema fest (fehlt es,
 * folgt die Schale der Systemvorgabe), `data-accent` die Akzentfarbe (fehlt es, gilt die bisherige). Welche
 * Farben dahinterstehen, weiss allein `styles.css`; hier wird nur umgeschaltet.
 *
 * ## Der Server ist massgeblich
 *
 * Die Wahl kommt mit dem Profil (`MeResponse.appearance`) und wird bei jedem Laden neu gesetzt. Zusaetzlich
 * liegt die zuletzt bekannte Wahl als **Komfortwert** im `localStorage`: `public/erscheinungsbild.js` setzt
 * sie vor der ersten Darstellung, damit ein Neuladen im Dunkelmodus nicht erst hell aufblitzt. Der Wert ist
 * nicht geheim, nicht massgeblich und darf fehlen; ohne Speicher gibt es nur den Blitz zurueck.
 *
 * ## Die Browseroberflaeche folgt der Wahl
 *
 * `index.html` traegt je Schema eine `theme-color`, ausgewaehlt ueber `prefers-color-scheme`. Ist ein Schema
 * fest gewaehlt, bekommen beide Eintraege dessen Farbe - die Browserleiste folgt damit der Wahl und nicht
 * dem System. Ohne Wahl steht wieder je Schema die eigene Farbe da.
 *
 * ## Excalidraw bekommt das aufgeloeste Schema
 *
 * Die Zeichenflaeche kennt kein "System"; sie bekommt ueber `useColorScheme` immer `light` oder `dark` -
 * auch dann richtig, wenn sich die Systemvorgabe waehrend der Sitzung aendert.
 */

import { useSyncExternalStore } from 'react'

import type { AppearanceView } from '../contracts/api.js'
import { DEFAULT_APPEARANCE } from '../contracts/api.js'

/** Derselbe Schluessel steht in `public/erscheinungsbild.js`. */
const STORAGE_KEY = 'canvaz:erscheinungsbild'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Farbe der Browseroberflaeche je Schema: der Hintergrund `--color-canvas` aus `styles.css`. Dieselben Werte
 * stehen in `index.html` und `public/erscheinungsbild.js`.
 */
const THEME_COLORS = { light: '#f4f4f6', dark: '#121212' } as const

/** Setzt die `theme-color`-Eintraege: fest gewaehlt beide auf dieselbe Farbe, sonst je Schema die eigene. */
function applyThemeColor(colorScheme: AppearanceView['colorScheme']): void {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own = meta.media.includes('dark') ? THEME_COLORS.dark : THEME_COLORS.light
    meta.content = colorScheme === 'system' ? own : THEME_COLORS[colorScheme]
  }
}

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function remember(appearance: AppearanceView | null): void {
  try {
    if (appearance === null) {
      window.localStorage.removeItem(STORAGE_KEY)
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance))
    }
  } catch {
    // Ohne Speicher (privates Fenster, gesperrte Seitendaten) bleibt nur der Blitz beim naechsten Laden.
  }
}

/**
 * Setzt ein Erscheinungsbild sofort und merkt es sich fuer das naechste Laden.
 *
 * `null` heisst: niemand ist angemeldet. Dann gilt die Standardwahl, und die zuletzt bekannte Wahl wird
 * vergessen - sie gehoert dem Konto, nicht dem Geraet.
 */
export function applyAppearance(appearance: AppearanceView | null): void {
  const { colorScheme, accent } = appearance ?? DEFAULT_APPEARANCE
  const root = document.documentElement
  if (colorScheme === 'system') {
    delete root.dataset['theme']
  } else {
    root.dataset['theme'] = colorScheme
  }
  applyThemeColor(colorScheme)
  if (accent === DEFAULT_APPEARANCE.accent) {
    delete root.dataset['accent']
  } else {
    root.dataset['accent'] = accent
  }
  remember(appearance)
  notify()
}

function subscribe(listener: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY)
  listeners.add(listener)
  query.addEventListener('change', listener)
  return () => {
    listeners.delete(listener)
    query.removeEventListener('change', listener)
  }
}

function currentScheme(): 'light' | 'dark' {
  const chosen = document.documentElement.dataset['theme']
  if (chosen === 'light' || chosen === 'dark') {
    return chosen
  }
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

/** Das gerade sichtbare Farbschema - aufgeloest, also nie `system`. */
export function useColorScheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, currentScheme)
}
