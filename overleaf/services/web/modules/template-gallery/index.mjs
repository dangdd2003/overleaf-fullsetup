import Settings from '@overleaf/settings'
import './app/src/ModuleSettings.mjs'
import TemplateGalleryRouter from './app/src/TemplateGalleryRouter.mjs'
import Lifecycle from './app/src/Lifecycle.mjs'
import UserDeletion from './app/src/hooks/UserDeletion.mjs'

export const GALLERY_NAV_URL = '/latex/templates'

// Mirrors overleaf.com's top-level item:
// li.subdued > a.nav-link.subdued[href=/latex/templates] "Templates"
const HEADER_NAV_ITEM = Object.freeze({
  text: 'templates',
  url: GALLERY_NAV_URL,
  class: 'subdued',
  trackingKey: 'templates',
})

const PRICING_URL = '/user/subscription/plans'

export function isEnabled() {
  return Settings.enableTemplateGallery === true
}

// overleaf.com orders the navbar Solutions, Templates, Pricing, Help, so the
// item goes in front of an admin-configured Pricing or Help entry if present.
function isPricingOrHelpItem(item) {
  return (
    item?.url === PRICING_URL ||
    item?.text === 'help_and_resources' ||
    item?.trackingKey === 'help'
  )
}

/**
 * Idempotently adds the top-level "Templates" link to Settings.nav.header_extras.
 * That array feeds both the pug marketing navbar and the React `ol-navbar`
 * items and is cloned per request, so installing it once at boot is enough.
 */
export function installHeaderNavigation(nav = Settings.nav) {
  if (!nav) return
  if (!Array.isArray(nav.header_extras)) {
    nav.header_extras = []
  }
  const extras = nav.header_extras
  if (extras.some(item => item?.url === GALLERY_NAV_URL)) return

  const index = extras.findIndex(isPricingOrHelpItem)
  extras.splice(index === -1 ? extras.length : index, 0, {
    ...HEADER_NAV_ITEM,
  })
}

const TemplateGalleryModule = {
  name: 'template-gallery',
  router: {
    apply(webRouter) {
      if (!isEnabled()) return
      // Navigation must not wait for Lifecycle readiness (storage/index checks
      // run after listen), so install it while routes are being registered.
      installHeaderNavigation()
      Lifecycle.installNavigation()
      TemplateGalleryRouter.apply(webRouter)
    },
  },
  async start() {
    if (!isEnabled()) return
    await Lifecycle.start()
  },
  hooks: {
    promises: {
      async deleteUser(userId) {
        if (!isEnabled()) return
        await UserDeletion.onUserRemoved(userId)
      },
      async expireDeletedUser(userId) {
        if (!isEnabled()) return
        await UserDeletion.onUserRemoved(userId)
      },
    },
  },
}

export default TemplateGalleryModule
