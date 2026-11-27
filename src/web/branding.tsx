/**
 * Public instance branding in the browser: loaded once per page load, shared by every view.
 *
 * Without branding (or if loading fails) the views keep the built-in name "Canvaz", no logo and the default
 * accent, so nothing changes for an instance that maintains none.
 */

import { useEffect, useSyncExternalStore } from 'react'

import type { PublicBrandingResponse } from '../contracts/api.js'
import { brandingLogoUrl, fetchPublicBranding } from './api.js'
import { applyInstanceAccent } from './appearance.js'

const DEFAULT_NAME = 'Canvaz'

let current: PublicBrandingResponse | null = null
let started = false
const listeners = new Set<() => void>()

function load(): void {
  if (started) {
    return
  }
  started = true
  fetchPublicBranding()
    .then((branding) => {
      current = branding
      document.title = branding.instanceName
      for (const listener of listeners) {
        listener()
      }
    })
    .catch(() => {
      // Branding is cosmetic: the built-in look stays.
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The public branding, or `null` until it has loaded (or if it could not be loaded). */
export function useBranding(): PublicBrandingResponse | null {
  useEffect(load, [])
  return useSyncExternalStore(subscribe, () => current)
}

/** The instance accent for token pages without a session check (invitation, recovery, ...). */
export function useAnonymousAppearance(): void {
  const accent = useBranding()?.accent ?? null
  useEffect(() => {
    applyInstanceAccent(accent)
  }, [accent])
}

/** Logo and instance name; the name is the alternative text of the logo. */
export function BrandMark() {
  const branding = useBranding()
  const name = branding?.instanceName ?? DEFAULT_NAME
  return (
    <span className="brand">
      {branding?.logoVersion != null && (
        <img className="brand__logo" src={brandingLogoUrl(branding.logoVersion)} alt={name} />
      )}
      <span>{name}</span>
    </span>
  )
}

/** The page heading of views without the sidebar. */
export function BrandHeading() {
  return (
    <h1>
      <BrandMark />
    </h1>
  )
}
