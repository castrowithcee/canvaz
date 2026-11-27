/**
 * Instance branding: name, default accent and logo of the whole instance.
 *
 * Pure rules without IO. The logo bytes are not part of the model, only their storage key and type.
 */

import type { AccentColor } from '../../contracts/api.js'
import { MAX_INSTANCE_NAME_LENGTH } from '../../contracts/api.js'
import { assertStorageKey } from '../storage/asset-storage-port.js'
import type { AllowedImageType } from '../storage/image-type.js'
import { sniffImageType } from '../storage/image-type.js'

export const DEFAULT_INSTANCE_NAME = 'Canvaz'

/** GIF is recognized by `sniffImageType` but not accepted for a logo. */
export type BrandingLogoType = Exclude<AllowedImageType, 'image/gif'>

export type InstanceBranding = {
  /** Empty means: show `DEFAULT_INSTANCE_NAME`. */
  readonly instanceName: string
  /** `null` means: the existing default accent. */
  readonly accent: AccentColor | null
  readonly logo: { readonly key: string; readonly type: BrandingLogoType } | null
  readonly updatedAt: Date
}

/** Trimmed name, or `null` when it is longer than the limit. Empty is valid and means the default. */
export function normalizeInstanceName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const name = value.trim()
  return name.length <= MAX_INSTANCE_NAME_LENGTH ? name : null
}

export function effectiveInstanceName(branding: InstanceBranding): string {
  return branding.instanceName === '' ? DEFAULT_INSTANCE_NAME : branding.instanceName
}

/** The type of the bytes by content, or `null` when it is not PNG, JPEG or WebP. */
export function sniffLogoType(bytes: Uint8Array): BrandingLogoType | null {
  const type = sniffImageType(bytes)
  return type === 'image/png' || type === 'image/jpeg' || type === 'image/webp' ? type : null
}

const LOGO_KEY_PREFIX = 'branding/logo-'

/** Content-addressed: a replaced logo gets a new key, so a changed logo is never served from a cache. */
export function buildLogoKey(checksumSha256: string): string {
  return assertStorageKey(`${LOGO_KEY_PREFIX}${checksumSha256.slice(0, 32)}`)
}

/** The version clients put in the logo URL. It changes exactly when the logo does. */
export function logoVersionOf(branding: InstanceBranding): string | null {
  return branding.logo === null ? null : branding.logo.key.slice(LOGO_KEY_PREFIX.length)
}
