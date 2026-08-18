/**
 * Echtzeit-Kollaboration im Browser: zwei getrennte Browserkontexte auf demselben Board.
 *
 * Gezeichnet wird ueber die echte Excalidraw-Oberflaeche und uebertragen ueber die echte WebSocket-Strecke.
 * Der Test liest die Zeichenflaeche des jeweils anderen aus - es gibt keinen eingebauten Haken und keine
 * Testschnittstelle. Nebenbei belegt er, dass die enge Content-Security-Policy die eigene WebSocket-Strecke
 * traegt: waere sie blockiert, kaeme drueben nie etwas an.
 */

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'

import { E2E_DATABASE_URL, E2E_PROVIDER_URL } from '../../playwright.config.js'

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

/** Zeichnet ein Rechteck rechts der Mitte; die Leisten liegen links und unten. */
async function drawRectangle(page: Page, offset = 0): Promise<void> {
  const canvas = page.locator('.excalidraw canvas').first()
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (box === null) {
    throw new Error('Die Zeichenflaeche hat keine Ausdehnung.')
  }
  const startX = box.x + box.width * 0.6
  const startY = box.y + box.height * 0.25 + offset
  await page.mouse.click(startX, startY)
  await page.keyboard.press('r')
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 160, startY + 90, { steps: 10 })
  await page.mouse.up()
}

/** Zaehlt die nicht weissen Bildpunkte der Zeichenflaeche. Liest ausschliesslich das DOM. */
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

async function openBoard(page: Page, workspace: string, board: string): Promise<void> {
  await page.getByRole('button', { name: `${workspace} verwalten` }).click()
  await expect(page.getByRole('heading', { name: workspace })).toBeVisible()
  await page.getByRole('button', { name: `${board} oeffnen` }).click()
  await expect(page.getByRole('heading', { name: board })).toBeVisible()
  await expect(page.getByText('Live verbunden.')).toBeVisible()
}

test('zwei Browser sehen Zeichnung und Presence des jeweils anderen', async ({ page, browser }) => {
  await page.goto('/')
  await signIn(page, 'e2e-owner')

  // Der zweite Nutzer muss existieren, bevor er aufgenommen werden kann.
  const zweiterKontext = await browser.newContext()
  const mitglied = await zweiterKontext.newPage()
  await mitglied.goto('/')
  await signIn(mitglied, 'e2e-gast')

  await page.getByLabel('Name des neuen Arbeitsbereichs').fill('Team Live')
  await page.getByRole('button', { name: 'Arbeitsbereich anlegen' }).click()
  await page.getByRole('button', { name: 'Team Live verwalten' }).click()
  await page.getByLabel(/Nutzer suchen/).fill('e2e-gast@example.com')
  await page.getByRole('button', { name: 'Suchen' }).click()
  await page.getByRole('radio', { name: 'e2e-gast (e2e-gast@example.com)' }).check()
  await page.getByLabel('Rolle', { exact: true }).selectOption('member')
  await page.getByRole('button', { name: 'Mitglied hinzufuegen' }).click()
  await expect(page.getByLabel('Rolle von e2e-gast')).toBeVisible()

  await page.getByLabel('Titel des neuen Boards').fill('Gemeinsam')
  await page.getByRole('button', { name: 'Board anlegen' }).click()
  await expect(page.getByRole('button', { name: 'Gemeinsam oeffnen' })).toBeVisible()

  await page.getByRole('button', { name: 'Gemeinsam oeffnen' }).click()
  await expect(page.getByRole('heading', { name: 'Gemeinsam' })).toBeVisible()
  await expect(page.getByText('Live verbunden.')).toBeVisible()
  await expect(page.getByText('Allein auf diesem Board.')).toBeVisible()

  await mitglied.reload()
  await openBoard(mitglied, 'Team Live', 'Gemeinsam')

  // Presence: beide sehen den jeweils anderen namentlich.
  await expect(page.getByText('Mit dabei: e2e-gast')).toBeVisible()
  await expect(mitglied.getByText('Mit dabei: e2e-owner')).toBeVisible()

  // Die Zeichnung des einen erscheint beim anderen, ohne dass jemand neu laedt.
  await drawRectangle(page)
  await expect.poll(async () => paintedPixels(mitglied), { timeout: 15_000 }).toBeGreaterThan(0)

  // Und in der Gegenrichtung ebenso.
  const vorher = await paintedPixels(page)
  await drawRectangle(mitglied, 200)
  await expect.poll(async () => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(vorher)

  // Der Server persistiert getaktet; beide sehen denselben Speicherstatus.
  await expect(page.getByText(/^Gespeichert um /)).toBeVisible()
  await expect(mitglied.getByText(/^Gespeichert um /)).toBeVisible()

  await zweiterKontext.close()
})

test('ein Teilnehmer ohne Schreibrecht empfaengt weiter, kann aber nicht mehr schreiben', async ({ page, browser }) => {
  await page.goto('/')
  await signIn(page, 'e2e-owner')

  const zweiterKontext = await browser.newContext()
  const mitglied = await zweiterKontext.newPage()
  await mitglied.goto('/')
  await signIn(mitglied, 'e2e-gast')

  await page.getByLabel('Name des neuen Arbeitsbereichs').fill('Team Lesen')
  await page.getByRole('button', { name: 'Arbeitsbereich anlegen' }).click()
  await page.getByRole('button', { name: 'Team Lesen verwalten' }).click()
  await page.getByLabel(/Nutzer suchen/).fill('e2e-gast@example.com')
  await page.getByRole('button', { name: 'Suchen' }).click()
  await page.getByRole('radio', { name: 'e2e-gast (e2e-gast@example.com)' }).check()
  await page.getByLabel('Rolle', { exact: true }).selectOption('member')
  await page.getByRole('button', { name: 'Mitglied hinzufuegen' }).click()
  await expect(page.getByLabel('Rolle von e2e-gast')).toBeVisible()

  await page.getByLabel('Titel des neuen Boards').fill('Nur Lesen')
  await page.getByRole('button', { name: 'Board anlegen' }).click()
  await mitglied.reload()
  await openBoard(mitglied, 'Team Lesen', 'Nur Lesen')

  // Serverseitiger Entzug des Schreibrechts, waehrend das Mitglied das Board offen hat.
  await page.getByRole('button', { name: 'Nur Lesen archivieren' }).click()
  // Ein archiviertes Board verschwindet aus der aktiven Liste.
  await expect(page.getByRole('button', { name: 'Nur Lesen oeffnen' })).toBeHidden()

  // Die offene Verbindung wird herabgestuft, ohne dass sich jemand neu anmeldet.
  await expect(mitglied.getByText('Nur Lesen: keine Schreibberechtigung.')).toBeVisible()
  await expect(mitglied.getByText('Live verbunden.')).toBeVisible()

  await drawRectangle(mitglied)
  // Weder die Zeichenflaeche noch der Server nehmen etwas an. Der Takt der Checkpoints liegt bei Sekunden;
  // danach steht immer noch keine Version in der Datenbank.
  await mitglied.waitForTimeout(3_000)
  const versionen = await pool.query<{ count: string }>('select count(*) from scene_versions')
  expect(Number(versionen.rows[0]?.count ?? '0')).toBe(0)
  expect(await paintedPixels(mitglied)).toBe(0)

  await zweiterKontext.close()
})
