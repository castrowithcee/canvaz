/**
 * Persoenliche Bibliothek.
 *
 * Beide Routen kennen keinen Nutzerparameter: gelesen und geschrieben wird ausschliesslich die Bibliothek
 * dessen, der die Sitzung fuehrt. Ein Gast hat keine interne Sitzung und damit keine Bibliothek - er bekommt
 * dieselbe 401 wie ein Unangemeldeter.
 *
 * Geschrieben wird immer die ganze Liste auf einer genannten Revision. Ist die ueberholt, weil ein anderes
 * Fenster inzwischen gespeichert hat, antwortet der Server mit 409 und schreibt nichts; der Client laedt den
 * neuen Stand und fuehrt zusammen. Inhalte der Bibliothek erscheinen in keinem Protokoll.
 */

import type { LibraryView, SaveLibraryResponse } from '../contracts/api.js'
import { ME_LIBRARY_PATH } from '../contracts/api.js'
import { LIBRARY_REJECTION_MESSAGES, checkLibraryItems } from '../contracts/library.js'
import type { AppContext } from './context.js'
import { requireCsrfToken, requireSession } from './guard.js'
import type { Route } from './http.js'
import { readJsonBodyLimited, sendError, sendJson } from './http.js'
import { asRequester } from './requester.js'

const EMPTY_LIBRARY: LibraryView = { revision: 0, items: [] }

export function createLibraryRoutes(context: AppContext): readonly Route[] {
  // Dieselbe Grenze wie fuer eine Szene: eine Bibliothek ist hoechstens so gross wie ein Board.
  const maxBytes = context.config.maxSceneBytes
  const maxMegabytes = (maxBytes / (1024 * 1024)).toLocaleString('de-DE', { maximumFractionDigits: 1 })

  return [
    {
      method: 'GET',
      path: ME_LIBRARY_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        const library = await context.identity.libraries.findByUserId(auth.user.id)
        const body: LibraryView = library ?? EMPTY_LIBRARY
        sendJson(response, 200, body)
      },
    },

    {
      method: 'POST',
      path: ME_LIBRARY_PATH,
      handle: async ({ request, response }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null || !requireCsrfToken(context, request, response, asRequester(auth))) {
          return
        }
        const body = await readJsonBodyLimited(request, maxBytes)
        if (!body.ok) {
          if (body.reason === 'too-large') {
            sendError(response, 413, `Die Bibliothek ist zu gross. Erlaubt sind hoechstens ${maxMegabytes} MB.`)
          } else {
            sendError(response, 400, LIBRARY_REJECTION_MESSAGES.ungueltig)
          }
          return
        }
        const revision = body.body['revision']
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
          sendError(response, 400, LIBRARY_REJECTION_MESSAGES.ungueltig)
          return
        }
        const checked = checkLibraryItems(body.body['items'])
        if (!checked.ok) {
          sendError(response, 400, LIBRARY_REJECTION_MESSAGES[checked.reason])
          return
        }
        const next = await context.identity.libraries.replace(auth.user.id, checked.items, revision)
        if (next === null) {
          sendError(
            response,
            409,
            'Die Bibliothek wurde inzwischen an anderer Stelle geaendert. Nichts wurde ueberschrieben.',
          )
          return
        }
        const reply: SaveLibraryResponse = { revision: next }
        sendJson(response, 200, reply)
      },
    },
  ]
}
