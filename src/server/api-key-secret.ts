/** Generating and hashing key values. 256 random bits need no rate limit; only the SHA-256 hash is stored. */

import { randomBytes } from 'node:crypto'

import { API_KEY_RANDOM_BYTES, API_KEY_VALUE_PREFIX } from '../domain/identity/api-key.js'
import { hashSessionToken } from './session.js'

export function createApiKeyValue(): string {
  return `${API_KEY_VALUE_PREFIX}${randomBytes(API_KEY_RANDOM_BYTES).toString('base64url')}`
}

export function hashApiKeyValue(value: string): string {
  return hashSessionToken(value)
}
