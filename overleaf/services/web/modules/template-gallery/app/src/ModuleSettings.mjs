// overleaf/services/web/modules/template-gallery/app/src/ModuleSettings.mjs
import Settings from '@overleaf/settings'
import { DEFAULTS, mergePlain } from './TemplateGalleryDefaults.mjs'

export function applyModuleSettings(env = process.env) {
  if (Settings.enableTemplateGallery === undefined) {
    Settings.enableTemplateGallery = env.TEMPLATE_GALLERY_ENABLED === 'true'
  }
  if (Settings.enableTemplateGallery) {
    Settings.templateGallery = mergePlain(
      DEFAULTS,
      Settings.templateGallery || {}
    )
  }
  return Settings
}

// Call at module load
applyModuleSettings()

export default {
  applyModuleSettings,
}
