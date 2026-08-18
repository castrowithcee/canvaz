import { expect, test, type Page } from '@playwright/test'

const SERVER = 'ws://127.0.0.1:3101'

/** Lesehaken der Anwendung. Der Test liest damit den Editorzustand, ohne ihn zu veraendern. */
declare global {
  interface Window {
    __canvazSpike: {
      elementCount(): number
      elementIds(): string[]
      status(): string
      role(): string | null
      rejection(): { code: string; message: string } | null
      sendUncheckedElements(elements: readonly Record<string, unknown>[]): void
      dropConnection(): void
    }
  }
}

async function openBoard(page: Page, board: string, token: string): Promise<void> {
  await page.goto(`/?board=${board}&token=${token}&server=${encodeURIComponent(SERVER)}`)
  await expect(page.getByTestId('connection-status')).toHaveText('online')
  await expect(page.locator('.excalidraw')).toBeVisible()
}

/** Zeichnet ein Rechteck ueber die echte Excalidraw-Oberflaeche statt ueber eine Testschnittstelle. */
async function drawRectangle(page: Page, offsetX: number): Promise<void> {
  const canvas = page.locator('.excalidraw canvas').first()
  const box = await canvas.boundingBox()
  if (box === null) {
    throw new Error('Excalidraw-Canvas hat keine Flaeche.')
  }
  // Erst den Canvas fokussieren, sonst laeuft das Werkzeugkuerzel ins Leere.
  await page.mouse.click(box.x + box.width - 60, box.y + box.height - 60)
  await page.keyboard.press('r')
  await expect(page.locator('[data-testid="toolbar-rectangle"]')).toBeChecked()

  const startX = box.x + offsetX
  const startY = box.y + 200
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 120, startY + 80, { steps: 8 })
  await page.mouse.up()
}

function elementCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__canvazSpike.elementCount())
}

test.describe('Zwei-Browser-Kollaboration', () => {
  test('spiegelt eine Zeichnung und die Anwesenheit zum zweiten Editor', async ({ browser }) => {
    const board = 'e2e-sync'
    const contextA = await browser.newContext()
    const contextB = await browser.newContext()
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    await openBoard(pageA, board, 'spike-editor')
    await openBoard(pageB, board, 'spike-editor-2')

    await expect(pageA.getByTestId('peer-count')).toHaveText('2')
    await expect(pageB.getByTestId('peer-count')).toHaveText('2')

    await drawRectangle(pageA, 250)

    await expect.poll(() => elementCount(pageB)).toBe(1)
    await expect.poll(() => elementCount(pageA)).toBe(1)

    await drawRectangle(pageB, 500)

    await expect.poll(() => elementCount(pageA)).toBe(2)
    await expect.poll(() => elementCount(pageB)).toBe(2)

    const idsA = await pageA.evaluate(() => window.__canvazSpike.elementIds().sort())
    const idsB = await pageB.evaluate(() => window.__canvazSpike.elementIds().sort())
    expect(idsA).toEqual(idsB)

    await contextA.close()
    await contextB.close()
  })

  test('verwirft die Zeichnung eines Viewers serverseitig', async ({ browser }) => {
    const board = 'e2e-readonly'
    const contextEditor = await browser.newContext()
    const contextViewer = await browser.newContext()
    const editor = await contextEditor.newPage()
    const viewer = await contextViewer.newPage()

    await openBoard(editor, board, 'spike-editor')
    await openBoard(viewer, board, 'spike-viewer')

    await expect(viewer.getByTestId('role')).toHaveText('viewer')
    // Ein Viewer erhaelt gar keine Werkzeugleiste; der Schutz darf sich darauf aber nicht verlassen.
    await expect(viewer.locator('[data-testid="toolbar-rectangle"]')).toHaveCount(0)

    // Manipulierter Client: die Mutation geht ueber die echte Verbindung an der lokalen Sperre vorbei.
    await viewer.evaluate(() => {
      window.__canvazSpike.sendUncheckedElements([
        { id: 'viewer-versuch', version: 1, versionNonce: 5, type: 'rectangle', x: 10, y: 10 },
      ])
    })

    await expect(viewer.getByTestId('rejection')).toContainText('read-only')
    await expect.poll(() => elementCount(editor), { timeout: 5_000 }).toBe(0)
    expect(await elementCount(viewer)).toBe(0)

    await contextEditor.close()
    await contextViewer.close()
  })

  test('gleicht nach einem Reconnect den vollstaendigen Boardzustand ab', async ({ browser }) => {
    const board = 'e2e-reconnect'
    const contextA = await browser.newContext()
    const contextB = await browser.newContext()
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    await openBoard(pageA, board, 'spike-editor')
    await openBoard(pageB, board, 'spike-editor-2')

    await drawRectangle(pageA, 250)
    await expect.poll(() => elementCount(pageB)).toBe(1)

    // Jeder neue Verbindungsversuch von B scheitert, danach faellt die bestehende Verbindung aus.
    await pageB.routeWebSocket(/\/ws\?/, (ws) => {
      ws.close()
    })
    await pageB.evaluate(() => {
      window.__canvazSpike.dropConnection()
    })
    await expect(pageB.getByTestId('connection-status')).toHaveText('offline')

    await drawRectangle(pageA, 450)
    await drawRectangle(pageA, 650)
    await expect.poll(() => elementCount(pageA)).toBe(3)

    await pageB.unrouteAll()
    await expect(pageB.getByTestId('connection-status')).toHaveText('online', { timeout: 30_000 })

    await expect.poll(() => elementCount(pageB), { timeout: 20_000 }).toBe(3)
    const idsA = await pageA.evaluate(() => window.__canvazSpike.elementIds().sort())
    const idsB = await pageB.evaluate(() => window.__canvazSpike.elementIds().sort())
    expect(idsB).toEqual(idsA)

    await contextA.close()
    await contextB.close()
  })

  test('oeffnet ein persistiertes Board nach einem Neuladen verlustfrei', async ({ browser }) => {
    const board = 'e2e-persistenz'
    const context = await browser.newContext()
    const page = await context.newPage()

    await openBoard(page, board, 'spike-editor')
    await drawRectangle(page, 250)
    await drawRectangle(page, 450)
    await expect.poll(() => elementCount(page)).toBe(2)
    const idsBefore = await page.evaluate(() => window.__canvazSpike.elementIds().sort())

    // Der Server haelt den Zustand; ein leerer Client muss ihn vollstaendig zurueckbekommen.
    await page.reload()
    await expect(page.getByTestId('connection-status')).toHaveText('online')

    await expect.poll(() => elementCount(page)).toBe(2)
    expect(await page.evaluate(() => window.__canvazSpike.elementIds().sort())).toEqual(idsBefore)

    await context.close()
  })
})
