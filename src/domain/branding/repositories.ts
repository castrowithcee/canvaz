/** Persistence port for the single instance branding row. */

import type { AccentColor } from '../../contracts/api.js'
import type { BrandingLogoType, InstanceBranding } from './model.js'

export interface BrandingStore {
  get(): Promise<InstanceBranding>
  saveSettings(settings: {
    readonly instanceName: string
    readonly accent: AccentColor | null
    readonly actorId: string
    readonly now: Date
  }): Promise<InstanceBranding>
  /** Sets or (with `null`) removes the logo and returns the key it replaced, to be deleted by the caller. */
  setLogo(
    logo: { readonly key: string; readonly type: BrandingLogoType } | null,
    actor: { readonly actorId: string; readonly now: Date },
  ): Promise<{ readonly branding: InstanceBranding; readonly previousKey: string | null }>
}
