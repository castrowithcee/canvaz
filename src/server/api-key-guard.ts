/**
 * Authentication of the automation API. Only `Authorization: Bearer <key>` counts here, and no other route
 * reads that header: the session cookie never authenticates on `/api/v1`, and a key never on an internal
 * route or a realtime connection. CSRF does not apply because the browser never attaches the header on its
 * own.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ResolvedApiKey } from '../domain/identity/api-key.js'
import { isApiKeyValueWellFormed } from '../domain/identity/api-key.js'
import { hashApiKeyValue } from './api-key-secret.js'
import type { AppContext } from './context.js'
import { sendApiV1Error } from './http.js'
import { createRateLimiter } from './rate-limit.js'

export type ApiKeyGuard = (request: IncomingMessage, response: ServerResponse) => Promise<ResolvedApiKey | null>

const BEARER = /^Bearer ([^\s]+)$/i
const LAST_USED_RESOLUTION_MS = 60_000

export function createApiKeyGuard(context: AppContext): ApiKeyGuard {
  const perMinute = context.config.apiKeyRateLimitPerMinute
  const limiter = createRateLimiter({ perMinute, now: () => context.now().getTime() })
  // One token refills after this many seconds.
  const retryAfter = String(Math.max(1, Math.ceil(60 / perMinute)))

  return async (request, response) => {
    const now = context.now()
    const value = BEARER.exec(request.headers.authorization ?? '')?.[1]
    const resolved =
      value !== undefined && isApiKeyValueWellFormed(value)
        ? await context.identity.apiKeys.resolveByHash(hashApiKeyValue(value), now)
        : null
    if (resolved === null) {
      // Missing, unknown, expired, revoked, access off and inactive user must look identical from outside.
      context.logger('warn', 'api-key.rejected', { path: new URL(request.url ?? '/', 'http://localhost').pathname })
      response.setHeader('www-authenticate', 'Bearer')
      sendApiV1Error(response, 401, 'unauthorized', 'Kein gueltiger API-Key')
      return null
    }
    if (!limiter.take(resolved.key.id)) {
      context.logger('warn', 'api-key.rate.exceeded', { apiKeyId: resolved.key.id })
      response.setHeader('retry-after', retryAfter)
      sendApiV1Error(response, 429, 'rate_limited', 'Zu viele Anfragen fuer diesen API-Key')
      return null
    }
    const lastUsed = resolved.key.lastUsedAt
    if (lastUsed === null || now.getTime() - lastUsed.getTime() >= LAST_USED_RESOLUTION_MS) {
      await context.identity.apiKeys.markUsed(resolved.key.id, now)
    }
    return resolved
  }
}
