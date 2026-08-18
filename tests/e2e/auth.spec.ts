/**
 * Anmeldung im Browser gegen einen echten OIDC-Provider.
 *
 * Es gibt keine Abkuerzung um den Fluss herum: der Browser laeuft ueber die Weiterleitung zum Provider, das
 * dortige Anmeldeformular und den Callback. Fehlerlagen entstehen dadurch, dass der Provider sich falsch
 * verhaelt oder der Nutzer abbricht.
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

async function signIn(page: Page, subject: string, decision: 'approve' | 'deny' = 'approve'): Promise<void> {
  await page.getByRole('link', { name: /anmelden|erneut versuchen/i }).click()
  await page.getByLabel('Subject').fill(subject)
  await page.getByLabel('E-Mail').fill(`${subject}@example.com`)
  await page.getByLabel('Name', { exact: true }).fill(subject)
  await page.locator(decision === 'approve' ? '#approve' : '#deny').click()
}

test('meldet den ersten Nutzer an, zeigt ihn in der Huelle und meldet ihn wieder ab', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Mit Identity Provider anmelden' })).toBeVisible()

  await signIn(page, 'e2e-admin')

  await expect(page.getByText('Angemeldet als')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Systemadministration' })).toBeVisible()

  // Nachweis im Browser: die Sitzung lebt ausschliesslich im HttpOnly-Cookie, nicht im Storage.
  const storage = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }))
  expect(storage.local).toEqual([])
  expect(storage.session).toEqual([])
  const cookies = await page.context().cookies()
  const sessionCookie = cookies.find((cookie) => cookie.name === 'canvaz_session')
  expect(sessionCookie?.httpOnly).toBe(true)
  expect(sessionCookie?.sameSite).toBe('Lax')

  await page.getByRole('button', { name: 'Abmelden' }).click()

  await expect(page.getByRole('link', { name: /anmelden/i })).toBeVisible()
  await expect(page.getByText('Angemeldet als')).toBeHidden()
})

test('zeigt einen Abbruch beim Provider mit Wiederholungsweg', async ({ page }) => {
  await page.goto('/')

  await signIn(page, 'e2e-abbruch', 'deny')

  await expect(page.getByRole('alert')).toContainText('abgebrochen')
  await expect(page.getByRole('link', { name: 'Anmeldung erneut versuchen' })).toBeVisible()
})

test('zeigt einen nicht erreichbaren Provider mit Wiederholungsweg', async ({ page }) => {
  await fetch(`${E2E_PROVIDER_URL}/__control`, {
    method: 'POST',
    body: JSON.stringify({ tokenEndpointOffline: true }),
  })
  await page.goto('/')

  await signIn(page, 'e2e-fehler')

  await expect(page.getByRole('alert')).toContainText('nicht erreichbar')

  await fetch(`${E2E_PROVIDER_URL}/__control`, { method: 'POST', body: '{}' })
  await signIn(page, 'e2e-fehler')
  await expect(page.getByText('Angemeldet als')).toBeVisible()
})

test('beendet die Sitzung eines deaktivierten Nutzers und verweigert die Neuanmeldung', async ({ page, browser }) => {
  await page.goto('/')
  await signIn(page, 'e2e-admin')
  await expect(page.getByText('Angemeldet als')).toBeVisible()

  const zweiterKontext = await browser.newContext()
  const zweiteSeite = await zweiterKontext.newPage()
  await zweiteSeite.goto('/')
  await signIn(zweiteSeite, 'e2e-nutzer')
  await expect(zweiteSeite.getByText('Angemeldet als')).toBeVisible()
  // Ohne Systemadminrolle gibt es keine Administrationsansicht.
  await expect(zweiteSeite.getByRole('heading', { name: 'Systemadministration' })).toBeHidden()

  await page.reload()
  await page.getByRole('button', { name: 'e2e-nutzer deaktivieren' }).click()
  await expect(page.getByRole('button', { name: 'e2e-nutzer aktivieren' })).toBeVisible()

  await zweiteSeite.reload()
  await expect(zweiteSeite.getByRole('link', { name: /anmelden/i })).toBeVisible()

  await signIn(zweiteSeite, 'e2e-nutzer')
  await expect(zweiteSeite.getByRole('alert')).toContainText('deaktiviert')

  await zweiterKontext.close()
})
