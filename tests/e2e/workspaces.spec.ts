/**
 * Arbeitsbereiche im Browser: anlegen, Mitglied aufnehmen, Rolle wechseln, Zugriff entziehen.
 *
 * Beide Nutzer melden sich ueber den echten OIDC-Fluss an. Die Wirkung des Entzugs wird dort geprueft, wo
 * sie zaehlt - in der Sitzung des betroffenen Nutzers.
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

test('legt einen Arbeitsbereich an, nimmt ein Mitglied auf, wechselt die Rolle und entzieht den Zugriff', async ({
  page,
  browser,
}) => {
  await page.goto('/')
  await signIn(page, 'e2e-owner')
  await expect(page.getByText('Du gehoerst noch keinem Arbeitsbereich an.')).toBeVisible()

  // Der zweite Nutzer muss existieren, bevor er zur Aufnahme angeboten werden kann.
  const zweiterKontext = await browser.newContext()
  const mitglied = await zweiterKontext.newPage()
  await mitglied.goto('/')
  await signIn(mitglied, 'e2e-mitglied')
  await expect(mitglied.getByText('Du gehoerst noch keinem Arbeitsbereich an.')).toBeVisible()

  await page.getByLabel('Name des neuen Arbeitsbereichs').fill('Team Nord')
  await page.getByRole('button', { name: 'Arbeitsbereich anlegen' }).click()
  await expect(page.getByRole('cell', { name: 'Team Nord', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Owner', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Team Nord verwalten' }).click()
  await expect(page.getByRole('heading', { name: 'Team Nord' })).toBeVisible()

  // Es gibt keine Auswahlliste aller Nutzer, sondern nur eine gezielte Suche - und ein Praefix reicht nicht.
  await expect(page.getByRole('button', { name: 'Mitglied hinzufuegen' })).toBeHidden()
  await page.getByLabel(/Nutzer suchen/).fill('e2e-mit')
  await page.getByRole('button', { name: 'Suchen' }).click()
  await expect(page.getByText('Kein Treffer')).toBeVisible()

  await page.getByLabel(/Nutzer suchen/).fill('e2e-mitglied@example.com')
  await page.getByRole('button', { name: 'Suchen' }).click()
  await page.getByRole('radio', { name: 'e2e-mitglied (e2e-mitglied@example.com)' }).check()
  await page.getByLabel('Rolle', { exact: true }).selectOption('member')
  await page.getByRole('button', { name: 'Mitglied hinzufuegen' }).click()
  await expect(page.getByLabel('Rolle von e2e-mitglied')).toBeVisible()

  // Der Zugriff steht dem Mitglied ohne Zutun offen, sobald es nachlaedt.
  await mitglied.reload()
  await expect(mitglied.getByRole('cell', { name: 'Team Nord', exact: true })).toBeVisible()
  await expect(mitglied.getByRole('cell', { name: 'Mitglied', exact: true })).toBeVisible()
  await mitglied.getByRole('button', { name: 'Team Nord verwalten' }).click()
  // Ein Mitglied bekommt keine Verwaltung angeboten; die Grenze selbst liegt auf dem Server.
  await expect(mitglied.getByRole('button', { name: 'Mitglied hinzufuegen' })).toBeHidden()
  await expect(mitglied.getByLabel(/Nutzer suchen/)).toBeHidden()

  await page.getByLabel('Rolle von e2e-mitglied').selectOption('admin')
  await page.getByRole('button', { name: 'Rolle von e2e-mitglied speichern' }).click()
  await expect(page.getByLabel('Rolle von e2e-mitglied')).toHaveValue('admin')

  await mitglied.reload()
  await expect(mitglied.getByRole('cell', { name: 'Admin', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'e2e-mitglied entfernen' }).click()
  await expect(page.getByLabel('Rolle von e2e-mitglied')).toBeHidden()

  await mitglied.reload()
  await expect(mitglied.getByText('Du gehoerst noch keinem Arbeitsbereich an.')).toBeVisible()
  await expect(mitglied.getByRole('cell', { name: 'Team Nord', exact: true })).toBeHidden()

  await zweiterKontext.close()
})

test('archiviert einen Arbeitsbereich und laesst ihn lesbar, aber unveraenderlich', async ({ page }) => {
  await page.goto('/')
  await signIn(page, 'e2e-owner')

  await page.getByLabel('Name des neuen Arbeitsbereichs').fill('Team Sued')
  await page.getByRole('button', { name: 'Arbeitsbereich anlegen' }).click()
  await page.getByRole('button', { name: 'Team Sued verwalten' }).click()

  await page.getByRole('button', { name: 'Arbeitsbereich archivieren' }).click()

  await expect(page.getByRole('heading', { name: 'Team Sued (archiviert)' })).toBeVisible()
  await expect(page.getByText('lesbar, aber nicht mehr aenderbar')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mitglied hinzufuegen' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Archivierung aufheben' })).toBeVisible()

  await page.getByRole('button', { name: 'Archivierung aufheben' }).click()
  await expect(page.getByRole('heading', { name: 'Team Sued', exact: true })).toBeVisible()
})
