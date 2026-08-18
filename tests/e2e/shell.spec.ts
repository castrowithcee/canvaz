import { expect, test } from '@playwright/test'

test('liefert die Anwendungshuelle aus', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Canvaz' })).toBeVisible()
})
