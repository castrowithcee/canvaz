/**
 * Instance branding: name, default accent and logo.
 *
 * The admin routes require a session and `isSystemAdmin`, changes also the CSRF token. The public routes
 * need no session and expose exactly name, accent and logo, nothing about accounts or configuration.
 */

import { createHash } from 'node:crypto'

import type { AdminBrandingView, PublicBrandingResponse } from '../contracts/api.js'
import {
  ADMIN_BRANDING_LOGO_PATH,
  ADMIN_BRANDING_LOGO_REMOVE_PATH,
  ADMIN_BRANDING_PATH,
  BRANDING_LOGO_PATH,
  BRANDING_LOGO_VERSION_PARAM,
  BRANDING_PATH,
  MAX_BRANDING_LOGO_BYTES,
  MAX_INSTANCE_NAME_LENGTH,
  parseAccentColor,
} from '../contracts/api.js'
import type { InstanceBranding } from '../domain/branding/model.js'
import {
  buildLogoKey,
  effectiveInstanceName,
  logoVersionOf,
  normalizeInstanceName,
  sniffLogoType,
} from '../domain/branding/model.js'
import type { AppContext } from './context.js'
import { requireCsrfToken, requireSession, requireSystemAdmin } from './guard.js'
import type { Route } from './http.js'
import { readBinaryBodyLimited, readJsonBody, sendBytes, sendError, sendJson } from './http.js'
import { describeError } from './log.js'
import { asRequester } from './requester.js'

function toPublicView(branding: InstanceBranding): PublicBrandingResponse {
  return {
    instanceName: effectiveInstanceName(branding),
    accent: branding.accent,
    logoVersion: logoVersionOf(branding),
  }
}

function toAdminView(branding: InstanceBranding): AdminBrandingView {
  return {
    ...toPublicView(branding),
    storedInstanceName: branding.instanceName,
    updatedAt: branding.updatedAt.toISOString(),
  }
}

export function createBrandingRoutes(context: AppContext): readonly Route[] {
  const { branding, storage, logger } = context

  /** Session, second factor and system admin in one step, as for every admin route. */
  const adminOnly = async (
    request: Parameters<Route['handle']>[0]['request'],
    response: Parameters<Route['handle']>[0]['response'],
    mutating: boolean,
  ) => {
    const auth = await requireSession(context, request, response)
    if (auth === null) {
      return null
    }
    if (mutating && !requireCsrfToken(context, request, response, asRequester(auth))) {
      return null
    }
    return requireSystemAdmin(context, response, auth) ? auth : null
  }

  return [
    {
      method: 'GET',
      path: BRANDING_PATH,
      handle: async ({ response }) => {
        const body: PublicBrandingResponse = toPublicView(await branding.get())
        sendJson(response, 200, body)
      },
    },

    {
      method: 'GET',
      path: BRANDING_LOGO_PATH,
      handle: async ({ response, url }) => {
        const current = await branding.get()
        if (current.logo === null) {
          sendError(response, 404, 'Kein Logo gesetzt')
          return
        }
        const bytes = await storage.get(current.logo.key)
        if (bytes === null) {
          logger('error', 'branding.logo.missing', { key: current.logo.key })
          sendError(response, 500, 'Das Logo fehlt im Speicher')
          return
        }
        // Only a request that names the current version may be cached for long: the version is part of the
        // key, so the bytes behind it never change.
        const versioned = url.searchParams.get(BRANDING_LOGO_VERSION_PARAM) === logoVersionOf(current)
        response.setHeader('x-content-type-options', 'nosniff')
        sendBytes(response, bytes, {
          contentType: current.logo.type,
          cacheControl: versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
        })
      },
    },

    {
      method: 'GET',
      path: ADMIN_BRANDING_PATH,
      handle: async ({ request, response }) => {
        if ((await adminOnly(request, response, false)) === null) {
          return
        }
        sendJson(response, 200, toAdminView(await branding.get()))
      },
    },

    {
      method: 'POST',
      path: ADMIN_BRANDING_PATH,
      handle: async ({ request, response }) => {
        const auth = await adminOnly(request, response, true)
        if (auth === null) {
          return
        }
        const body = await readJsonBody(request)
        const instanceName = normalizeInstanceName(body?.['instanceName'])
        const accentValue = body?.['accent']
        const accent = parseAccentColor(accentValue)
        if (instanceName === null || (accentValue !== null && accent === null)) {
          sendError(
            response,
            400,
            `Ein Name mit hoechstens ${String(MAX_INSTANCE_NAME_LENGTH)} Zeichen und eine bekannte Akzentfarbe oder keine werden erwartet`,
          )
          return
        }
        const saved = await branding.saveSettings({
          instanceName,
          accent,
          actorId: auth.user.id,
          now: context.now(),
        })
        logger('info', 'branding.settings.changed', {
          actorId: auth.user.id,
          instanceName: saved.instanceName,
          accent: saved.accent,
        })
        sendJson(response, 200, toAdminView(saved))
      },
    },

    {
      method: 'POST',
      path: ADMIN_BRANDING_LOGO_PATH,
      handle: async ({ request, response }) => {
        const auth = await adminOnly(request, response, true)
        if (auth === null) {
          return
        }
        // The limit applies while reading, so an oversized body is never buffered whole.
        const body = await readBinaryBodyLimited(request, MAX_BRANDING_LOGO_BYTES)
        if (!body.ok) {
          if (body.reason === 'too-large') {
            sendError(response, 413, 'Das Logo ist zu gross (hoechstens 512 KB)')
          } else if (body.reason === 'aborted') {
            sendError(response, 400, 'Der Transfer wurde abgebrochen')
          } else {
            sendError(response, 400, 'Es wurden keine Bilddaten gesendet')
          }
          return
        }
        // The type comes from the content, never from the header or a file name.
        const type = sniffLogoType(body.bytes)
        if (type === null) {
          sendError(response, 415, 'Nur PNG, JPEG und WebP sind als Logo erlaubt')
          return
        }
        const key = buildLogoKey(createHash('sha256').update(body.bytes).digest('hex'))
        const before = await branding.get()
        await storage.put(key, body.bytes)
        let result
        try {
          result = await branding.setLogo({ key, type }, { actorId: auth.user.id, now: context.now() })
        } catch (error) {
          if (before.logo?.key !== key) {
            await storage.delete(key).catch(() => undefined)
          }
          throw error
        }
        await deleteReplaced(result.previousKey, key)
        logger('info', 'branding.logo.changed', { actorId: auth.user.id, type, byteSize: body.bytes.length })
        sendJson(response, 200, toAdminView(result.branding))
      },
    },

    {
      method: 'POST',
      path: ADMIN_BRANDING_LOGO_REMOVE_PATH,
      handle: async ({ request, response }) => {
        const auth = await adminOnly(request, response, true)
        if (auth === null) {
          return
        }
        const result = await branding.setLogo(null, { actorId: auth.user.id, now: context.now() })
        await deleteReplaced(result.previousKey, null)
        logger('info', 'branding.logo.removed', { actorId: auth.user.id })
        sendJson(response, 200, toAdminView(result.branding))
      },
    },
  ]

  /** The record already points elsewhere; a failed delete only leaves an unreferenced file, which is logged. */
  async function deleteReplaced(previousKey: string | null, newKey: string | null): Promise<void> {
    if (previousKey === null || previousKey === newKey) {
      return
    }
    try {
      await storage.delete(previousKey)
    } catch (error) {
      logger('error', 'branding.logo.orphan', { key: previousKey, error: describeError(error) })
    }
  }
}
