// overleaf/services/web/modules/template-gallery/app/src/ModuleSettings.mjs
import Settings from '@overleaf/settings'
import { DEFAULTS, parseFetchRpm } from './TemplateGalleryDefaults.mjs'

// Two env vars:
//   TEMPLATE_GALLERY_ENABLED=true     the feature gate, off by default
//   TEMPLATE_GALLERY_FETCH_RPM=n   requests a minute to overleaf.com per
//                                     outbound route (1-120, default 30); an
//                                     invalid value falls back to the default
export function applyModuleSettings(env = process.env) {
  if (Settings.enableTemplateGallery === undefined) {
    Settings.enableTemplateGallery = env.TEMPLATE_GALLERY_ENABLED === 'true'
  }
  if (Settings.templateGalleryFetchRpm === undefined) {
    Settings.templateGalleryFetchRpm =
      parseFetchRpm(env.TEMPLATE_GALLERY_FETCH_RPM) ??
      DEFAULTS.outbound.fetchRpm
  }
  return Settings
}

// Call at module load
applyModuleSettings()

export default {
  applyModuleSettings,
}
