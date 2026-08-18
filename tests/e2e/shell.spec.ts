import { expect, test } from '@playwright/test'

test('liefert die Anwendungshuelle aus', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Canvaz' })).toBeVisible()
})

test('laedt die Oberflaeche ohne Verstoss gegen die Content-Security-Policy', async ({ page }) => {
  // Der Browser meldet jeden blockierten Ladevorgang selbst; gesammelt wird, was die Seite tatsaechlich braucht.
  await page.addInitScript(() => {
    const seite = window as unknown as { __cspVerstoesse?: string[] }
    seite.__cspVerstoesse = []
    document.addEventListener('securitypolicyviolation', (event) => {
      seite.__cspVerstoesse?.push(`${event.violatedDirective} ${event.blockedURI}`)
    })
  })

  const response = await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Canvaz' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Mit Identity Provider anmelden' })).toBeVisible()

  const headers = response?.headers() ?? {}
  expect(headers['content-security-policy']).toContain("default-src 'self'")
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['referrer-policy']).toBe('no-referrer')
  expect(await page.evaluate(() => (window as unknown as { __cspVerstoesse?: string[] }).__cspVerstoesse)).toEqual([])
})
