import Path from 'node:path'
import Settings from '@overleaf/settings'

const PLACEHOLDER_EMAIL = 'placeholder@example.com'

function getPageOptions() {
  return {
    title: 'Privacy & Terms',
    lastModified: Settings.legalPage.lastModified,
    appName: Settings.appName || Settings.nav?.title || 'Overleaf',
    contactEmail:
      Settings.adminEmail && Settings.adminEmail !== PLACEHOLDER_EMAIL
        ? Settings.adminEmail
        : '',
    sourceUrl: Settings.legalPage.sourceUrl,
  }
}

const LegalController = {
  renderPage(req, res) {
    res.render(
      Path.resolve(import.meta.dirname, '../views/legal'),
      getPageOptions()
    )
  },
}

export default LegalController
