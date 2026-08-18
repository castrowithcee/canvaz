/**
 * Boards im Browser: anlegen, zeichnen, speichern, neu laden, wiederfinden, umbenennen, archivieren.
 *
 * Gezeichnet wird ueber die echte Excalidraw-Oberflaeche, nicht ueber eine Testschnittstelle. Der Nachweis
 * der Persistenz liest die Zeichenflaeche selbst aus: nach dem Neuladen ist auf dem Canvas wieder etwas zu
 * sehen, und die Liste meldet eine gespeicherte Version.
 */

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'

import { E2E_DATABASE_URL, E2E_PROVIDER_URL } from '../../playwright.config.js'
import { BOARD_ASSETS_PATH } from '../../src/contracts/api.js'
import { solidPng } from '../support/png.js'

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })

test.afterAll(async () => {
  await pool.end()
})

test.beforeEach(async () => {
  await pool.query('truncate users, workspaces cascade')
  await fetch(`${E2E_PROVIDER_URL}/__control`, { method: 'POST', body: '{}' })
})

async function signIn(page: Page, subject: string): Promise<void> {
  await page.getByRole('link', { name: /anmelden|erneut versuchen/i }).click()
  await page.getByLabel('Subject').fill(subject)
  await page.getByLabel('E-Mail').fill(`${subject}@example.com`)
  await page.getByLabel('Name', { exact: true }).fill(subject)
  await page.locator('#approve').click()
  await expect(page.getByText('Angemeldet als')).toBeVisible()
}

async function openWorkspace(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `${name} verwalten` }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

/**
 * Zeichnet ein Rechteck ueber die echte Excalidraw-Oberflaeche.
 *
 * Gezeichnet wird rechts der Mitte: die Werkzeug- und Eigenschaftsleisten liegen links und unten, und ein
 * Zug ueber einer Leiste erreicht die Zeichenflaeche nicht.
 */
async function drawRectangle(page: Page): Promise<void> {
  const canvas = page.locator('.excalidraw canvas').first()
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (box === null) {
    throw new Error('Die Zeichenflaeche hat keine Ausdehnung.')
  }
  const startX = box.x + box.width * 0.6
  const startY = box.y + box.height * 0.3
  // Erst die Flaeche fokussieren, sonst laeuft das Werkzeugkuerzel ins Leere.
  await page.mouse.click(startX, startY)
  await page.keyboard.press('r')
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 180, startY + 120, { steps: 10 })
  await page.mouse.up()
}

/**
 * Zaehlt die nicht weissen Bildpunkte der Zeichenflaeche. Liest ausschliesslich das DOM - die Anwendung
 * bekommt fuer den Test keinen Haken eingebaut.
 */
async function paintedPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('.excalidraw canvas'))
    let painted = 0
    for (const canvas of canvases) {
      const context = canvas.getContext('2d')
      if (context === null || canvas.width === 0 || canvas.height === 0) {
        continue
      }
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      for (let index = 0; index < data.length; index += 4) {
        const alpha = data[index + 3] ?? 0
        if (alpha > 0 && (data[index] !== 255 || data[index + 1] !== 255 || data[index + 2] !== 255)) {
          painted += 1
        }
      }
    }
    return painted
  })
}

test('legt ein Board an, zeichnet, speichert, laedt neu und findet den Inhalt wieder', async ({ page }) => {
  await page.goto('/')
  await signIn(page, 'e2e-board')

  await page.getByLabel('Name des neuen Arbeitsbereichs').fill('Team Nord')
  await page.getByRole('button', { name: 'Arbeitsbereich anlegen' }).click()
  await openWorkspace(page, 'Team Nord')

  await expect(page.getByText('In diesem Arbeitsbereich gibt es noch kein Board.')).toBeVisible()
  await page.getByLabel('Titel des neuen Boards').fill('Skizze Nord')
  await page.getByRole('button', { name: 'Board anlegen' }).click()
  await expect(page.getByRole('cell', { name: 'noch leer' })).toBeVisible()

  await page.getByRole('button', { name: 'Skizze Nord oeffnen' }).click()
  await expect(page.getByRole('heading', { name: 'Skizze Nord' })).toBeVisible()
  await expect(page.getByText('Keine ungespeicherten Aenderungen.')).toBeVisible()

  await drawRectangle(page)
  await expect.poll(async () => paintedPixels(page), { timeout: 10_000 }).toBeGreaterThan(0)
  // Gespeichert wird von selbst, kurz nach der letzten Aenderung.
  await expect(page.getByText(/^Gespeichert um /)).toBeVisible()

  // Neue Anwendungsinstanz im Browser: nichts steht mehr im Arbeitsspeicher der Seite.
  await page.reload()
  await openWorkspace(page, 'Team Nord')
  await expect(page.getByRole('cell', { name: 'Version 1' })).toBeVisible()

  await page.getByRole('button', { name: 'Skizze Nord oeffnen' }).click()
  await expect(page.getByRole('heading', { name: 'Skizze Nord' })).toBeVisible()
  await expect.poll(async () => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(0)
})

test('benennt ein Board um und findet es nach dem Archivieren in der Archivansicht wieder', async ({ page }) => {
  await page.goto('/')
  await signIn(page, 'e2e-board')

  await page.getByLabel('Name des neuen Arbeitsbereichs').fill('Team Sued')
  await page.getByRole('button', { name: 'Arbeitsbereich anlegen' }).click()
  await openWorkspace(page, 'Team Sued')

  await page.getByLabel('Titel des neuen Boards').fill('Erster Entwurf')
  await page.getByRole('button', { name: 'Board anlegen' }).click()
  await expect(page.getByRole('button', { name: 'Erster Entwurf oeffnen' })).toBeVisible()

  await page.getByRole('button', { name: 'Erster Entwurf umbenennen' }).click()
  await page.getByLabel('Neuer Titel fuer Erster Entwurf').fill('Zweiter Entwurf')
  await page.getByRole('button', { name: 'Titel speichern' }).click()
  await expect(page.getByRole('button', { name: 'Zweiter Entwurf oeffnen' })).toBeVisible()

  // Die Titelsuche laeuft serverseitig und trennt die beiden Titel.
  await page.getByLabel('Boards nach Titel suchen').fill('zweiter')
  await page.getByRole('button', { name: 'Boardliste filtern' }).click()
  await expect(page.getByRole('button', { name: 'Zweiter Entwurf oeffnen' })).toBeVisible()
  await page.getByLabel('Boards nach Titel suchen').fill('gibt es nicht')
  await page.getByRole('button', { name: 'Boardliste filtern' }).click()
  await expect(page.getByText('Kein Board mit "gibt es nicht" im Titel.')).toBeVisible()
  await page.getByRole('button', { name: 'Boardfilter aufheben' }).click()

  await page.getByRole('button', { name: 'Zweiter Entwurf archivieren' }).click()
  await expect(page.getByText('In diesem Arbeitsbereich gibt es noch kein Board.')).toBeVisible()

  await page.getByRole('button', { name: 'Archivierte Boards zeigen' }).click()
  await expect(page.getByRole('button', { name: 'Zweiter Entwurf oeffnen' })).toBeVisible()

  await page.getByRole('button', { name: 'Zweiter Entwurf entarchivieren' }).click()
  await expect(page.getByText('Es gibt keine archivierten Boards.')).toBeVisible()
  await page.getByRole('button', { name: 'Aktive Boards zeigen' }).click()
  await expect(page.getByRole('button', { name: 'Zweiter Entwurf oeffnen' })).toBeVisible()
})

/**
 * Bildassets im Browser.
 *
 * Das Bild geht ueber die echte Excalidraw-Oberflaeche in die Zeichenflaeche - dieselbe Werkzeugauswahl und
 * derselbe Dateidialog, die ein Mensch bedient. Danach zaehlt nur, was ueber die Leitung geht: ein Upload
 * mit 201 und nach dem Neuladen ein autorisierter Abruf mit 200, dessen Bytes auf dem Canvas landen.
 */
const BILD = solidPng(120, 90, [220, 30, 30])

type Assetverkehr = { readonly methode: string; readonly status: number }

/** Zeichnet jeden Zugriff auf den Assetendpunkt mit. Die Anwendung bekommt dafuer keinen Haken eingebaut. */
function beobachteAssets(page: Page): Assetverkehr[] {
  const verkehr: Assetverkehr[] = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === BOARD_ASSETS_PATH) {
      verkehr.push({ methode: response.request().method(), status: response.status() })
    }
  })
  return verkehr
}

/**
 * Fuegt ein Bild ueber die Zwischenablage in die Zeichenflaeche ein - `Strg+V`, der Weg, den ein Mensch
 * fuer eine Bildschirmaufnahme nimmt.
 *
 * Bewusst nicht ueber den Dateidialog: Chromium oeffnet dafuer die File System Access API, und deren Dialog
 * ist kein `<input type="file">`, das ein Test bedienen koennte. Die Zwischenablage fuehrt durch dieselbe
 * Excalidraw-Logik und denselben Adapter - nur der Ausloeser ist ein anderer.
 */
async function fuegeBildEin(page: Page): Promise<void> {
  const canvas = page.locator('.excalidraw canvas').first()
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (box === null) {
    throw new Error('Die Zeichenflaeche hat keine Ausdehnung.')
  }
  // Excalidraw nimmt eine Einfuegung nur an, wenn der Zeiger ueber der Zeichenflaeche steht und der Fokus
  // im Editor liegt. Beides entsteht durch den Klick.
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.35)
  await page.evaluate((base64) => {
    const binaer = atob(base64)
    const bytes = new Uint8Array(binaer.length)
    for (let index = 0; index < binaer.length; index += 1) {
      bytes[index] = binaer.charCodeAt(index)
    }
    const daten = new DataTransfer()
    daten.items.add(new File([bytes], 'punkt.png', { type: 'image/png' }))
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: daten, bubbles: true, cancelable: true }))
  }, BILD.toString('base64'))
}

test('fuegt ein Bild ein, speichert, laedt die Anwendung neu und findet das Bild wieder', async ({ page }) => {
  const verkehr = beobachteAssets(page)
  await page.goto('/')
  await signIn(page, 'e2e-bild')

  await page.getByLabel('Name des neuen Arbeitsbereichs').fill('Team Bild')
  await page.getByRole('button', { name: 'Arbeitsbereich anlegen' }).click()
  await openWorkspace(page, 'Team Bild')
  await page.getByLabel('Titel des neuen Boards').fill('Bildboard')
  await page.getByRole('button', { name: 'Board anlegen' }).click()
  await page.getByRole('button', { name: 'Bildboard oeffnen' }).click()
  await expect(page.getByRole('heading', { name: 'Bildboard' })).toBeVisible()

  await fuegeBildEin(page)

  // Das Bild geht ueber den autorisierten Upload; erst danach darf die Szene es referenzieren.
  await expect
    .poll(() => verkehr.filter((eintrag) => eintrag.methode === 'POST' && eintrag.status === 201).length, {
      timeout: 15_000,
    })
    .toBe(1)
  await expect(page.getByText(/^Gespeichert um /)).toBeVisible()

  // Neue Anwendungsinstanz im Browser: weder Szene noch Bild stehen noch im Arbeitsspeicher der Seite.
  await page.reload()
  await openWorkspace(page, 'Team Bild')
  await expect(page.getByRole('cell', { name: 'Version 1' })).toBeVisible()
  await page.getByRole('button', { name: 'Bildboard oeffnen' }).click()
  await expect(page.getByRole('heading', { name: 'Bildboard' })).toBeVisible()

  await expect
    .poll(() => verkehr.filter((eintrag) => eintrag.methode === 'GET' && eintrag.status === 200).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0)
  await expect.poll(async () => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(0)
  // Kein Abruf ist fehlgeschlagen, und es gibt keine Meldung ueber ein fehlendes Bild.
  expect(verkehr.filter((eintrag) => eintrag.status >= 400)).toEqual([])
  await expect(page.getByText('Mindestens ein Bild dieses Boards konnte nicht geladen werden.')).toHaveCount(0)
})

/**
 * Content-Security-Policy im Editor.
 *
 * **Die Policy wurde fuer den Editor nicht gelockert**: `default-src 'self'`, kein `unsafe-inline`. Belegt
 * werden drei Dinge:
 *
 * 1. Keine Anfrage der Seite verlaesst erfolgreich die eigene Herkunft.
 * 2. Die Schriften des Editors kommen aus dem eigenen Build.
 * 3. Die einzigen gemeldeten Verstoesse sind die beiden bekannten, und beide werden gewollt blockiert:
 *    - der CDN-Rueckfall, den Excalidraw fest an jede Schriftquelle anhaengt
 *      (`https://esm.sh/@excalidraw/excalidraw@0.18.1/...`). Er steht hinter der eigenen Quelle und wird
 *      nie benutzt.
 *    - `script-src wasm-eval`: Excalidraw kompiliert fuer die Schriftreduktion ein Harfbuzz-WebAssembly.
 *      Das braeuchte `'wasm-unsafe-eval'` in `script-src`. Die Policy erlaubt es bewusst nicht - Zeichnen,
 *      Bilder, Speichern und Laden funktionieren ohne, wie der Bildtest oben belegt. Der Export mit
 *      reduzierten Schriften ist kein Gegenstand dieses Pakets.
 */
const CDN_RUECKFALL = 'https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/'

/** Bekannt, benannt und blockiert. Alles andere waere ein echter Verstoss. */
const BEKANNTE_VERSTOESSE = [`font-src ${CDN_RUECKFALL}`, 'script-src wasm-eval']

test('laedt den Board-Editor ohne Lockerung der Content-Security-Policy', async ({ page }) => {
  const verkehrCsp = beobachteAssets(page)
  await page.addInitScript(() => {
    const seite = window as unknown as { __cspVerstoesse?: string[] }
    seite.__cspVerstoesse = []
    document.addEventListener('securitypolicyviolation', (event) => {
      seite.__cspVerstoesse?.push(`${event.violatedDirective} ${event.blockedURI}`)
    })
  })

  const erste = await page.goto('/')
  expect(erste?.headers()['content-security-policy']).toContain("default-src 'self'")
  expect(erste?.headers()['content-security-policy']).not.toContain('unsafe-inline')
  await signIn(page, 'e2e-csp')

  // Ab hier zaehlt jede Anfrage: nach der Anmeldung darf keine mehr die eigene Herkunft erreichen.
  const eigeneHerkunft = new URL(page.url()).origin
  const fremdeAnfragen: string[] = []
  const abgewiesen = new Set<string>()
  const eigeneSchriften: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin !== eigeneHerkunft) {
      fremdeAnfragen.push(request.url())
    }
    if (url.pathname.startsWith('/excalidraw-assets/fonts/')) {
      eigeneSchriften.push(url.pathname)
    }
  })
  page.on('requestfailed', (request) => {
    abgewiesen.add(request.url())
  })

  await page.getByLabel('Name des neuen Arbeitsbereichs').fill('Team CSP')
  await page.getByRole('button', { name: 'Arbeitsbereich anlegen' }).click()
  await openWorkspace(page, 'Team CSP')
  await page.getByLabel('Titel des neuen Boards').fill('CSP Board')
  await page.getByRole('button', { name: 'Board anlegen' }).click()
  await page.getByRole('button', { name: 'CSP Board oeffnen' }).click()
  await expect(page.locator('.excalidraw')).toBeVisible()

  await drawRectangle(page)
  await expect(page.getByText(/^Gespeichert um /)).toBeVisible()

  // Auch mit einem Bild bleibt die Policy unangetastet: die Bytes kommen ueber den eigenen Endpunkt und
  // werden als `data:`-Verweis eingebettet, was `img-src 'self' data: blob:` seit Beginn erlaubt.
  await fuegeBildEin(page)
  await expect.poll(() => verkehrCsp.filter((eintrag) => eintrag.status === 201).length, { timeout: 15_000 }).toBe(1)

  // Eine Schrift wirklich anfordern: sie kommt aus dem eigenen Build, nicht vom CDN.
  await page.evaluate(async () => {
    await document.fonts.load('20px Excalifont', 'Schriftprobe')
  })
  await expect.poll(() => eigeneSchriften.length, { timeout: 10_000 }).toBeGreaterThan(0)

  // Alles Fremde ist der Rueckfall - und jede dieser Anfragen wurde abgewiesen, statt beantwortet zu werden.
  expect(fremdeAnfragen.filter((url) => !url.startsWith(CDN_RUECKFALL))).toEqual([])
  expect(fremdeAnfragen.filter((url) => !abgewiesen.has(url))).toEqual([])

  const verstoesse = await page.evaluate(
    () => (window as unknown as { __cspVerstoesse?: string[] }).__cspVerstoesse ?? [],
  )
  expect(
    verstoesse.filter((eintrag) => !BEKANNTE_VERSTOESSE.some((bekannt) => eintrag.startsWith(bekannt))),
  ).toEqual([])
})
