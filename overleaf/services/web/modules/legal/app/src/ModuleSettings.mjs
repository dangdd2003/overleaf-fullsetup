import Settings from '@overleaf/settings'

if (Settings.enableLegalPage === undefined) {
  Settings.enableLegalPage = process.env.LEGAL_PAGE_ENABLED === 'true'
}

// Instance admins can override these in settings.js under `legalPage`
Settings.legalPage = {
  lastModified: '19 October 2026',
  sourceUrl: 'https://github.com/dangdd2003/overleaf-fullsetup',
  ...Settings.legalPage,
}

export default Settings
